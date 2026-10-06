import type { PositionSnapshot, ProviderExecutionFact, TradeExperience } from "../types.js";
import type { ProviderLifecycleEvidence, ProviderLifecycleFill, ProviderLifecycleHistory, ProviderLifecycleOrder, ProviderLifecyclePosition, ProviderLifecycleCandidateFill, ProviderLifecycleCandidateOrder, ProviderEvidenceOrigin } from "../trading/provider-lifecycle-reconciliation.js";
import type {
  ProviderFillRecord,
  ProviderFinancialRecord,
  ProviderOrigin,
  ProviderOrderRecord,
  ProviderPositionHistoryRecord,
} from "../bitget/provider-ledger.js";
import { executeMeasuredSql, type SqlExecutor } from "./schema.js";
import { isProviderLifecycleTimestampNear, PROVIDER_LIFECYCLE_TIME_TOLERANCE_MS, resolveProviderLifecycleSide } from "../trading/provider-lifecycle-side.js";

export const MAX_PROVIDER_HISTORY_MS = 90 * 24 * 60 * 60 * 1000;

export interface ProviderResourceCheckpoint {
  cursor?: string;
  windowStart: string;
  windowEnd: string;
}

export interface ProviderSyncCheckpoints {
  historyOrders?: ProviderResourceCheckpoint;
  fills?: ProviderResourceCheckpoint;
  positionHistory?: ProviderResourceCheckpoint;
  financialRecords?: ProviderResourceCheckpoint;
}

export interface ProviderSyncState {
  category: string;
  checkpoints: ProviderSyncCheckpoints;
  lastSuccessfulSyncAt: string | null;
  lastReconciliationAt: string | null;
  lastError: string | null;
  updatedAt: string;
  revision?: number;
  financialRecordCoverage?: { coveredFrom: string; coveredThrough: string; lastSuccessfulSyncAt: string | null; lastError: string | null } | null;
}

export interface ProviderLedgerDiagnostics {
  category: string;
  counts: {
    orders: number;
    fills: number;
    positionHistory: number;
    financialRecords: number;
  };
  origins: {
    DARWIN: number;
    PROVIDER_EXTERNAL: number;
    UNATTRIBUTED: number;
  };
  sync: ProviderSyncState | null;
  lastPartialOrFailureReason: string | null;
}

interface CountRow {
  count: number;
}

interface OriginCountRow {
  category: string;
  origin: ProviderOrigin;
  count: number;
}

interface SyncStateRow {
  category: string;
  checkpoint_json: string;
  last_successful_sync_at: string | null;
  last_reconciliation_at: string | null;
  last_error: string | null;
  updated_at: string;
  revision: number;
}

interface ProviderDataRevisionRow {
  category: string;
  lifecycle_revision: number;
  financial_revision: number;
  identity_revision: number;
}

export class ProviderLifecycleIdentityLookupError extends Error {
  public constructor(readonly code: string) {
    super(code);
  }
}

export interface ProviderDataRevisions {
  lifecycleRevision: number;
  financialRevision: number;
  identityRevision: number;
}

export function loadProviderDataRevisions(executor: SqlExecutor, categories: readonly string[]): Map<string, ProviderDataRevisions> {
  const requested = [...new Set(categories)].slice(0, 100);
  if (requested.length === 0) return new Map();
  const rows = executor.sql<ProviderDataRevisionRow>`
    SELECT requested.value AS category,
      COALESCE(data.lifecycle_revision, 0) AS lifecycle_revision,
      COALESCE(data.financial_revision, 0) AS financial_revision,
      COALESCE(identity.revision, 0) AS identity_revision
    FROM json_each(${JSON.stringify(requested)}) AS requested
    LEFT JOIN provider_data_revisions AS data ON data.category = requested.value
    LEFT JOIN provider_identity_revision AS identity ON identity.revision_key = 1
  `;
  if (rows.length !== requested.length) throw new Error("PROVIDER_DATA_REVISION_UNAVAILABLE");
  return new Map(rows.map((row) => [row.category, {
    lifecycleRevision: Number(row.lifecycle_revision),
    financialRevision: Number(row.financial_revision),
    identityRevision: Number(row.identity_revision),
  }]));
}

export type ProviderOriginReadQueryName =
  | "provider_sync_origin_client_oid_lookup"
  | "provider_sync_origin_provider_order_lookup"
  | "provider_sync_origin_fallback_lookup";
export type ProviderOriginReadObserver = (queryName: ProviderOriginReadQueryName, rowsRead: number) => void;

export function resolveProviderOrigin(
  executor: SqlExecutor,
  providerOrderId: string | null,
  clientOid: string | null,
  fallback: ProviderOrigin = "UNATTRIBUTED",
  path = "scheduled_provider_sync",
  onRowsRead?: ProviderOriginReadObserver,
): ProviderOrigin {
  if (clientOid) {
    const queryName = "provider_sync_origin_client_oid_lookup";
    const idempotency = executeMeasuredSql<{ client_order_id: string }>(executor, path, queryName, onRowsRead ? (rowsRead) => onRowsRead(queryName, rowsRead) : undefined)`SELECT client_order_id FROM idempotency WHERE client_order_id = ${clientOid} LIMIT 1`;
    if (idempotency.length > 0) return "DARWIN";
  }
  if (providerOrderId) {
    const queryName = "provider_sync_origin_provider_order_lookup";
    const idempotency = executeMeasuredSql<{ provider_order_id: string }>(executor, path, queryName, onRowsRead ? (rowsRead) => onRowsRead(queryName, rowsRead) : undefined)`SELECT provider_order_id FROM idempotency WHERE provider_order_id = ${providerOrderId} LIMIT 1`;
    if (idempotency.length > 0) return "DARWIN";
    const fallbackQueryName = "provider_sync_origin_fallback_lookup";
    const existing = executeMeasuredSql<{ origin: ProviderOrigin }>(executor, path, fallbackQueryName, onRowsRead ? (rowsRead) => onRowsRead(fallbackQueryName, rowsRead) : undefined)`SELECT origin FROM provider_orders WHERE provider_order_id = ${providerOrderId} LIMIT 1`;
    if (existing[0]?.origin) return existing[0].origin;
  }
  return fallback;
}

export function upsertProviderOrder(executor: SqlExecutor, record: ProviderOrderRecord, observedAt: string): void {
  executor.sql`
    INSERT INTO provider_orders (
      provider_order_id, client_oid, category, symbol, side, pos_side, trade_side,
      reduce_only, order_type, qty, cum_exec_qty, cum_exec_value, avg_price,
      order_status, fee_total, fee_details_json, created_time, updated_time,
      origin, raw_provider_json, first_seen_at, last_seen_at
    ) VALUES (
      ${record.providerOrderId}, ${record.clientOid}, ${record.category}, ${record.symbol}, ${record.side}, ${record.posSide}, ${record.tradeSide},
      ${record.reduceOnly}, ${record.orderType}, ${record.qty}, ${record.cumExecQty}, ${record.cumExecValue}, ${record.avgPrice},
      ${record.orderStatus}, ${record.feeTotal}, ${record.feeDetailsJson}, ${record.createdTime}, ${record.updatedTime},
      ${record.origin}, ${record.rawProviderJson}, ${observedAt}, ${observedAt}
    )
    ON CONFLICT(provider_order_id) DO UPDATE SET
      client_oid = excluded.client_oid,
      category = excluded.category,
      symbol = excluded.symbol,
      side = excluded.side,
      pos_side = excluded.pos_side,
      trade_side = excluded.trade_side,
      reduce_only = excluded.reduce_only,
      order_type = excluded.order_type,
      qty = excluded.qty,
      cum_exec_qty = excluded.cum_exec_qty,
      cum_exec_value = excluded.cum_exec_value,
      avg_price = excluded.avg_price,
      order_status = excluded.order_status,
      fee_total = excluded.fee_total,
      fee_details_json = excluded.fee_details_json,
      created_time = excluded.created_time,
      updated_time = excluded.updated_time,
      origin = excluded.origin,
      raw_provider_json = excluded.raw_provider_json,
      last_seen_at = excluded.last_seen_at
  `;
}

export function upsertProviderFill(executor: SqlExecutor, record: ProviderFillRecord, observedAt: string): void {
  executor.sql`
    INSERT INTO provider_fills (
      exec_id, provider_order_id, client_oid, category, symbol, side, pos_side,
      trade_side, exec_qty, exec_price, exec_value, exec_pnl, fee_total,
      fee_details_json, created_time, updated_time, origin, raw_provider_json,
      first_seen_at, last_seen_at
    ) VALUES (
      ${record.execId}, ${record.providerOrderId}, ${record.clientOid}, ${record.category}, ${record.symbol}, ${record.side}, ${record.posSide},
      ${record.tradeSide}, ${record.execQty}, ${record.execPrice}, ${record.execValue}, ${record.execPnl}, ${record.feeTotal},
      ${record.feeDetailsJson}, ${record.createdTime}, ${record.updatedTime}, ${record.origin}, ${record.rawProviderJson},
      ${observedAt}, ${observedAt}
    )
    ON CONFLICT(exec_id) DO UPDATE SET
      provider_order_id = excluded.provider_order_id,
      client_oid = excluded.client_oid,
      category = excluded.category,
      symbol = excluded.symbol,
      side = excluded.side,
      pos_side = excluded.pos_side,
      trade_side = excluded.trade_side,
      exec_qty = excluded.exec_qty,
      exec_price = excluded.exec_price,
      exec_value = excluded.exec_value,
      exec_pnl = excluded.exec_pnl,
      fee_total = excluded.fee_total,
      fee_details_json = excluded.fee_details_json,
      created_time = excluded.created_time,
      updated_time = excluded.updated_time,
      origin = excluded.origin,
      raw_provider_json = excluded.raw_provider_json,
      last_seen_at = excluded.last_seen_at
  `;
}

