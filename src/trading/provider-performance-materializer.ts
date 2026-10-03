import type { SqlExecutor } from "../storage/schema.js";
import { executeMeasuredSql } from "../storage/schema.js";
import type { ProviderLifecycleHistory, ProviderEvidenceOrigin } from "./provider-lifecycle-reconciliation.js";
import type { ProviderPerformanceLifecycle, ProviderPerformanceTotals } from "./provider-performance.js";
import { addDecimal, compareDecimal, isDecimal, subtractDecimal } from "./decimal.js";
import type { ProviderPositionHistoryCursor, ProviderPositionHistoryPage } from "../storage/provider-ledger.js";
import { loadProviderPositionHistoriesPage } from "../storage/provider-ledger.js";

export const PROVIDER_PERFORMANCE_MATERIALIZATION_VERSION = 1;
export const PROVIDER_PERFORMANCE_MIGRATION_PAGE_SIZE = 20;
export const PROVIDER_PERFORMANCE_CHANGE_BATCH_SIZE = 20;
const PROVIDER_PERFORMANCE_CHANGE_WINDOW_CAP = 20;
const PROVIDER_PERFORMANCE_STATE_KEY = "provider_lifecycle_performance_materialized_v1";
const PROVIDER_PERFORMANCE_TIME_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const PROVIDER_PERFORMANCE_HISTORY_TOLERANCE_MS = 5 * 60 * 1000;

export type ProviderPerformanceMaterializationPhase = "SCAN" | "DRAIN" | "READY" | "RECONCILIATION_REQUIRED";

export interface ProviderPerformanceMaterializationState {
  version: number;
  generation: string;
  phase: ProviderPerformanceMaterializationPhase;
  cursor: ProviderPositionHistoryCursor | null;
  queueCursor: number;
  scannedHistories: number;
  lifecycleRevision: number | null;
  identityRevision: number | null;
  realizedPnlAccumulator: string;
  totals: ProviderPerformanceTotals;
  errorCode?: string;
}

export interface ProviderPerformanceLifecycleRow {
  historyKey: string;
  category: string;
  history: ProviderLifecycleHistory;
}

export interface ProviderPerformanceRevisions {
  lifecycleRevision: number;
  identityRevision: number;
}

export interface ProviderPerformanceChange {
  changeId: number;
  source: "history" | "order" | "fill" | "identity";
  category: string | null;
  historyKey: string | null;
  symbol: string | null;
  positionSide: string | null;
  eventTime: string | null;
  providerOrderId: string | null;
  clientOid: string | null;
}

export class ProviderPerformanceMaterializationError extends Error {
  public constructor(readonly code: string) {
    super(code);
  }
}

type TransactionSync = <T>(closure: () => T) => T;
type ResolveRows = (rows: readonly ProviderPerformanceLifecycleRow[], path: string) => ReadonlyMap<string, ProviderPerformanceLifecycle | null>;
type ReadRevisions = () => ProviderPerformanceRevisions;

function emptyTotals(): ProviderPerformanceTotals {
  return {
    source: "PROVIDER_LEDGER",
    closedTrades: 0,
    openTrades: 0,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    closedEpisodeRealizedPnl: "0",
    verifiedRealizedPnl: "0",
    unresolvedClosedLifecycles: 0,
    dailyPnl: {},
  };
}

export function loadProviderPerformanceMaterializationState(executor: SqlExecutor): ProviderPerformanceMaterializationState | null {
  const rows = executor.sql<{ payload: string }>`SELECT payload FROM risk_state WHERE state_key = ${PROVIDER_PERFORMANCE_STATE_KEY} LIMIT 1`;
  if (!rows[0]) return null;
  try {
    const value = JSON.parse(rows[0].payload) as ProviderPerformanceMaterializationState;
    if (value.version !== PROVIDER_PERFORMANCE_MATERIALIZATION_VERSION || !value.generation || !Number.isInteger(value.queueCursor)
      || !["SCAN", "DRAIN", "READY", "RECONCILIATION_REQUIRED"].includes(value.phase) || !value.totals) return null;
    return value;
  } catch {
    return null;
  }
}

function saveState(executor: SqlExecutor, state: ProviderPerformanceMaterializationState, updatedAt: string): void {
  executor.sql`
    INSERT INTO risk_state (state_key, payload, updated_at)
    VALUES (${PROVIDER_PERFORMANCE_STATE_KEY}, ${JSON.stringify(state)}, ${updatedAt})
    ON CONFLICT(state_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `;
}