export function upsertProviderPositionHistory(executor: SqlExecutor, record: ProviderPositionHistoryRecord, observedAt: string): void {
  executor.sql`
    INSERT INTO provider_position_history (
      provider_position_history_key, provider_position_history_id, category, symbol,
      position_side, opening_time, closing_time, avg_entry_price, avg_exit_price,
      open_total_pos, close_total_pos, cum_realised_pnl, net_profit,
      closing_quantity, max_position_size, closing_value, max_position_value,
      position_pnl, position_roi, open_fee_total, close_fee_total, total_funding,
      cash_dividend, origin, raw_provider_json, first_seen_at, last_seen_at
    ) VALUES (
      ${record.providerPositionHistoryKey}, ${record.providerPositionHistoryId}, ${record.category}, ${record.symbol},
      ${record.positionSide}, ${record.openingTime}, ${record.closingTime}, ${record.avgEntryPrice}, ${record.avgExitPrice},
      ${record.openTotalPos}, ${record.closeTotalPos}, ${record.cumRealisedPnl}, ${record.netProfit},
      ${record.closingQuantity}, ${record.maxPositionSize}, ${record.closingValue}, ${record.maxPositionValue},
      ${record.positionPnl}, ${record.positionRoi}, ${record.openFeeTotal}, ${record.closeFeeTotal}, ${record.totalFunding},
      ${record.cashDividend}, ${record.origin}, ${record.rawProviderJson}, ${observedAt}, ${observedAt}
    )
    ON CONFLICT(provider_position_history_key) DO UPDATE SET
      provider_position_history_id = excluded.provider_position_history_id,
      category = excluded.category,
      symbol = excluded.symbol,
      position_side = excluded.position_side,
      opening_time = excluded.opening_time,
      closing_time = excluded.closing_time,
      avg_entry_price = excluded.avg_entry_price,
      avg_exit_price = excluded.avg_exit_price,
      open_total_pos = excluded.open_total_pos,
      close_total_pos = excluded.close_total_pos,
      cum_realised_pnl = excluded.cum_realised_pnl,
      net_profit = excluded.net_profit,
      closing_quantity = excluded.closing_quantity,
      max_position_size = excluded.max_position_size,
      closing_value = excluded.closing_value,
      max_position_value = excluded.max_position_value,
      position_pnl = excluded.position_pnl,
      position_roi = excluded.position_roi,
      open_fee_total = excluded.open_fee_total,
      close_fee_total = excluded.close_fee_total,
      total_funding = excluded.total_funding,
      cash_dividend = excluded.cash_dividend,
      origin = excluded.origin,
      raw_provider_json = excluded.raw_provider_json,
      last_seen_at = excluded.last_seen_at
  `;
}

export function upsertProviderFinancialRecord(executor: SqlExecutor, record: ProviderFinancialRecord, observedAt: string): void {
  executor.sql`
    INSERT INTO provider_financial_records (
      provider_record_key, provider_record_id, category, symbol, type, position_type, coin, amount,
      fee, position_amount, position_balance, balance, provider_timestamp,
      origin, raw_provider_json, first_seen_at, last_seen_at
    ) VALUES (
      ${record.providerRecordKey}, ${record.providerRecordId}, ${record.category}, ${record.symbol}, ${record.type}, ${record.positionType}, ${record.coin}, ${record.amount},
      ${record.fee}, ${record.positionAmount}, ${record.positionBalance}, ${record.balance}, ${record.providerTimestamp},
      ${record.origin}, ${record.rawProviderJson}, ${observedAt}, ${observedAt}
    )
    ON CONFLICT(provider_record_key) DO UPDATE SET
      provider_record_id = excluded.provider_record_id,
      category = excluded.category,
      symbol = excluded.symbol,
      type = excluded.type,
      position_type = excluded.position_type,
      coin = excluded.coin,
      amount = excluded.amount,
      fee = excluded.fee,
      position_amount = excluded.position_amount,
      position_balance = excluded.position_balance,
      balance = excluded.balance,
      provider_timestamp = excluded.provider_timestamp,
      origin = excluded.origin,
      raw_provider_json = excluded.raw_provider_json,
      last_seen_at = excluded.last_seen_at
  `;
}

interface ProviderPositionHistoryRow {
  provider_position_history_key: string;
  provider_position_history_id: string | null;
  symbol: string;
  position_side: string;
  open_total_pos: string | null;
  close_total_pos: string | null;
  avg_entry_price: string | null;
  avg_exit_price: string | null;
  cum_realised_pnl: string | null;
  net_profit: string | null;
  open_fee_total: string | null;
  close_fee_total: string | null;
  total_funding: string | null;
  cash_dividend: string | null;
  opening_time: string;
  closing_time: string;
  origin: ProviderEvidenceOrigin;
}

function mapProviderPositionHistoryRow(row: ProviderPositionHistoryRow): ProviderLifecycleHistory {
  return {
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
  };
}

export interface ProviderPositionHistoryCursor {
  openingTime: string;
  providerPositionHistoryKey: string;
}

export interface ProviderPositionHistoryPage {
  histories: ProviderLifecycleHistory[];
  historyKeys: string[];
  nextCursor: ProviderPositionHistoryCursor | null;
  hasMore: boolean;
}

export function loadProviderPositionHistories(executor: SqlExecutor, category: string, limit = 100): ProviderLifecycleHistory[] {
  const historyLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 100;
  const rows = executor.sql<ProviderPositionHistoryRow>`SELECT provider_position_history_key, provider_position_history_id, symbol, position_side, open_total_pos, close_total_pos, avg_entry_price, avg_exit_price, cum_realised_pnl, net_profit, open_fee_total, close_fee_total, total_funding, cash_dividend, opening_time, closing_time, origin FROM provider_position_history WHERE category = ${category} ORDER BY opening_time DESC, provider_position_history_key DESC LIMIT ${historyLimit}`;
  return rows.map(mapProviderPositionHistoryRow);
}

export function loadRecentProviderPositionHistories(executor: SqlExecutor, category: string, limit = 25, path = "/api/trade-history"): ProviderLifecycleHistory[] {
  const historyLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 25;
  const rows = executeMeasuredSql<ProviderPositionHistoryRow>(executor, path, "trade_history_lifecycle_page")`
    SELECT provider_position_history_key, provider_position_history_id, symbol, position_side, open_total_pos, close_total_pos,
      avg_entry_price, avg_exit_price, cum_realised_pnl, net_profit, open_fee_total, close_fee_total, total_funding,
      cash_dividend, opening_time, closing_time, origin
    FROM provider_position_history
    WHERE category = ${category}
    ORDER BY closing_time DESC, provider_position_history_key DESC
    LIMIT ${historyLimit}
  `;
  return rows.map(mapProviderPositionHistoryRow);
}

export function loadProviderPositionHistoriesPage(
  executor: SqlExecutor,
  category: string,
  cursor: ProviderPositionHistoryCursor | null,
  limit = 100,
  path = "/api/snapshot",
): ProviderPositionHistoryPage {
  const pageLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 100;
  const rows = cursor
    ? executeMeasuredSql<ProviderPositionHistoryRow>(executor, path, "lifecycle_performance_history_page")`
      SELECT provider_position_history_key, provider_position_history_id, symbol, position_side, open_total_pos, close_total_pos, avg_entry_price, avg_exit_price, cum_realised_pnl, net_profit, open_fee_total, close_fee_total, total_funding, cash_dividend, opening_time, closing_time, origin
      FROM provider_position_history
      WHERE category = ${category}
        AND (opening_time, provider_position_history_key) > (${cursor.openingTime}, ${cursor.providerPositionHistoryKey})
      ORDER BY opening_time, provider_position_history_key
      LIMIT ${pageLimit + 1}
    `
    : executeMeasuredSql<ProviderPositionHistoryRow>(executor, path, "lifecycle_performance_history_page")`
      SELECT provider_position_history_key, provider_position_history_id, symbol, position_side, open_total_pos, close_total_pos, avg_entry_price, avg_exit_price, cum_realised_pnl, net_profit, open_fee_total, close_fee_total, total_funding, cash_dividend, opening_time, closing_time, origin
      FROM provider_position_history WHERE category = ${category}
      ORDER BY opening_time, provider_position_history_key LIMIT ${pageLimit + 1}
    `;
  const hasMore = rows.length > pageLimit;
  const pageRows = rows.slice(0, pageLimit);
  const lastRow = pageRows[pageRows.length - 1];
  return {
    histories: pageRows.map(mapProviderPositionHistoryRow),
    historyKeys: pageRows.map((row) => row.provider_position_history_key),
    nextCursor: hasMore && lastRow ? { openingTime: lastRow.opening_time, providerPositionHistoryKey: lastRow.provider_position_history_key } : null,
    hasMore,
  };
}

export function loadProviderPositionHistoryDecisionIds(
  executor: SqlExecutor,
  category: string,
  histories: readonly ProviderLifecycleHistory[],
  path = "/api/snapshot",
): Map<string, string> {
  const requestsById = new Map<string, { id: string; symbol: string; positionSide: string; openingTime: string; from: string; to: string }>();
  const ambiguousIds = new Set<string>();
  for (const history of histories) {
    const id = history.providerPositionHistoryId;
    const openingMs = Date.parse(history.openingTime);
    if (!id || !Number.isFinite(openingMs) || (history.positionSide !== "LONG" && history.positionSide !== "SHORT")) continue;
    const request = {
      id,
      symbol: history.symbol,
      positionSide: history.positionSide,
      openingTime: history.openingTime,
      from: new Date(openingMs - PROVIDER_LIFECYCLE_TIME_TOLERANCE_MS).toISOString(),
      to: new Date(openingMs + PROVIDER_LIFECYCLE_TIME_TOLERANCE_MS).toISOString(),
    };
    const existing = requestsById.get(id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(request)) ambiguousIds.add(id);
    else requestsById.set(id, request);
  }
  const requests = [...requestsById.values()].filter((request) => !ambiguousIds.has(request.id));
  const identitiesByHistory = new Map<string, Map<string, boolean>>();
  const batchSize = 100;
  const maxRowsPerBatch = 5_000;
  for (let offset = 0; offset < requests.length; offset += batchSize) {
    const batch = requests.slice(offset, offset + batchSize);
    const rows = executeMeasuredSql<{
      history_id: string; decision_id: string; provider_order_id: string; client_oid: string;
      order_side: string | null; order_pos_side: string | null; order_trade_side: string | null; order_origin: ProviderEvidenceOrigin;
      fill_side: string | null; fill_pos_side: string | null; fill_trade_side: string | null;
      fill_origin: ProviderEvidenceOrigin;
    }>(executor, path, "lifecycle_performance_history_identity_batch")`
      SELECT DISTINCT h.provider_position_history_id AS history_id, i.decision_id, o.provider_order_id, o.client_oid,
        o.side AS order_side, o.pos_side AS order_pos_side, o.trade_side AS order_trade_side, o.origin AS order_origin,
        f.side AS fill_side, f.pos_side AS fill_pos_side, f.trade_side AS fill_trade_side, f.origin AS fill_origin
      FROM json_each(${JSON.stringify(batch)}) AS requested
      CROSS JOIN provider_position_history AS h INDEXED BY provider_position_history_category_symbol_opening_idx ON h.category = ${category}
        AND h.provider_position_history_id = json_extract(requested.value, '$.id')
        AND h.symbol = json_extract(requested.value, '$.symbol')
        AND UPPER(h.position_side) = UPPER(json_extract(requested.value, '$.positionSide'))
        AND h.opening_time = json_extract(requested.value, '$.openingTime')
      CROSS JOIN provider_fills AS f INDEXED BY provider_fills_lifecycle_window_idx ON f.category = h.category AND f.symbol = h.symbol
        AND UPPER(f.pos_side) = UPPER(h.position_side)
        AND f.created_time >= json_extract(requested.value, '$.from')
        AND f.created_time <= json_extract(requested.value, '$.to')
        AND ABS((julianday(f.created_time) - julianday(h.opening_time)) * 86400.0) <= ${PROVIDER_LIFECYCLE_TIME_TOLERANCE_MS / 1_000}
      JOIN provider_orders AS o ON o.category = f.category AND o.provider_order_id = f.provider_order_id
        AND o.client_oid = f.client_oid AND o.symbol = f.symbol
        AND UPPER(o.pos_side) = UPPER(f.pos_side) AND o.origin = f.origin
      JOIN idempotency AS i ON i.client_order_id = f.client_oid
        AND i.client_order_id <> '' AND i.client_order_id = TRIM(i.client_order_id)
        AND ((i.provider_order_id IS NOT NULL AND i.provider_order_id <> '' AND i.provider_order_id = TRIM(i.provider_order_id) AND i.provider_order_id = f.provider_order_id)
          OR ((i.provider_order_id IS NULL)
            AND (SELECT COUNT(DISTINCT candidate.provider_order_id) FROM provider_orders AS candidate
              WHERE candidate.client_oid = i.client_order_id) = 1))
      WHERE h.category = ${category} AND h.provider_position_history_id IS NOT NULL
      LIMIT ${maxRowsPerBatch + 1}
    `;
    if (rows.length > maxRowsPerBatch) throw new ProviderLifecycleIdentityLookupError("PROVIDER_LIFECYCLE_IDENTITY_LOOKUP_CAP_EXCEEDED");
    for (const row of rows) {
      const candidate = JSON.stringify([row.decision_id, row.provider_order_id, row.client_oid, row.order_origin, row.fill_origin]);
      const identities = identitiesByHistory.get(row.history_id) ?? new Map<string, boolean>();
      const openDarwinIdentity = row.order_origin === "DARWIN" && row.fill_origin === "DARWIN"
        && resolveProviderLifecycleSide(row.order_side, row.order_pos_side, row.order_trade_side) === "OPEN"
        && resolveProviderLifecycleSide(row.fill_side, row.fill_pos_side, row.fill_trade_side) === "OPEN";
      identities.set(candidate, identities.has(candidate) ? identities.get(candidate)! && openDarwinIdentity : openDarwinIdentity);
      identitiesByHistory.set(row.history_id, identities);
    }
  }
  const result = new Map<string, string>();
  for (const [historyId, candidates] of identitiesByHistory) {
    if (candidates.size !== 1) continue;
    const [identity, valid] = [...candidates][0]!;
    if (!valid) continue;
    const decisionId = JSON.parse(identity) as [string, string, string, ProviderEvidenceOrigin, ProviderEvidenceOrigin];
    result.set(historyId, decisionId[0]);
  }
  return result;
}

export function providerLivePositionLifecycleKey(position: Pick<PositionSnapshot, "symbol" | "positionSide" | "openedAt">): string {
  return JSON.stringify([position.symbol, position.positionSide, position.openedAt ?? ""]);
}

export function loadProviderLiveOpeningOrderIdentities(
  executor: SqlExecutor,
  category: string,
  positions: readonly PositionSnapshot[],
  path = "/api/snapshot",
): Map<string, { providerOrderId: string; decisionId: string }> {
  const requests = [...new Map(positions.flatMap((position) => {
    const openedAtMs = position.openedAt ? Date.parse(position.openedAt) : Number.NaN;
    if (!position.openedAt || !Number.isFinite(openedAtMs)) return [];
    const key = providerLivePositionLifecycleKey(position);
    return [[key, {
      key,
      symbol: position.symbol,
      positionSide: position.positionSide,
      openedAt: position.openedAt,
      from: new Date(openedAtMs - PROVIDER_LIFECYCLE_TIME_TOLERANCE_MS).toISOString(),
      to: new Date(openedAtMs + PROVIDER_LIFECYCLE_TIME_TOLERANCE_MS).toISOString(),
    }]] as const;
  })).values()];
  const candidatesByPosition = new Map<string, Map<string, boolean>>();
  const batchSize = 100;
  const maxRowsPerBatch = 5_000;
  for (let offset = 0; offset < requests.length; offset += batchSize) {
    const batch = requests.slice(offset, offset + batchSize);
    const rows = executeMeasuredSql<{
      position_key: string; provider_order_id: string; client_oid: string; decision_id: string;
      order_side: string | null; order_pos_side: string | null; order_trade_side: string | null; order_origin: ProviderEvidenceOrigin;
      fill_side: string | null; fill_pos_side: string | null; fill_trade_side: string | null; fill_origin: ProviderEvidenceOrigin;
    }>(executor, path, "lifecycle_live_position_identity_batch")`
      SELECT DISTINCT json_extract(requested.value, '$.key') AS position_key, o.provider_order_id, o.client_oid, i.decision_id,
        o.side AS order_side, o.pos_side AS order_pos_side, o.trade_side AS order_trade_side, o.origin AS order_origin,
        f.side AS fill_side, f.pos_side AS fill_pos_side, f.trade_side AS fill_trade_side, f.origin AS fill_origin
      FROM json_each(${JSON.stringify(batch)}) AS requested
      CROSS JOIN provider_fills AS f INDEXED BY provider_fills_lifecycle_window_idx ON f.category = ${category} AND f.symbol = json_extract(requested.value, '$.symbol')
        AND f.created_time >= json_extract(requested.value, '$.from')
        AND f.created_time <= json_extract(requested.value, '$.to')
        AND ABS((julianday(f.created_time) - julianday(json_extract(requested.value, '$.openedAt'))) * 86400.0) <= ${PROVIDER_LIFECYCLE_TIME_TOLERANCE_MS / 1_000}
      CROSS JOIN provider_orders AS o INDEXED BY sqlite_autoindex_provider_orders_1 ON o.provider_order_id = f.provider_order_id
        AND o.category = f.category AND o.client_oid = f.client_oid AND o.symbol = f.symbol
        AND UPPER(o.pos_side) = UPPER(f.pos_side) AND o.origin = f.origin
      JOIN idempotency AS i ON i.client_order_id = o.client_oid
        AND i.client_order_id <> '' AND i.client_order_id = TRIM(i.client_order_id)
        AND ((i.provider_order_id IS NOT NULL AND i.provider_order_id <> '' AND i.provider_order_id = TRIM(i.provider_order_id) AND i.provider_order_id = o.provider_order_id)
          OR ((i.provider_order_id IS NULL)
            AND (SELECT COUNT(DISTINCT candidate.provider_order_id) FROM provider_orders AS candidate
              WHERE candidate.client_oid = i.client_order_id) = 1))
      LIMIT ${maxRowsPerBatch + 1}
    `;
    if (rows.length > maxRowsPerBatch) continue;
    for (const row of rows) {
      const identity = JSON.stringify([row.provider_order_id, row.client_oid, row.decision_id, row.order_origin, row.fill_origin]);
      const candidates = candidatesByPosition.get(row.position_key) ?? new Map<string, boolean>();
      const openDarwinIdentity = row.order_origin === "DARWIN" && row.fill_origin === "DARWIN"
        && resolveProviderLifecycleSide(row.order_side, row.order_pos_side, row.order_trade_side) === "OPEN"
        && resolveProviderLifecycleSide(row.fill_side, row.fill_pos_side, row.fill_trade_side) === "OPEN";
      candidates.set(identity, candidates.has(identity) ? candidates.get(identity)! && openDarwinIdentity : openDarwinIdentity);
      candidatesByPosition.set(row.position_key, candidates);
    }
  }
  const identities = new Map<string, { providerOrderId: string; decisionId: string }>();
  for (const [positionKey, candidates] of candidatesByPosition) {
    if (candidates.size !== 1) continue;
    const [identity, valid] = [...candidates][0]!;
    if (!valid) continue;
    const [providerOrderId, , decisionId] = JSON.parse(identity) as [string, string, string, ProviderEvidenceOrigin, ProviderEvidenceOrigin];
    identities.set(positionKey, { providerOrderId, decisionId });
  }
  return identities;
}

export function loadProviderLifecycleHistoryCandidateIds(executor: SqlExecutor, experience: TradeExperience, category: string): Set<string> {
  const rows = executor.sql<{
    provider_position_history_id: string;
    provider_order_id: string;
    client_oid: string;
    order_side: string | null; order_pos_side: string | null; order_trade_side: string | null; order_origin: ProviderEvidenceOrigin;
    fill_side: string | null; fill_pos_side: string | null; fill_trade_side: string | null; fill_origin: ProviderEvidenceOrigin;
  }>`
    SELECT DISTINCT h.provider_position_history_id, o.provider_order_id, o.client_oid,
      o.side AS order_side, o.pos_side AS order_pos_side, o.trade_side AS order_trade_side, o.origin AS order_origin,
      f.side AS fill_side, f.pos_side AS fill_pos_side, f.trade_side AS fill_trade_side, f.origin AS fill_origin
    FROM provider_position_history h
    JOIN idempotency i ON i.decision_id = ${experience.entryDecisionId}
      AND i.client_order_id <> '' AND i.client_order_id = TRIM(i.client_order_id)
    JOIN provider_orders o ON o.category = h.category AND o.client_oid = i.client_order_id
      AND ((i.provider_order_id IS NOT NULL AND i.provider_order_id <> '' AND i.provider_order_id = TRIM(i.provider_order_id) AND o.provider_order_id = i.provider_order_id)
        OR ((i.provider_order_id IS NULL)
          AND (SELECT COUNT(DISTINCT candidate.provider_order_id) FROM provider_orders AS candidate
            WHERE candidate.client_oid = i.client_order_id) = 1))
    JOIN provider_fills f ON f.category = o.category AND f.provider_order_id = o.provider_order_id AND f.client_oid = o.client_oid
    WHERE h.category = ${category} AND h.provider_position_history_id IS NOT NULL
      AND h.symbol = ${experience.symbol} AND UPPER(h.position_side) = UPPER(${experience.positionSide?.toUpperCase() ?? ""})
      AND o.symbol = h.symbol AND UPPER(o.pos_side) = UPPER(h.position_side) AND o.origin = f.origin
      AND f.symbol = h.symbol AND UPPER(f.pos_side) = UPPER(h.position_side)
      AND f.created_time >= strftime('%Y-%m-%dT%H:%M:%fZ', h.opening_time, ${`-${PROVIDER_LIFECYCLE_TIME_TOLERANCE_MS / 1_000} seconds`})
      AND f.created_time <= strftime('%Y-%m-%dT%H:%M:%fZ', h.opening_time, ${`${PROVIDER_LIFECYCLE_TIME_TOLERANCE_MS / 1_000} seconds`})
      AND ABS((julianday(f.created_time) - julianday(h.opening_time)) * 86400.0) <= ${PROVIDER_LIFECYCLE_TIME_TOLERANCE_MS / 1_000}
    LIMIT 5001
  `;
  if (rows.length > 5_000) return new Set();
  const candidatesByHistory = new Map<string, Map<string, boolean>>();
  for (const row of rows) {
    const identity = JSON.stringify([row.provider_order_id, row.client_oid, row.order_origin, row.fill_origin]);
    const candidates = candidatesByHistory.get(row.provider_position_history_id) ?? new Map<string, boolean>();
    const openDarwinIdentity = row.order_origin === "DARWIN" && row.fill_origin === "DARWIN"
      && resolveProviderLifecycleSide(row.order_side, row.order_pos_side, row.order_trade_side) === "OPEN"
      && resolveProviderLifecycleSide(row.fill_side, row.fill_pos_side, row.fill_trade_side) === "OPEN";
    candidates.set(identity, candidates.has(identity) ? candidates.get(identity)! && openDarwinIdentity : openDarwinIdentity);
    candidatesByHistory.set(row.provider_position_history_id, candidates);
  }
  return new Set([...candidatesByHistory]
    .filter(([, candidates]) => candidates.size === 1 && [...candidates.values()][0] === true)
    .map(([historyId]) => historyId));
}