export function markProviderPerformanceReconciliationRequired(executor: SqlExecutor, code: string, updatedAt: string): void {
  const current = loadProviderPerformanceMaterializationState(executor);
  if (!current) return;
  saveState(executor, { ...current, phase: "RECONCILIATION_REQUIRED", errorCode: code }, updatedAt);
}

function newGeneration(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function startProviderPerformanceMigration(
  executor: SqlExecutor,
  transactionSync: TransactionSync,
  updatedAt: string,
): ProviderPerformanceMaterializationState {
  return transactionSync(() => {
    const current = loadProviderPerformanceMaterializationState(executor);
    if (current && current.phase !== "RECONCILIATION_REQUIRED") return current;
    const watermark = executor.sql<{ change_id: number }>`SELECT COALESCE(MAX(change_id), 0) AS change_id FROM provider_performance_change_queue`[0]?.change_id ?? 0;
    const state: ProviderPerformanceMaterializationState = {
      version: PROVIDER_PERFORMANCE_MATERIALIZATION_VERSION,
      generation: newGeneration(),
      phase: "SCAN",
      cursor: null,
      queueCursor: Number(watermark),
      scannedHistories: 0,
      lifecycleRevision: null,
      identityRevision: null,
      realizedPnlAccumulator: "0",
      totals: emptyTotals(),
    };
    saveState(executor, state, updatedAt);
    return state;
  });
}

function addCount(value: number, delta: number): number {
  const result = value + delta;
  if (!Number.isInteger(result) || result < 0) throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_AGGREGATE_UNDERFLOW");
  return result;
}

function updateTotals(
  totals: ProviderPerformanceTotals,
  realizedPnlAccumulator: string,
  lifecycle: ProviderPerformanceLifecycle,
  direction: 1 | -1,
): { totals: ProviderPerformanceTotals; realizedPnlAccumulator: string } {
  if (lifecycle.origin !== "DARWIN" || lifecycle.status !== "CLOSED") return { totals, realizedPnlAccumulator };
  const next: ProviderPerformanceTotals = { ...totals, dailyPnl: { ...totals.dailyPnl } };
  next.closedTrades = addCount(next.closedTrades, direction);
  next.totalTrades = addCount(next.totalTrades, direction);
  let nextAccumulator = realizedPnlAccumulator;
  if (!isDecimal(lifecycle.netProfit)) {
    next.unresolvedClosedLifecycles = addCount(next.unresolvedClosedLifecycles, direction);
  } else {
    const signed = direction === 1 ? lifecycle.netProfit : subtractDecimal("0", lifecycle.netProfit);
    nextAccumulator = addDecimal(nextAccumulator, signed);
    const comparison = compareDecimal(lifecycle.netProfit, "0");
    if (comparison > 0) next.wins = addCount(next.wins, direction);
    else if (comparison < 0) next.losses = addCount(next.losses, direction);
    else next.breakeven = addCount(next.breakeven, direction);
    const day = lifecycle.closedAt && Number.isFinite(Date.parse(lifecycle.closedAt)) ? lifecycle.closedAt.slice(0, 10) : null;
    if (day) {
      const current = next.dailyPnl[day] ?? { pnl: "0", trades: 0 };
      const daily = { pnl: addDecimal(current.pnl, signed), trades: addCount(current.trades, direction) };
      if (daily.trades === 0) delete next.dailyPnl[day];
      else next.dailyPnl[day] = daily;
    }
  }
  if (next.unresolvedClosedLifecycles > 0) {
    next.closedEpisodeRealizedPnl = "UNAVAILABLE";
    next.verifiedRealizedPnl = "UNAVAILABLE";
  } else {
    next.closedEpisodeRealizedPnl = nextAccumulator;
    next.verifiedRealizedPnl = nextAccumulator;
  }
  return { totals: next, realizedPnlAccumulator: nextAccumulator };
}

function lifecycleJson(lifecycle: ProviderPerformanceLifecycle): string {
  return JSON.stringify({
    lifecycleId: lifecycle.lifecycleId,
    origin: lifecycle.origin,
    status: lifecycle.status,
    ...(lifecycle.netProfit === undefined ? {} : { netProfit: lifecycle.netProfit }),
    ...(lifecycle.closedAt === undefined ? {} : { closedAt: lifecycle.closedAt }),
  });
}

function applyHistoryLifecycle(
  executor: SqlExecutor,
  state: ProviderPerformanceMaterializationState,
  historyKey: string,
  category: string,
  lifecycle: ProviderPerformanceLifecycle | null,
): ProviderPerformanceMaterializationState {
  const normalized = lifecycle?.lifecycleId && lifecycle.status === "CLOSED" ? lifecycle : null;
  const membership = executor.sql<{ category: string; lifecycle_id: string }>`
    SELECT category, lifecycle_id FROM provider_performance_generation_members
    WHERE generation = ${state.generation} AND history_key = ${historyKey} LIMIT 1
  `[0];
  if (membership && normalized?.lifecycleId === membership.lifecycle_id && category === membership.category) {
    const group = executor.sql<{ payload: string; member_count: number }>`SELECT payload, member_count FROM provider_performance_generation_groups WHERE generation = ${state.generation} AND category = ${category} AND lifecycle_id = ${membership.lifecycle_id} LIMIT 1`[0];
    if (!group) throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_CONTRIBUTION_MISSING");
    if (group.payload === lifecycleJson(normalized)) return state;
    if (group.member_count > 1) throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_DUPLICATE_LIFECYCLE_CONTRADICTION");
  }

  let totals = state.totals;
  let realizedPnlAccumulator = state.realizedPnlAccumulator;
  if (membership) {
    const oldGroup = executor.sql<{ payload: string; member_count: number }>`
      SELECT payload, member_count FROM provider_performance_generation_groups
      WHERE generation = ${state.generation} AND category = ${membership.category} AND lifecycle_id = ${membership.lifecycle_id} LIMIT 1
    `[0];
    if (!oldGroup || oldGroup.member_count < 1) throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_CONTRIBUTION_MISSING");
    if (oldGroup.member_count === 1) {
      const update = updateTotals(totals, realizedPnlAccumulator, JSON.parse(oldGroup.payload) as ProviderPerformanceLifecycle, -1);
      totals = update.totals;
      realizedPnlAccumulator = update.realizedPnlAccumulator;
      executor.sql`DELETE FROM provider_performance_generation_groups WHERE generation = ${state.generation} AND category = ${membership.category} AND lifecycle_id = ${membership.lifecycle_id}`;
    } else {
      executor.sql`UPDATE provider_performance_generation_groups SET member_count = member_count - 1 WHERE generation = ${state.generation} AND category = ${membership.category} AND lifecycle_id = ${membership.lifecycle_id}`;
    }
    executor.sql`DELETE FROM provider_performance_generation_members WHERE generation = ${state.generation} AND history_key = ${historyKey}`;
  }

  if (!normalized) return { ...state, totals, realizedPnlAccumulator };
  const encoded = lifecycleJson(normalized);
  const group = executor.sql<{ payload: string; member_count: number }>`
    SELECT payload, member_count FROM provider_performance_generation_groups
    WHERE generation = ${state.generation} AND category = ${category} AND lifecycle_id = ${normalized.lifecycleId} LIMIT 1
  `[0];
  if (group && group.payload !== encoded) throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_DUPLICATE_LIFECYCLE_CONTRADICTION");
  if (group) {
    executor.sql`UPDATE provider_performance_generation_groups SET member_count = member_count + 1 WHERE generation = ${state.generation} AND category = ${category} AND lifecycle_id = ${normalized.lifecycleId}`;
  } else {
    executor.sql`INSERT INTO provider_performance_generation_groups (generation, category, lifecycle_id, payload, member_count) VALUES (${state.generation}, ${category}, ${normalized.lifecycleId}, ${encoded}, 1)`;
    const update = updateTotals(totals, realizedPnlAccumulator, normalized, 1);
    totals = update.totals;
    realizedPnlAccumulator = update.realizedPnlAccumulator;
  }
  executor.sql`INSERT INTO provider_performance_generation_members (generation, history_key, category, lifecycle_id) VALUES (${state.generation}, ${historyKey}, ${category}, ${normalized.lifecycleId})`;
  return { ...state, totals, realizedPnlAccumulator };
}

interface QueueRow extends ProviderPerformanceChange {
  source: ProviderPerformanceChange["source"];
}

function loadChanges(executor: SqlExecutor, after: number, path: string): ProviderPerformanceChange[] {
  return executeMeasuredSql<QueueRow>(executor, path, "lifecycle_performance_pending_changes")`
    SELECT change_id AS changeId, source, category, history_key AS historyKey, symbol, position_side AS positionSide,
      event_time AS eventTime, provider_order_id AS providerOrderId, client_oid AS clientOid
    FROM provider_performance_change_queue WHERE change_id > ${after} ORDER BY change_id LIMIT ${PROVIDER_PERFORMANCE_CHANGE_BATCH_SIZE + 1}
  `;
}

function positionHistoryKeysForEvent(executor: SqlExecutor, event: ProviderPerformanceChange, category: string, path: string): string[] {
  if (event.source === "history") return event.category === category && event.historyKey ? [event.historyKey] : [];
  const coordinates: Array<{ symbol: string; eventTime: string }> = [];
  if (event.source === "order" || event.source === "fill") {
    if (event.category === category && event.symbol && event.eventTime) coordinates.push({ symbol: event.symbol, eventTime: event.eventTime });
  } else {
    const orderRows = event.providerOrderId
      ? executeMeasuredSql<{ category: string; symbol: string; created_time: string }>(executor, path, "lifecycle_performance_identity_order_lookup")`
        SELECT category, symbol, created_time FROM provider_orders WHERE provider_order_id = ${event.providerOrderId} LIMIT 2
      `
      : [];
    const clientRows = event.clientOid
      ? executeMeasuredSql<{ category: string; symbol: string; created_time: string }>(executor, path, "lifecycle_performance_identity_client_lookup")`
        SELECT category, symbol, created_time FROM provider_orders WHERE category = ${category} AND client_oid = ${event.clientOid} LIMIT 2
      `
      : [];
    if (orderRows.length > 1 || clientRows.length > 1) throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_IDENTITY_LOOKUP_AMBIGUOUS");
    for (const row of [...orderRows, ...clientRows]) {
      if (row.category === category) coordinates.push({ symbol: row.symbol, eventTime: row.created_time });
    }
  }

  const keys = new Set<string>();
  for (const coordinate of coordinates) {
    const timestamp = Date.parse(coordinate.eventTime);
    if (!Number.isFinite(timestamp)) throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_CHANGE_WINDOW_INVALID");
    const from = new Date(timestamp - PROVIDER_PERFORMANCE_HISTORY_TOLERANCE_MS).toISOString();
    const to = new Date(timestamp + PROVIDER_PERFORMANCE_HISTORY_TOLERANCE_MS).toISOString();
    const openRows = executeMeasuredSql<{ provider_position_history_key: string }>(executor, path, "lifecycle_performance_open_window")`
      SELECT provider_position_history_key FROM provider_position_history
      WHERE category = ${category} AND symbol = ${coordinate.symbol} AND opening_time >= ${from} AND opening_time <= ${to}
      ORDER BY opening_time, provider_position_history_key LIMIT ${PROVIDER_PERFORMANCE_CHANGE_WINDOW_CAP + 1}
    `;
    const end = new Date(timestamp + PROVIDER_PERFORMANCE_TIME_WINDOW_MS).toISOString();
    const closedRows = executeMeasuredSql<{ provider_position_history_key: string }>(executor, path, "lifecycle_performance_close_window")`
      SELECT provider_position_history_key FROM provider_position_history
      WHERE category = ${category} AND symbol = ${coordinate.symbol} AND closing_time >= ${coordinate.eventTime} AND closing_time <= ${end}
      ORDER BY closing_time, provider_position_history_key LIMIT ${PROVIDER_PERFORMANCE_CHANGE_WINDOW_CAP + 1}
    `;
    if (openRows.length > PROVIDER_PERFORMANCE_CHANGE_WINDOW_CAP || closedRows.length > PROVIDER_PERFORMANCE_CHANGE_WINDOW_CAP) {
      throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_CHANGE_WINDOW_CAP_EXCEEDED");
    }
    for (const row of [...openRows, ...closedRows]) keys.add(row.provider_position_history_key);
    if (keys.size > PROVIDER_PERFORMANCE_CHANGE_WINDOW_CAP) throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_CHANGE_WINDOW_CAP_EXCEEDED");
  }
  return [...keys];
}

function drainChangeBatch(
  executor: SqlExecutor,
  state: ProviderPerformanceMaterializationState,
  category: string,
  path: string,
  resolveRows: ResolveRows,
): { state: ProviderPerformanceMaterializationState; hasMore: boolean; processedChanges: boolean } {
  const changes = loadChanges(executor, state.queueCursor, path);
  if (changes.length === 0) return { state, hasMore: false, processedChanges: false };
  const batch = changes.slice(0, PROVIDER_PERFORMANCE_CHANGE_BATCH_SIZE);
  const historyKeys = new Set<string>();
  for (const event of batch) for (const key of positionHistoryKeysForEvent(executor, event, category, path)) historyKeys.add(key);
  if (historyKeys.size > PROVIDER_PERFORMANCE_CHANGE_WINDOW_CAP) throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_CHANGE_WINDOW_CAP_EXCEEDED");
  const orderedKeys = [...historyKeys];
  const currentRows = loadProviderPerformanceRowsByKeys(executor, orderedKeys, path);
  const histories = currentRows.filter((row) => row.category === category);
  const resolved = resolveRows(histories, path);
  let next = state;
  for (const key of orderedKeys) {
    const row = currentRows.find((candidate) => candidate.historyKey === key);
    const lifecycle = row?.category === category ? resolved.get(key) ?? null : null;
    next = applyHistoryLifecycle(executor, next, key, row?.category ?? category, lifecycle);
  }
  const processed = batch.map((change) => change.changeId);
  executor.sql`DELETE FROM provider_performance_change_queue WHERE change_id IN (SELECT value FROM json_each(${JSON.stringify(processed)}))`;
  next = { ...next, queueCursor: processed[processed.length - 1]! };
  return { state: next, hasMore: changes.length > batch.length, processedChanges: true };
}

function loadProviderPerformanceRowsByKeys(executor: SqlExecutor, historyKeys: readonly string[], path: string): ProviderPerformanceLifecycleRow[] {
  if (historyKeys.length === 0) return [];
  const requested = [...new Set(historyKeys)].slice(0, PROVIDER_PERFORMANCE_CHANGE_WINDOW_CAP);
  const loaded = executeMeasuredSql<{
    provider_position_history_key: string; category: string; provider_position_history_id: string | null; symbol: string; position_side: string;
    open_total_pos: string | null; close_total_pos: string | null; avg_entry_price: string | null; avg_exit_price: string | null;
    cum_realised_pnl: string | null; net_profit: string | null; open_fee_total: string | null; close_fee_total: string | null;
    total_funding: string | null; cash_dividend: string | null; opening_time: string; closing_time: string; origin: ProviderEvidenceOrigin;
  }>(executor, path, "lifecycle_performance_targeted_history")`
    SELECT provider_position_history_key, category, provider_position_history_id, symbol, position_side,
      open_total_pos, close_total_pos, avg_entry_price, avg_exit_price, cum_realised_pnl, net_profit,
      open_fee_total, close_fee_total, total_funding, cash_dividend, opening_time, closing_time, origin
    FROM provider_position_history
    WHERE provider_position_history_key IN (SELECT value FROM json_each(${JSON.stringify(requested)}))
    LIMIT ${requested.length + 1}
  `;
  if (loaded.length > requested.length) throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_HISTORY_KEY_CAP_EXCEEDED");
  return loaded.map((row) => ({
    historyKey: row.provider_position_history_key,
    category: row.category,
    history: {
      providerPositionHistoryId: row.provider_position_history_id,
      symbol: row.symbol,
      positionSide: row.position_side,
      openTotalPos: row.open_total_pos,
      closeTotalPos: row.close_total_pos,
      avgEntryPrice: row.avg_entry_price,
      avgExitPrice: row.avg_exit_price,
      cumRealisedPnl: row.cum_realised_pnl,
      netProfit: row.net_profit,
      openFeeTotal: row.open_fee_total,
      closeFeeTotal: row.close_fee_total,
      totalFunding: row.total_funding,
      cashDividend: row.cash_dividend,
      openingTime: row.opening_time,
      closingTime: row.closing_time,
      origin: row.origin,
    },
  }));
}

function finishOrCheckPending(
  executor: SqlExecutor,
  state: ProviderPerformanceMaterializationState,
  updatedAt: string,
  readRevisions: ReadRevisions,
  hasMore: boolean,
  processedChanges: boolean,
): ProviderPerformanceMaterializationState {
  if (hasMore) {
    const next = { ...state, phase: state.phase === "DRAIN" ? "DRAIN" as const : "READY" as const };
    saveState(executor, next, updatedAt);
    return next;
  }
  const revisions = readRevisions();
  if (!processedChanges && state.phase === "READY") {
    if (state.lifecycleRevision !== revisions.lifecycleRevision || state.identityRevision !== revisions.identityRevision) {
      throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_CHANGE_QUEUE_GAP");
    }
    return state;
  }
  const { errorCode: _errorCode, ...withoutError } = state;
  const ready: ProviderPerformanceMaterializationState = {
    ...withoutError,
    phase: "READY",
    lifecycleRevision: revisions.lifecycleRevision,
    identityRevision: revisions.identityRevision,
  };
  saveState(executor, ready, updatedAt);
  return ready;
}

export function resolveProviderPerformanceMaterializedTotals(
  executor: SqlExecutor,
  transactionSync: TransactionSync,
  category: string,
  updatedAt: string,
  readRevisions: ReadRevisions,
  resolveRows: ResolveRows,
): ProviderPerformanceTotals {
  const state = loadProviderPerformanceMaterializationState(executor);
  if (!state) throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_MIGRATION_REQUIRED");
  if (state.phase === "SCAN" || state.phase === "DRAIN") throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_MIGRATION_REQUIRED");
  if (state.phase === "RECONCILIATION_REQUIRED") throw new ProviderPerformanceMaterializationError(state.errorCode ?? "PROVIDER_PERFORMANCE_RECONCILIATION_REQUIRED");
  try {
    const result = transactionSync(() => {
      const batch = drainChangeBatch(executor, state, category, "/api/snapshot", resolveRows);
      const ready = finishOrCheckPending(executor, batch.state, updatedAt, readRevisions, batch.hasMore, batch.processedChanges);
      return { totals: ready.totals, pending: batch.hasMore };
    });
    if (result.pending) throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_SYNC_PENDING");
    return result.totals;
  } catch (error) {
    if (error instanceof ProviderPerformanceMaterializationError && error.code !== "PROVIDER_PERFORMANCE_SYNC_PENDING") {
      markProviderPerformanceReconciliationRequired(executor, error.code, updatedAt);
    }
    throw error;
  }
}

export function runProviderPerformanceMigrationBatch(
  executor: SqlExecutor,
  transactionSync: TransactionSync,
  category: string,
  updatedAt: string,
  readRevisions: ReadRevisions,
  resolveRows: ResolveRows,
): ProviderPerformanceMaterializationState {
  const state = startProviderPerformanceMigration(executor, transactionSync, updatedAt);
  if (state.phase === "READY") return state;
  if (state.phase === "RECONCILIATION_REQUIRED") throw new ProviderPerformanceMaterializationError(state.errorCode ?? "PROVIDER_PERFORMANCE_RECONCILIATION_REQUIRED");
  try {
    return transactionSync(() => {
      const current = loadProviderPerformanceMaterializationState(executor);
      if (!current || current.generation !== state.generation) throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_MIGRATION_STATE_CHANGED");
      if (current.phase === "SCAN") {
        const page: ProviderPositionHistoryPage = loadProviderPositionHistoriesPage(executor, category, current.cursor, PROVIDER_PERFORMANCE_MIGRATION_PAGE_SIZE, "/api/provider-performance/rebuild");
        const rows = page.histories.map((history, index) => ({ historyKey: page.historyKeys[index]!, category, history }));
        const resolved = resolveRows(rows, "/api/provider-performance/rebuild");
        let next = current;
        for (const row of rows) next = applyHistoryLifecycle(executor, next, row.historyKey, row.category, resolved.get(row.historyKey) ?? null);
        const scanning: ProviderPerformanceMaterializationState = {
          ...next,
          cursor: page.nextCursor,
          scannedHistories: current.scannedHistories + rows.length,
          phase: page.hasMore ? "SCAN" : "DRAIN",
        };
        saveState(executor, scanning, updatedAt);
        return scanning;
      }

      const batch = drainChangeBatch(executor, current, category, "/api/provider-performance/rebuild", resolveRows);
      const complete = finishOrCheckPending(executor, batch.state, updatedAt, readRevisions, batch.hasMore, batch.processedChanges);
      return complete;
    });
  } catch (error) {
    if (error instanceof ProviderPerformanceMaterializationError) markProviderPerformanceReconciliationRequired(executor, error.code, updatedAt);
    throw error;
  }
}

export function providerPerformanceMigrationProgress(state: ProviderPerformanceMaterializationState): {
  complete: boolean;
  phase: ProviderPerformanceMaterializationPhase;
  scannedHistories: number;
  cursor: ProviderPositionHistoryCursor | null;
  errorCode?: string;
} {
  return {
    complete: state.phase === "READY",
    phase: state.phase,
    scannedHistories: state.scannedHistories,
    cursor: state.cursor,
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
  };
}