export interface ProviderLifecycleEvidenceRequest {
  requestId: string;
  experience: TradeExperience;
  history: ProviderLifecycleHistory | null;
  providerPosition?: ProviderLifecyclePosition | null;
}

const MAX_LIFECYCLE_EVIDENCE_ROWS = 2_000;

function parseLifecycleEvidenceRows<T>(json: string): T[] | null {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value as T[] : null;
  } catch {
    return null;
  }
}

function isCanonicalNonEmptyClientOrderId(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function isExactOptionalProviderOrderId(value: string | null | undefined): boolean {
  return value === null || (typeof value === "string" && value.length > 0 && value === value.trim());
}

export function loadProviderLifecycleEvidence(
  executor: SqlExecutor,
  experience: TradeExperience,
  category: string,
  providerPositionHistoryId: string,
  providerPositions: readonly ProviderLifecyclePosition[],
  deterministicEntryIdentity?: { entryDecisionId: string; clientOid: string },
  includeIdentityDiagnostics = false,
): ProviderLifecycleEvidence {
  const historyRows = executor.sql<{
    provider_position_history_id: string | null; symbol: string; position_side: string; open_total_pos: string | null; close_total_pos: string | null;
    avg_entry_price: string | null; avg_exit_price: string | null; cum_realised_pnl: string | null; net_profit: string | null;
    open_fee_total: string | null; close_fee_total: string | null; total_funding: string | null; cash_dividend: string | null;
    opening_time: string; closing_time: string; origin: ProviderEvidenceOrigin;
  }>`SELECT provider_position_history_id, symbol, position_side, open_total_pos, close_total_pos, avg_entry_price, avg_exit_price, cum_realised_pnl, net_profit, open_fee_total, close_fee_total, total_funding, cash_dividend, opening_time, closing_time, origin FROM provider_position_history WHERE provider_position_history_key = ${providerPositionHistoryId} AND category = ${category} LIMIT 1`;
  const row = historyRows[0];
  if (row && row.provider_position_history_id !== providerPositionHistoryId) {
    return { experience, providerPositions, history: null, entryIdentity: null, orders: [], fills: [], evidenceComplete: false };
  }

  const identities = executor.sql<{ client_order_id: string | null; provider_order_id: string | null }>`SELECT client_order_id, provider_order_id FROM idempotency WHERE decision_id = ${experience.entryDecisionId} LIMIT 2`;
  const identity = identities.length === 1 ? identities[0] : null;
  const rawClientOid = typeof identity?.client_order_id === "string" ? identity.client_order_id : "";
  const clientOid = rawClientOid.trim();
  const rawProviderOrderId = typeof identity?.provider_order_id === "string" ? identity.provider_order_id : "";
  const providerOrderId = rawProviderOrderId.trim();
  const canonicalClientOid = deterministicEntryIdentity?.entryDecisionId === experience.entryDecisionId
    && /^[A-Za-z0-9_-]{1,32}$/.test(deterministicEntryIdentity.clientOid)
    ? deterministicEntryIdentity.clientOid
    : null;
  const idempotencyIdentityDiagnostics = {
    idempotencyClientOidPresent: identity ? Boolean(clientOid) : null,
    idempotencyClientOidMatchesDeterministic: identity && canonicalClientOid ? rawClientOid === canonicalClientOid : null,
    idempotencyProviderOrderIdPresent: identity ? Boolean(providerOrderId) : null,
    idempotencyProviderOrderIdExact: identity ? Boolean(providerOrderId) && rawProviderOrderId === providerOrderId : null,
  };
  let entryIdentity = rawClientOid === clientOid && rawProviderOrderId === providerOrderId && clientOid && providerOrderId
    ? { entryDecisionId: experience.entryDecisionId, clientOid, providerOrderId }
    : null;
  let entryIdentitySource: ProviderLifecycleEvidence["entryIdentitySource"] = entryIdentity ? "IDEMPOTENCY" : null;
  const recoverableClientOid = identity && rawClientOid && rawClientOid === clientOid && identity.provider_order_id === null
    ? rawClientOid
    : identities.length === 0 ? canonicalClientOid : null;
  // Use a decision-linked idempotency client ID, or (only when no row exists) the deterministic context ID.
  // Both paths still require one matching DARWIN opening order; duplicate identities and existing mismatched IDs fail closed.
  const entryIdentityCandidateDiagnostics: Pick<ProviderLifecycleEvidence,
    | "entryIdentityCandidateLookupCount"
    | "entryIdentityCandidateProviderOrderIdPresent"
    | "entryIdentityCandidateSymbolMatch"
    | "entryIdentityCandidatePositionSideMatch"
    | "entryIdentityCandidateTradeSideOpen"
    | "entryIdentityCandidateDarwinOrigin"
    | "entryIdentityCandidateOpeningTimeMatch"
  > = {
    entryIdentityCandidateLookupCount: null,
    entryIdentityCandidateProviderOrderIdPresent: null,
    entryIdentityCandidateSymbolMatch: null,
    entryIdentityCandidatePositionSideMatch: null,
    entryIdentityCandidateTradeSideOpen: null,
    entryIdentityCandidateDarwinOrigin: null,
    entryIdentityCandidateOpeningTimeMatch: null,
  };
  let candidateOrder: ProviderLifecycleCandidateOrder | null = null;
  let candidateFills: ProviderLifecycleCandidateFill[] = [];
  if (!entryIdentity && row && recoverableClientOid) {
    type CandidateOrder = { provider_order_id: string; client_oid: string | null; symbol: string; side: string; pos_side: string | null; trade_side: string | null; reduce_only: string | null; origin: ProviderEvidenceOrigin; created_time: string };
    // Only zero/one/many matters here; avoid sorting all rows before the ambiguity cap.
    const candidates = executor.sql<CandidateOrder>`
      SELECT provider_order_id, client_oid, symbol, side, pos_side, trade_side, reduce_only, origin, created_time
      FROM provider_orders
      WHERE category = ${category} AND client_oid = ${recoverableClientOid}
      LIMIT 2
    `;
    entryIdentityCandidateDiagnostics.entryIdentityCandidateLookupCount = Math.min(candidates.length, 2);
    const candidate = candidates.length === 1 ? candidates[0] : null;
    entryIdentityCandidateDiagnostics.entryIdentityCandidateProviderOrderIdPresent = candidate ? Boolean(candidate.provider_order_id) : null;
    entryIdentityCandidateDiagnostics.entryIdentityCandidateSymbolMatch = candidate ? candidate.symbol === experience.symbol : null;
    entryIdentityCandidateDiagnostics.entryIdentityCandidatePositionSideMatch = candidate ? candidate.pos_side?.toUpperCase() === experience.positionSide : null;
    entryIdentityCandidateDiagnostics.entryIdentityCandidateTradeSideOpen = candidate
      ? resolveProviderLifecycleSide(candidate.side, candidate.pos_side, candidate.trade_side) === "OPEN"
      : null;
    entryIdentityCandidateDiagnostics.entryIdentityCandidateDarwinOrigin = candidate ? candidate.origin === "DARWIN" : null;
    entryIdentityCandidateDiagnostics.entryIdentityCandidateOpeningTimeMatch = candidate
      ? isProviderLifecycleTimestampNear(candidate.created_time, row.opening_time)
      : null;
    if (includeIdentityDiagnostics && candidate) {
      candidateOrder = {
        providerOrderId: candidate.provider_order_id,
        clientOid: candidate.client_oid,
        symbol: candidate.symbol,
        side: candidate.side,
        posSide: candidate.pos_side,
        tradeSide: candidate.trade_side,
        reduceOnly: candidate.reduce_only,
        createdTime: candidate.created_time,
        origin: candidate.origin,
      };
      const candidateFillRows = executor.sql<{
        exec_id: string; provider_order_id: string; client_oid: string | null; symbol: string; side: string;
        pos_side: string | null; trade_side: string | null; exec_qty: string; created_time: string; origin: ProviderEvidenceOrigin;
      }>`SELECT exec_id, provider_order_id, client_oid, symbol, side, pos_side, trade_side, exec_qty, created_time, origin FROM provider_fills WHERE category = ${category} AND provider_order_id = ${candidate.provider_order_id} AND client_oid = ${candidate.client_oid} ORDER BY created_time, exec_id LIMIT 2`;
      candidateFills = candidateFillRows.map((fill) => ({
        execId: fill.exec_id,
        providerOrderId: fill.provider_order_id,
        clientOid: fill.client_oid,
        symbol: fill.symbol,
        side: fill.side,
        posSide: fill.pos_side,
        tradeSide: fill.trade_side,
        quantity: fill.exec_qty,
        createdTime: fill.created_time,
        origin: fill.origin,
      }));
    }
    if (candidate && candidate.provider_order_id && candidate.client_oid === recoverableClientOid
      && entryIdentityCandidateDiagnostics.entryIdentityCandidateSymbolMatch === true
      && entryIdentityCandidateDiagnostics.entryIdentityCandidatePositionSideMatch === true
      && entryIdentityCandidateDiagnostics.entryIdentityCandidateTradeSideOpen === true
      && entryIdentityCandidateDiagnostics.entryIdentityCandidateDarwinOrigin === true
      && entryIdentityCandidateDiagnostics.entryIdentityCandidateOpeningTimeMatch === true) {
      entryIdentity = { entryDecisionId: experience.entryDecisionId, clientOid: candidate.client_oid, providerOrderId: candidate.provider_order_id };
      entryIdentitySource = identity ? "IDEMPOTENCY_CLIENT_OID" : "DERIVED_DARWIN_CLIENT_OID";
    }
  }
  const matchingPosition = providerPositions.find((position) => position.symbol === experience.symbol && position.positionSide === experience.positionSide);
  const livePositionStartAt = matchingPosition?.openedAt && Number.isFinite(Date.parse(matchingPosition.openedAt))
    ? new Date(Date.parse(matchingPosition.openedAt) - PROVIDER_LIFECYCLE_TIME_TOLERANCE_MS).toISOString()
    : null;
  type ProviderOrderRow = { provider_order_id: string; client_oid: string | null; symbol: string; side: string | null; pos_side: string | null; trade_side: string | null; created_time: string; origin: ProviderEvidenceOrigin };
  type ProviderFillRow = ProviderOrderRow & { exec_qty: string; exec_price: string };
  const orders = row
    ? executor.sql<ProviderOrderRow>`SELECT provider_order_id, client_oid, symbol, side, pos_side, trade_side, created_time, origin FROM provider_orders WHERE category = ${category} AND symbol = ${experience.symbol} AND ((provider_order_id = ${entryIdentity?.providerOrderId ?? ""} AND client_oid = ${entryIdentity?.clientOid ?? ""}) OR (created_time >= ${row.opening_time} AND (${matchingPosition ? 1 : 0} = 1 OR created_time <= ${row.closing_time}))) ORDER BY created_time LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
    : livePositionStartAt && entryIdentity
      ? executor.sql<ProviderOrderRow>`SELECT provider_order_id, client_oid, symbol, side, pos_side, trade_side, created_time, origin FROM provider_orders WHERE category = ${category} AND symbol = ${experience.symbol} AND ((provider_order_id = ${entryIdentity.providerOrderId} AND client_oid = ${entryIdentity.clientOid}) OR created_time >= ${livePositionStartAt}) ORDER BY created_time LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
      : livePositionStartAt
        ? executor.sql<ProviderOrderRow>`SELECT provider_order_id, client_oid, symbol, side, pos_side, trade_side, created_time, origin FROM provider_orders WHERE category = ${category} AND symbol = ${experience.symbol} AND created_time >= ${livePositionStartAt} ORDER BY created_time LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
        : entryIdentity
          ? executor.sql<ProviderOrderRow>`SELECT provider_order_id, client_oid, symbol, side, pos_side, trade_side, created_time, origin FROM provider_orders WHERE category = ${category} AND symbol = ${experience.symbol} AND provider_order_id = ${entryIdentity.providerOrderId} AND client_oid = ${entryIdentity.clientOid} LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
          : [];
  const fills = row
    ? executor.sql<ProviderFillRow>`SELECT provider_order_id, client_oid, symbol, side, pos_side, trade_side, exec_qty, exec_price, created_time, origin FROM provider_fills WHERE category = ${category} AND symbol = ${experience.symbol} AND ((provider_order_id = ${entryIdentity?.providerOrderId ?? ""} AND client_oid = ${entryIdentity?.clientOid ?? ""}) OR (created_time >= ${row.opening_time} AND (${matchingPosition ? 1 : 0} = 1 OR created_time <= ${row.closing_time}))) ORDER BY created_time LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
    : livePositionStartAt && entryIdentity
      ? executor.sql<ProviderFillRow>`SELECT provider_order_id, client_oid, symbol, side, pos_side, trade_side, exec_qty, exec_price, created_time, origin FROM provider_fills WHERE category = ${category} AND symbol = ${experience.symbol} AND ((provider_order_id = ${entryIdentity.providerOrderId} AND client_oid = ${entryIdentity.clientOid}) OR created_time >= ${livePositionStartAt}) ORDER BY created_time LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
      : livePositionStartAt
        ? executor.sql<ProviderFillRow>`SELECT provider_order_id, client_oid, symbol, side, pos_side, trade_side, exec_qty, exec_price, created_time, origin FROM provider_fills WHERE category = ${category} AND symbol = ${experience.symbol} AND created_time >= ${livePositionStartAt} ORDER BY created_time LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
        : entryIdentity
          ? executor.sql<ProviderFillRow>`SELECT provider_order_id, client_oid, symbol, side, pos_side, trade_side, exec_qty, exec_price, created_time, origin FROM provider_fills WHERE category = ${category} AND symbol = ${experience.symbol} AND provider_order_id = ${entryIdentity.providerOrderId} AND client_oid = ${entryIdentity.clientOid} LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
          : [];
  const evidenceComplete = orders.length <= MAX_LIFECYCLE_EVIDENCE_ROWS && fills.length <= MAX_LIFECYCLE_EVIDENCE_ROWS;
  const mappedOrders = orders.map((order) => ({ providerOrderId: order.provider_order_id, clientOid: order.client_oid, symbol: order.symbol, side: order.side, positionSide: order.pos_side?.toUpperCase() ?? null, tradeSide: order.trade_side?.trim().toLowerCase() ?? null, createdAt: order.created_time, origin: order.origin }));
  const mappedFills = fills.map((fill) => ({ providerOrderId: fill.provider_order_id, clientOid: fill.client_oid, symbol: fill.symbol, side: fill.side, positionSide: fill.pos_side?.toUpperCase() ?? null, tradeSide: fill.trade_side?.trim().toLowerCase() ?? null, quantity: fill.exec_qty, execPrice: fill.exec_price, createdAt: fill.created_time, origin: fill.origin }));
  if (!row) return { experience, providerPositions, history: null, entryIdentity, ...(includeIdentityDiagnostics ? { candidateOrder, candidateFills } : {}), entryIdentitySource, entryIdentityLookupCount: Math.min(identities.length, 2), ...idempotencyIdentityDiagnostics, ...entryIdentityCandidateDiagnostics, orders: mappedOrders, fills: mappedFills, evidenceComplete };

  return {
    experience,
    providerPositions,
    ...(includeIdentityDiagnostics ? { candidateOrder, candidateFills } : {}),
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
    entryIdentity,
    entryIdentitySource,
    entryIdentityLookupCount: Math.min(identities.length, 2),
    ...idempotencyIdentityDiagnostics,
    ...entryIdentityCandidateDiagnostics,
    orders: mappedOrders,
    fills: mappedFills,
    evidenceComplete,
  };
}

export function loadProviderLifecycleEvidenceBatch(
  executor: SqlExecutor,
  category: string,
  requests: readonly ProviderLifecycleEvidenceRequest[],
  path = "/api/snapshot",
): Map<string, ProviderLifecycleEvidence> {
  const result = new Map<string, ProviderLifecycleEvidence>();
  if (requests.length === 0) return result;
  const requestIdCounts = new Map<string, number>();
  for (const request of requests) requestIdCounts.set(request.requestId, (requestIdCounts.get(request.requestId) ?? 0) + 1);
  const duplicateRequestIds = new Set([...requestIdCounts].filter(([, count]) => count > 1).map(([requestId]) => requestId));
  const historyIdCounts = new Map<string, number>();
  for (const request of requests) {
    const historyId = request.history?.providerPositionHistoryId;
    if (historyId) historyIdCounts.set(historyId, (historyIdCounts.get(historyId) ?? 0) + 1);
  }
  const batchSize = 20;
  for (let offset = 0; offset < requests.length; offset += batchSize) {
    const batch = requests.slice(offset, offset + batchSize);
    const decisionIds = [...new Set(batch.map((request) => request.experience.entryDecisionId).filter((id) => id.length > 0 && id.length <= 256))];
    const identityRows = decisionIds.length > 0
      ? executor.sql<{ decision_id: string; client_order_id: string; provider_order_id: string | null }>`
        SELECT i.decision_id, i.client_order_id, i.provider_order_id
        FROM idempotency AS i
        JOIN json_each(${JSON.stringify(decisionIds)}) AS requested ON requested.value = i.decision_id
        ORDER BY i.decision_id, i.created_at, i.client_order_id
        LIMIT 5_001
      `
      : [];
    const identitiesByDecision = new Map<string, Array<{ clientOrderId: string; providerOrderId: string | null }>>();
    for (const row of identityRows) {
      const identities = identitiesByDecision.get(row.decision_id) ?? [];
      identities.push({ clientOrderId: row.client_order_id, providerOrderId: row.provider_order_id });
      identitiesByDecision.set(row.decision_id, identities);
    }
    const incompleteWindowRequests = new Set<string>();
    const requestNow = Date.now();
    const queryRequests = batch.map((request) => {
      const identities = identitiesByDecision.get(request.experience.entryDecisionId) ?? [];
      const clientOrderId = identities[0]?.clientOrderId;
      const identity = identityRows.length <= 5_000 && identities.length === 1 && isCanonicalNonEmptyClientOrderId(clientOrderId)
        && isExactOptionalProviderOrderId(identities[0]?.providerOrderId) ? identities[0] : null;
      const position = request.providerPosition;
      const rangeStart = request.history?.openingTime
        ?? (position?.openedAt && Number.isFinite(Date.parse(position.openedAt)) ? new Date(Date.parse(position.openedAt) - PROVIDER_LIFECYCLE_TIME_TOLERANCE_MS).toISOString() : null);
      const rangeEnd = request.history && !position ? request.history.closingTime : null;
      const rangeStartMs = rangeStart ? Date.parse(rangeStart) : NaN;
      const rangeEndMs = rangeEnd ? Date.parse(rangeEnd) : requestNow;
      const validWindow = !rangeStart || (Number.isFinite(rangeStartMs) && Number.isFinite(rangeEndMs)
        && rangeEndMs >= rangeStartMs && rangeEndMs - rangeStartMs <= MAX_PROVIDER_HISTORY_MS);
      if (!validWindow) incompleteWindowRequests.add(request.requestId);
      return {
        requestId: request.requestId,
        symbol: request.experience.symbol,
        positionSide: request.experience.positionSide?.toLowerCase() ?? "",
        rangeStart: validWindow ? rangeStart : null,
        rangeEnd: validWindow ? rangeEnd : null,
        entryProviderOrderId: identity?.providerOrderId ?? null,
        entryClientOid: identity?.clientOrderId ?? null,
      };
    });
    const requestJson = JSON.stringify(queryRequests);
    type OrderEvidenceSqlRow = { request_id: string; client_oid_rows: string; entry_order_rows: string; range_order_rows: string };
    type FillEvidenceSqlRow = { request_id: string; client_oid_rows: string; entry_order_rows: string; range_side_rows: string; range_untyped_rows: string };
    type OrderEvidenceRow = { provider_order_id: string; client_oid: string | null; symbol: string; side: string | null; pos_side: string | null; trade_side: string | null; created_time: string; origin: ProviderEvidenceOrigin };
    type FillEvidenceRow = OrderEvidenceRow & { exec_id: string; exec_qty: string; exec_price: string };
    const orders = executeMeasuredSql<OrderEvidenceSqlRow>(executor, path, "lifecycle_evidence_order_batch")`
      SELECT json_extract(r.value, '$.requestId') AS request_id,
        COALESCE((SELECT json_group_array(json_object('provider_order_id', matched.provider_order_id, 'client_oid', matched.client_oid, 'symbol', matched.symbol, 'side', matched.side, 'pos_side', matched.pos_side, 'trade_side', matched.trade_side, 'created_time', matched.created_time, 'origin', matched.origin))
          FROM (SELECT o.provider_order_id, o.client_oid, o.symbol, o.side, o.pos_side, o.trade_side, o.created_time, o.origin
            FROM provider_orders AS o
            WHERE o.category = ${category} AND json_extract(r.value, '$.entryProviderOrderId') IS NULL
              AND json_extract(r.value, '$.entryClientOid') IS NOT NULL AND o.client_oid = json_extract(r.value, '$.entryClientOid')
            ORDER BY o.created_time, o.provider_order_id LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}) AS matched), '[]') AS client_oid_rows,
        COALESCE((SELECT json_group_array(json_object('provider_order_id', matched.provider_order_id, 'client_oid', matched.client_oid, 'symbol', matched.symbol, 'side', matched.side, 'pos_side', matched.pos_side, 'trade_side', matched.trade_side, 'created_time', matched.created_time, 'origin', matched.origin))
          FROM (SELECT o.provider_order_id, o.client_oid, o.symbol, o.side, o.pos_side, o.trade_side, o.created_time, o.origin
            FROM provider_orders AS o
            WHERE o.category = ${category} AND json_extract(r.value, '$.entryProviderOrderId') IS NOT NULL
              AND o.provider_order_id = json_extract(r.value, '$.entryProviderOrderId') AND o.client_oid = json_extract(r.value, '$.entryClientOid')
            ORDER BY o.created_time, o.provider_order_id LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}) AS matched), '[]') AS entry_order_rows,
        COALESCE((SELECT json_group_array(json_object('provider_order_id', matched.provider_order_id, 'client_oid', matched.client_oid, 'symbol', matched.symbol, 'side', matched.side, 'pos_side', matched.pos_side, 'trade_side', matched.trade_side, 'created_time', matched.created_time, 'origin', matched.origin))
          FROM (SELECT o.provider_order_id, o.client_oid, o.symbol, o.side, o.pos_side, o.trade_side, o.created_time, o.origin
            FROM provider_orders AS o
            WHERE o.category = ${category} AND o.symbol = json_extract(r.value, '$.symbol')
              AND UPPER(o.pos_side) = UPPER(json_extract(r.value, '$.positionSide'))
              AND json_extract(r.value, '$.rangeStart') IS NOT NULL
              AND o.created_time >= json_extract(r.value, '$.rangeStart')
              AND (json_extract(r.value, '$.rangeEnd') IS NULL OR o.created_time <= json_extract(r.value, '$.rangeEnd'))
            ORDER BY o.created_time, o.provider_order_id LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}) AS matched), '[]') AS range_order_rows
      FROM json_each(${requestJson}) AS r
    `;
    const fills = executeMeasuredSql<FillEvidenceSqlRow>(executor, path, "lifecycle_evidence_fill_batch")`
      SELECT json_extract(r.value, '$.requestId') AS request_id,
        COALESCE((SELECT json_group_array(json_object('exec_id', matched.exec_id, 'provider_order_id', matched.provider_order_id, 'client_oid', matched.client_oid, 'symbol', matched.symbol, 'side', matched.side, 'pos_side', matched.pos_side, 'trade_side', matched.trade_side, 'created_time', matched.created_time, 'origin', matched.origin, 'exec_qty', matched.exec_qty, 'exec_price', matched.exec_price))
          FROM (SELECT f.exec_id, f.provider_order_id, f.client_oid, f.symbol, f.side, f.pos_side, f.trade_side, f.created_time, f.origin, f.exec_qty, f.exec_price
            FROM provider_fills AS f
            WHERE f.category = ${category} AND json_extract(r.value, '$.entryProviderOrderId') IS NULL
              AND json_extract(r.value, '$.entryClientOid') IS NOT NULL AND f.client_oid = json_extract(r.value, '$.entryClientOid')
            ORDER BY f.created_time, f.exec_id LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}) AS matched), '[]') AS client_oid_rows,
        COALESCE((SELECT json_group_array(json_object('exec_id', matched.exec_id, 'provider_order_id', matched.provider_order_id, 'client_oid', matched.client_oid, 'symbol', matched.symbol, 'side', matched.side, 'pos_side', matched.pos_side, 'trade_side', matched.trade_side, 'created_time', matched.created_time, 'origin', matched.origin, 'exec_qty', matched.exec_qty, 'exec_price', matched.exec_price))
          FROM (SELECT f.exec_id, f.provider_order_id, f.client_oid, f.symbol, f.side, f.pos_side, f.trade_side, f.created_time, f.origin, f.exec_qty, f.exec_price
            FROM provider_fills AS f
            WHERE f.category = ${category} AND json_extract(r.value, '$.entryProviderOrderId') IS NOT NULL
              AND f.provider_order_id = json_extract(r.value, '$.entryProviderOrderId') AND f.client_oid = json_extract(r.value, '$.entryClientOid')
            ORDER BY f.created_time, f.exec_id LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}) AS matched), '[]') AS entry_order_rows,
        COALESCE((SELECT json_group_array(json_object('exec_id', matched.exec_id, 'provider_order_id', matched.provider_order_id, 'client_oid', matched.client_oid, 'symbol', matched.symbol, 'side', matched.side, 'pos_side', matched.pos_side, 'trade_side', matched.trade_side, 'created_time', matched.created_time, 'origin', matched.origin, 'exec_qty', matched.exec_qty, 'exec_price', matched.exec_price))
          FROM (SELECT f.exec_id, f.provider_order_id, f.client_oid, f.symbol, f.side, f.pos_side, f.trade_side, f.created_time, f.origin, f.exec_qty, f.exec_price
            FROM provider_fills AS f
            WHERE f.category = ${category} AND f.symbol = json_extract(r.value, '$.symbol')
              AND UPPER(f.pos_side) = UPPER(json_extract(r.value, '$.positionSide'))
              AND json_extract(r.value, '$.rangeStart') IS NOT NULL
              AND f.created_time >= json_extract(r.value, '$.rangeStart')
              AND (json_extract(r.value, '$.rangeEnd') IS NULL OR f.created_time <= json_extract(r.value, '$.rangeEnd'))
            ORDER BY f.created_time, f.exec_id LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}) AS matched), '[]') AS range_side_rows,
        COALESCE((SELECT json_group_array(json_object('exec_id', matched.exec_id, 'provider_order_id', matched.provider_order_id, 'client_oid', matched.client_oid, 'symbol', matched.symbol, 'side', matched.side, 'pos_side', matched.pos_side, 'trade_side', matched.trade_side, 'created_time', matched.created_time, 'origin', matched.origin, 'exec_qty', matched.exec_qty, 'exec_price', matched.exec_price))
          FROM (SELECT f.exec_id, f.provider_order_id, f.client_oid, f.symbol, f.side, f.pos_side, f.trade_side, f.created_time, f.origin, f.exec_qty, f.exec_price
            FROM provider_fills AS f
            WHERE f.category = ${category} AND f.symbol = json_extract(r.value, '$.symbol')
              AND (f.pos_side IS NULL OR UPPER(f.pos_side) NOT IN ('LONG', 'SHORT'))
              AND json_extract(r.value, '$.rangeStart') IS NOT NULL
              AND f.created_time >= json_extract(r.value, '$.rangeStart')
              AND (json_extract(r.value, '$.rangeEnd') IS NULL OR f.created_time <= json_extract(r.value, '$.rangeEnd'))
            ORDER BY f.created_time, f.exec_id LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}) AS matched), '[]') AS range_untyped_rows
      FROM json_each(${requestJson}) AS r
    `;
    const ordersByRequest = new Map<string, ProviderLifecycleOrder[]>();
    const fillsByRequest = new Map<string, ProviderLifecycleFill[]>();
    const orderCounts = new Map<string, number>();
    const fillCounts = new Map<string, number>();
    const invalidEvidenceRequests = new Set<string>();
    for (const row of orders) {
      const rows = [row.client_oid_rows, row.entry_order_rows, row.range_order_rows].flatMap((json) => parseLifecycleEvidenceRows<OrderEvidenceRow>(json) ?? []);
      if ([row.client_oid_rows, row.entry_order_rows, row.range_order_rows].some((json) => parseLifecycleEvidenceRows<OrderEvidenceRow>(json) === null)) invalidEvidenceRequests.add(row.request_id);
      const unique = new Map(rows.map((item) => [item.provider_order_id, item]));
      const values = [...unique.values()].sort((left, right) => left.created_time.localeCompare(right.created_time) || left.provider_order_id.localeCompare(right.provider_order_id))
        .map((item) => ({ providerOrderId: item.provider_order_id, clientOid: item.client_oid, symbol: item.symbol, side: item.side, positionSide: item.pos_side?.toUpperCase() ?? null, tradeSide: item.trade_side?.trim().toLowerCase() ?? null, createdAt: item.created_time, origin: item.origin }));
      ordersByRequest.set(row.request_id, values);
      orderCounts.set(row.request_id, values.length);
    }
    for (const row of fills) {
      const jsonRows = [row.client_oid_rows, row.entry_order_rows, row.range_side_rows, row.range_untyped_rows];
      const rows = jsonRows.flatMap((json) => parseLifecycleEvidenceRows<FillEvidenceRow>(json) ?? []);
      if (jsonRows.some((json) => parseLifecycleEvidenceRows<FillEvidenceRow>(json) === null)) invalidEvidenceRequests.add(row.request_id);
      const unique = new Map(rows.map((item) => [item.exec_id, item]));
      const values = [...unique.values()].sort((left, right) => left.created_time.localeCompare(right.created_time) || left.exec_id.localeCompare(right.exec_id))
        .map((item) => ({ providerOrderId: item.provider_order_id, clientOid: item.client_oid, symbol: item.symbol, side: item.side, positionSide: item.pos_side?.toUpperCase() ?? null, tradeSide: item.trade_side?.trim().toLowerCase() ?? null, quantity: item.exec_qty, execPrice: item.exec_price, createdAt: item.created_time, origin: item.origin }));
      fillsByRequest.set(row.request_id, values);
      fillCounts.set(row.request_id, values.length);
    }
    for (const request of batch) {
      const identities = identitiesByDecision.get(request.experience.entryDecisionId) ?? [];
      const clientOrderId = identities[0]?.clientOrderId;
      const identity = identityRows.length <= 5_000 && identities.length === 1 && isCanonicalNonEmptyClientOrderId(clientOrderId)
        && isExactOptionalProviderOrderId(identities[0]?.providerOrderId) ? identities[0] : null;
      const historyId = request.history?.providerPositionHistoryId;
      const duplicateHistory = Boolean(historyId && historyIdCounts.get(historyId)! > 1);
      const evidenceComplete = identityRows.length <= 5_000 && !duplicateHistory && !duplicateRequestIds.has(request.requestId)
        && !incompleteWindowRequests.has(request.requestId) && !invalidEvidenceRequests.has(request.requestId)
        && (orderCounts.get(request.requestId) ?? 0) <= MAX_LIFECYCLE_EVIDENCE_ROWS
        && (fillCounts.get(request.requestId) ?? 0) <= MAX_LIFECYCLE_EVIDENCE_ROWS;
      let entryIdentity: ProviderLifecycleEvidence["entryIdentity"] = identity?.providerOrderId
        ? { entryDecisionId: request.experience.entryDecisionId, clientOid: identity.clientOrderId, providerOrderId: identity.providerOrderId }
        : null;
      if (evidenceComplete && !entryIdentity && identity?.providerOrderId === null) {
        const candidates = (ordersByRequest.get(request.requestId) ?? []).filter((order) => order.clientOid === identity.clientOrderId);
        const candidate = candidates.length === 1 ? candidates[0] : null;
        const lifecycleOpeningTime = request.history?.openingTime ?? request.providerPosition?.openedAt ?? null;
        const linkedCandidateFills = candidate
          ? (fillsByRequest.get(request.requestId) ?? []).filter((fill) => fill.providerOrderId === candidate.providerOrderId && fill.clientOid === identity.clientOrderId)
          : [];
        const linkedOpeningFill = Boolean(candidate && lifecycleOpeningTime && linkedCandidateFills.some((fill) => fill.symbol === candidate.symbol
          && fill.positionSide === candidate.positionSide && fill.origin === candidate.origin
          && resolveProviderLifecycleSide(fill.side, fill.positionSide, fill.tradeSide) === "OPEN"
          && isProviderLifecycleTimestampNear(fill.createdAt, lifecycleOpeningTime)));
        const linkedFillsAreConsistent = Boolean(candidate && linkedCandidateFills.length > 0 && linkedCandidateFills.every((fill) => fill.symbol === candidate.symbol
          && fill.positionSide === candidate.positionSide && fill.origin === candidate.origin
          && resolveProviderLifecycleSide(fill.side, fill.positionSide, fill.tradeSide) === "OPEN"));
        if (candidate?.origin === "DARWIN" && candidate.symbol === request.experience.symbol
          && candidate.positionSide === request.experience.positionSide?.toUpperCase()
          && resolveProviderLifecycleSide(candidate.side, candidate.positionSide, candidate.tradeSide) === "OPEN"
          && candidate.providerOrderId && linkedOpeningFill && linkedFillsAreConsistent) {
          entryIdentity = { entryDecisionId: request.experience.entryDecisionId, clientOid: identity.clientOrderId, providerOrderId: candidate.providerOrderId };
        }
      }
      result.set(request.requestId, {
        experience: request.experience,
        providerPositions: request.providerPosition ? [request.providerPosition] : [],
        history: request.history,
        entryIdentity,
        orders: ordersByRequest.get(request.requestId) ?? [],
        fills: fillsByRequest.get(request.requestId) ?? [],
        evidenceComplete,
      });
    }
  }
  return result;
}

export function loadProviderExitExecutionFacts(
  executor: SqlExecutor,
  category: string,
  experiences: readonly TradeExperience[],
): Map<string, ProviderExecutionFact> {
  const requests = experiences.flatMap((experience) => {
    const action = experience.lastAction && experience.lastAction !== "HOLD" ? experience.lastAction : experience.action;
    if ((action !== "CLOSE" && action !== "REDUCE") || experience.entryDecisionId !== ""
      || !experience.exitDecisionId || experience.exitDecisionId.length > 256 || !experience.positionSide
      || !experience.exitTime || !Number.isFinite(Date.parse(experience.exitTime))) return [];
    return [{ requestId: experience.experienceId, experience }];
  });
  const facts = new Map<string, ProviderExecutionFact>();
  if (requests.length === 0) return facts;

  const requestIdCounts = new Map<string, number>();
  const decisionIdCounts = new Map<string, number>();
  for (const request of requests) {
    requestIdCounts.set(request.requestId, (requestIdCounts.get(request.requestId) ?? 0) + 1);
    decisionIdCounts.set(request.experience.exitDecisionId, (decisionIdCounts.get(request.experience.exitDecisionId) ?? 0) + 1);
  }
  const duplicateRequestIds = new Set([...requestIdCounts].filter(([, count]) => count > 1).map(([id]) => id));
  const duplicateDecisionIds = new Set([...decisionIdCounts].filter(([, count]) => count > 1).map(([id]) => id));
  const batchSize = 20;

  for (let offset = 0; offset < requests.length; offset += batchSize) {
    const batch = requests.slice(offset, offset + batchSize);
    const decisionIds = [...new Set(batch.map((request) => request.experience.exitDecisionId))];
    const identityRows = executor.sql<{ decision_id: string; client_order_id: string; provider_order_id: string | null }>`
      SELECT i.decision_id, i.client_order_id, i.provider_order_id
      FROM idempotency AS i
      JOIN json_each(${JSON.stringify(decisionIds)}) AS requested ON requested.value = i.decision_id
      ORDER BY i.decision_id, i.created_at, i.client_order_id
      LIMIT 5_001
    `;
    const identitiesByDecision = new Map<string, Array<{ clientOrderId: string; providerOrderId: string | null }>>();
    for (const row of identityRows) {
      const identities = identitiesByDecision.get(row.decision_id) ?? [];
      identities.push({ clientOrderId: row.client_order_id, providerOrderId: row.provider_order_id });
      identitiesByDecision.set(row.decision_id, identities);
    }
    const queryRequests = batch.map((request) => {
      const identities = identitiesByDecision.get(request.experience.exitDecisionId) ?? [];
      const identity = identities.length === 1 ? identities[0] : null;
      const clientOrderId = identity?.clientOrderId;
      const identityValid = identityRows.length <= 5_000 && !duplicateRequestIds.has(request.requestId)
        && !duplicateDecisionIds.has(request.experience.exitDecisionId)
        && isCanonicalNonEmptyClientOrderId(clientOrderId)
        && isExactOptionalProviderOrderId(identity?.providerOrderId);
      return {
        requestId: request.requestId,
        symbol: request.experience.symbol,
        positionSide: request.experience.positionSide?.toLowerCase() ?? "",
        exitTime: request.experience.exitTime,
        providerOrderId: identityValid ? identity?.providerOrderId ?? null : null,
        clientOid: identityValid ? clientOrderId : null,
      };
    });
    const requestJson = JSON.stringify(queryRequests);
    type OrderRow = {
      request_id: string; provider_order_id: string; client_oid: string | null; symbol: string;
      side: string | null; pos_side: string | null; trade_side: string | null; order_status: string; origin: ProviderEvidenceOrigin;
      row_number: number;
    };
    const orderRows = executor.sql<OrderRow>`
      WITH candidates AS (
        SELECT json_extract(r.value, '$.requestId') AS request_id, o.provider_order_id, o.client_oid, o.symbol, o.side, o.pos_side, o.trade_side, o.order_status, o.origin,
          ROW_NUMBER() OVER (PARTITION BY json_extract(r.value, '$.requestId') ORDER BY o.created_time, o.provider_order_id) AS row_number
        FROM json_each(${requestJson}) AS r
        JOIN provider_orders AS o ON o.category = ${category}
          AND (SELECT COUNT(DISTINCT candidate.provider_order_id) FROM provider_orders AS candidate
            WHERE candidate.client_oid = json_extract(r.value, '$.clientOid')) = 1
          AND ((json_extract(r.value, '$.providerOrderId') IS NOT NULL AND o.provider_order_id = json_extract(r.value, '$.providerOrderId') AND o.client_oid = json_extract(r.value, '$.clientOid'))
            OR (json_extract(r.value, '$.providerOrderId') IS NULL AND json_extract(r.value, '$.clientOid') IS NOT NULL AND o.client_oid = json_extract(r.value, '$.clientOid')))
      )
      SELECT request_id, provider_order_id, client_oid, symbol, side, pos_side, trade_side, order_status, origin, row_number
      FROM candidates WHERE row_number <= ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1} ORDER BY request_id, row_number
    `;
    const ordersByRequest = new Map<string, OrderRow[]>();
    const orderCounts = new Map<string, number>();
    for (const row of orderRows) {
      const rows = ordersByRequest.get(row.request_id) ?? [];
      rows.push(row);
      ordersByRequest.set(row.request_id, rows);
      orderCounts.set(row.request_id, (orderCounts.get(row.request_id) ?? 0) + 1);
    }
    const fillRequests = batch.flatMap((request) => {
      const candidates = ordersByRequest.get(request.requestId) ?? [];
      const candidate = candidates.length === 1 ? candidates[0] : null;
      return candidate?.provider_order_id && candidate.client_oid
        ? [{ requestId: request.requestId, providerOrderId: candidate.provider_order_id, clientOid: candidate.client_oid }]
        : [];
    });
    const fillRows = fillRequests.length > 0 ? executor.sql<{
      request_id: string; exec_id: string; provider_order_id: string; client_oid: string | null; symbol: string;
      side: string | null; pos_side: string | null; trade_side: string | null; exec_qty: string; exec_price: string;
      fee_total: string | null; created_time: string; origin: ProviderEvidenceOrigin; row_number: number;
    }>`
      WITH candidates AS (
        SELECT json_extract(r.value, '$.requestId') AS request_id, f.exec_id, f.provider_order_id, f.client_oid, f.symbol, f.side, f.pos_side, f.trade_side, f.exec_qty, f.exec_price, f.fee_total, f.created_time, f.origin,
          ROW_NUMBER() OVER (PARTITION BY json_extract(r.value, '$.requestId') ORDER BY f.created_time, f.exec_id) AS row_number
        FROM json_each(${JSON.stringify(fillRequests)}) AS r
        JOIN provider_fills AS f ON f.category = ${category}
          AND f.provider_order_id = json_extract(r.value, '$.providerOrderId') AND f.client_oid = json_extract(r.value, '$.clientOid')
      )
      SELECT request_id, exec_id, provider_order_id, client_oid, symbol, side, pos_side, trade_side, exec_qty, exec_price, fee_total, created_time, origin, row_number
      FROM candidates WHERE row_number <= ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1} ORDER BY request_id, row_number
    ` : [];
    const fillsByRequest = new Map<string, Array<(typeof fillRows)[number]>>();
    const fillCounts = new Map<string, number>();
    for (const row of fillRows) {
      const rows = fillsByRequest.get(row.request_id) ?? [];
      rows.push(row);
      fillsByRequest.set(row.request_id, rows);
      fillCounts.set(row.request_id, (fillCounts.get(row.request_id) ?? 0) + 1);
    }
    for (const request of batch) {
      const identities = identitiesByDecision.get(request.experience.exitDecisionId) ?? [];
      const identity = identities.length === 1 ? identities[0] : null;
      const candidateOrders = ordersByRequest.get(request.requestId) ?? [];
      const order = candidateOrders.length === 1 ? candidateOrders[0] : null;
      const linkedFills = order ? fillsByRequest.get(request.requestId) ?? [] : [];
      const evidenceComplete = identityRows.length <= 5_000 && !duplicateRequestIds.has(request.requestId)
        && !duplicateDecisionIds.has(request.experience.exitDecisionId)
        && candidateOrders.length === 1 && (orderCounts.get(request.requestId) ?? 0) <= MAX_LIFECYCLE_EVIDENCE_ROWS
        && linkedFills.length > 0 && (fillCounts.get(request.requestId) ?? 0) <= MAX_LIFECYCLE_EVIDENCE_ROWS;
      if (!evidenceComplete || !identity || !order || !order.client_oid || !order.provider_order_id
        || order.client_oid !== identity.clientOrderId || order.symbol !== request.experience.symbol
        || order.origin !== "DARWIN" || order.pos_side?.toUpperCase() !== request.experience.positionSide
        || resolveProviderLifecycleSide(order.side, order.pos_side, order.trade_side) !== "CLOSE") continue;
      const consistentFills = linkedFills.every((fill) => fill.provider_order_id === order.provider_order_id
        && fill.client_oid === order.client_oid && fill.symbol === order.symbol
        && fill.pos_side?.toUpperCase() === order.pos_side?.toUpperCase() && fill.origin === "DARWIN"
        && resolveProviderLifecycleSide(fill.side, fill.pos_side, fill.trade_side) === "CLOSE");
      const timedFills = linkedFills.filter((fill) => isProviderLifecycleTimestampNear(fill.created_time, request.experience.exitTime));
      if (!consistentFills || timedFills.length === 0) continue;
      facts.set(request.requestId, {
        decisionId: request.experience.exitDecisionId,
        clientOrderId: identity.clientOrderId,
        providerOrderId: order.provider_order_id,
        symbol: order.symbol,
        positionSide: request.experience.positionSide,
        side: order.side ?? "",
        tradeSide: "CLOSE",
        orderStatus: order.order_status,
        origin: "DARWIN",
        fills: linkedFills.map((fill) => ({ execId: fill.exec_id, quantity: fill.exec_qty, price: fill.exec_price, filledAt: fill.created_time, fee: fill.fee_total })),
      });
    }
  }
  const experiencesByProviderOrderId = new Map<string, Set<string>>();
  for (const [experienceId, fact] of facts) {
    const experiences = experiencesByProviderOrderId.get(fact.providerOrderId) ?? new Set<string>();
    experiences.add(experienceId);
    experiencesByProviderOrderId.set(fact.providerOrderId, experiences);
  }
  const ambiguousProviderOrderIds = new Set([...experiencesByProviderOrderId]
    .filter(([, experienceIds]) => experienceIds.size > 1)
    .map(([providerOrderId]) => providerOrderId));
  for (const [experienceId, fact] of facts) {
    if (ambiguousProviderOrderIds.has(fact.providerOrderId)) facts.delete(experienceId);
  }
  return facts;
}

function providerSyncStateFromRow(row: SyncStateRow): ProviderSyncState | null {
  try {
    const parsed = JSON.parse(row.checkpoint_json) as ProviderSyncCheckpoints | { checkpoints?: ProviderSyncCheckpoints; financialRecordCoverage?: ProviderSyncState["financialRecordCoverage"] };
    const wrapped = "checkpoints" in parsed;
    return {
      category: row.category,
      checkpoints: wrapped ? (parsed as { checkpoints?: ProviderSyncCheckpoints }).checkpoints ?? {} : parsed as ProviderSyncCheckpoints,
      financialRecordCoverage: wrapped ? parsed.financialRecordCoverage ?? null : null,
      lastSuccessfulSyncAt: row.last_successful_sync_at,
      lastReconciliationAt: row.last_reconciliation_at,
      lastError: row.last_error,
      updatedAt: row.updated_at,
      revision: Number(row.revision ?? 0),
    };
  } catch {
    return null;
  }
}

export function loadProviderSyncState(executor: SqlExecutor, category: string): ProviderSyncState | null {
  const rows = executor.sql<SyncStateRow>`SELECT category, checkpoint_json, last_successful_sync_at, last_reconciliation_at, last_error, updated_at, revision FROM provider_sync_state WHERE category = ${category}`;
  return rows[0] ? providerSyncStateFromRow(rows[0]) : null;
}

export function loadProviderSyncStates(executor: SqlExecutor, categories: readonly string[]): Map<string, ProviderSyncState> {
  const requested = [...new Set(categories)].slice(0, 100);
  if (requested.length === 0) return new Map();
  const rows = executor.sql<SyncStateRow>`
    SELECT category, checkpoint_json, last_successful_sync_at, last_reconciliation_at, last_error, updated_at, revision
    FROM provider_sync_state
    WHERE category IN (SELECT value FROM json_each(${JSON.stringify(requested)}))
  `;
  const states = new Map<string, ProviderSyncState>();
  for (const row of rows) {
    const state = providerSyncStateFromRow(row);
    if (state) states.set(state.category, state);
  }
  return states;
}

export function saveProviderSyncState(executor: SqlExecutor, state: ProviderSyncState): void {
  executor.sql`
    INSERT INTO provider_sync_state (
      category, checkpoint_json, last_successful_sync_at, last_reconciliation_at,
      last_error, updated_at, revision
    ) VALUES (
      ${state.category}, ${JSON.stringify({ checkpoints: state.checkpoints, financialRecordCoverage: state.financialRecordCoverage ?? null })}, ${state.lastSuccessfulSyncAt},
      ${state.lastReconciliationAt}, ${state.lastError}, ${state.updatedAt}, 1
    )
    ON CONFLICT(category) DO UPDATE SET
      checkpoint_json = excluded.checkpoint_json,
      last_successful_sync_at = excluded.last_successful_sync_at,
      last_reconciliation_at = excluded.last_reconciliation_at,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at,
      revision = provider_sync_state.revision + 1
  `;
}

export function loadProviderFinancialRecordsSince(executor: SqlExecutor, category: string, baselineAt: string): Array<{ type: string; amount: string | null; fee: string | null; coin: string | null }> {
  return executor.sql<{ type: string; amount: string | null; fee: string | null; coin: string | null }>`SELECT type, amount, fee, coin FROM provider_financial_records WHERE category = ${category} AND provider_timestamp >= ${baselineAt} ORDER BY provider_timestamp, provider_record_key`;
}

export const MAX_EXTERNAL_FLOW_RECORD_READ_ROWS = 50_000;

export function loadProviderFinancialRecordsSinceCategories(
  executor: SqlExecutor,
  categories: readonly string[],
  baselineAt: string,
  limit = MAX_EXTERNAL_FLOW_RECORD_READ_ROWS,
  path = "/api/snapshot",
): { records: Array<{ type: string; amount: string | null; fee: string | null; coin: string | null }>; truncated: boolean } {
  const requested = [...new Set(categories)];
  if (requested.length > 100) return { records: [], truncated: true };
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_EXTERNAL_FLOW_RECORD_READ_ROWS) : MAX_EXTERNAL_FLOW_RECORD_READ_ROWS;
  if (requested.length === 0) return { records: [], truncated: false };
  type FinancialReplayRow = { category: string; provider_timestamp: string; provider_record_key: string; type: string; amount: string | null; fee: string | null; coin: string | null };
  const rows: FinancialReplayRow[] = [];
  for (const category of requested) {
    const remaining = boundedLimit - rows.length;
    const page = executeMeasuredSql<FinancialReplayRow>(executor, path, "external_flow_financial_replay")`
      SELECT category, provider_timestamp, provider_record_key, type, amount, fee, coin
      FROM provider_financial_records
      WHERE category = ${category} AND provider_timestamp >= ${baselineAt}
      ORDER BY provider_timestamp, provider_record_key LIMIT ${remaining + 1}
    `;
    if (page.length > remaining) {
      rows.push(...page.slice(0, remaining));
      rows.sort((left, right) => left.provider_timestamp.localeCompare(right.provider_timestamp)
        || left.category.localeCompare(right.category)
        || left.provider_record_key.localeCompare(right.provider_record_key));
      return { records: rows.map(({ type, amount, fee, coin }) => ({ type, amount, fee, coin })), truncated: true };
    }
    rows.push(...page);
  }
  rows.sort((left, right) => left.provider_timestamp.localeCompare(right.provider_timestamp)
    || left.category.localeCompare(right.category)
    || left.provider_record_key.localeCompare(right.provider_record_key));
  return { records: rows.map(({ type, amount, fee, coin }) => ({ type, amount, fee, coin })), truncated: false };
}

export function providerLedgerDiagnosticsBatch(executor: SqlExecutor, categories: readonly string[], path = "/api/provider-ledger"): Map<string, ProviderLedgerDiagnostics> {
  const requested = [...new Set(categories)];
  if (requested.length > 100) throw new Error("PROVIDER_DIAGNOSTIC_CATEGORY_LIMIT_EXCEEDED");
  const diagnostics = new Map<string, ProviderLedgerDiagnostics>(requested.map((category) => [category, {
    category,
    counts: { orders: 0, fills: 0, positionHistory: 0, financialRecords: 0 },
    origins: { DARWIN: 0, PROVIDER_EXTERNAL: 0, UNATTRIBUTED: 0 },
    sync: null,
    lastPartialOrFailureReason: null,
  } satisfies ProviderLedgerDiagnostics] as const));
  if (requested.length === 0) return diagnostics;
  const requestedJson = JSON.stringify(requested);
  const groupedTables = [
    ["orders", executeMeasuredSql<OriginCountRow>(executor, path, "provider_ledger_orders_by_category_origin")`SELECT category, origin, COUNT(*) AS count FROM provider_orders WHERE category IN (SELECT value FROM json_each(${requestedJson})) GROUP BY category, origin`],
    ["fills", executeMeasuredSql<OriginCountRow>(executor, path, "provider_ledger_fills_by_category_origin")`SELECT category, origin, COUNT(*) AS count FROM provider_fills WHERE category IN (SELECT value FROM json_each(${requestedJson})) GROUP BY category, origin`],
    ["positionHistory", executeMeasuredSql<OriginCountRow>(executor, path, "provider_ledger_history_by_category_origin")`SELECT category, origin, COUNT(*) AS count FROM provider_position_history WHERE category IN (SELECT value FROM json_each(${requestedJson})) GROUP BY category, origin`],
    ["financialRecords", executeMeasuredSql<OriginCountRow>(executor, path, "provider_ledger_financial_by_category_origin")`SELECT category, origin, COUNT(*) AS count FROM provider_financial_records WHERE category IN (SELECT value FROM json_each(${requestedJson})) GROUP BY category, origin`],
  ] as const;
  for (const [key, rows] of groupedTables) {
    for (const row of rows) {
      const entry = diagnostics.get(row.category);
      if (!entry) continue;
      const rowCount = Number(row.count);
      entry.counts[key] += rowCount;
      if (row.origin in entry.origins) entry.origins[row.origin] += rowCount;
    }
  }
  const syncStates = loadProviderSyncStates(executor, requested);
  for (const [category, entry] of diagnostics) {
    const sync = syncStates.get(category) ?? null;
    entry.sync = sync;
    entry.lastPartialOrFailureReason = sync?.lastError ?? null;
  }
  return diagnostics;
}

export function providerLedgerDiagnostics(executor: SqlExecutor, category: string, path = "/api/provider-ledger"): ProviderLedgerDiagnostics {
  return providerLedgerDiagnosticsBatch(executor, [category], path).get(category)!;
}
