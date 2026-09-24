import type { PositionSnapshot, TradeExperience } from "../types.js";
import type { ProviderLifecycleEvidence, ProviderLifecycleFill, ProviderLifecycleHistory, ProviderLifecycleOrder, ProviderLifecyclePosition, ProviderEvidenceOrigin } from "../trading/provider-lifecycle-reconciliation.js";
import type {
  ProviderFillRecord,
  ProviderFinancialRecord,
  ProviderOrigin,
  ProviderOrderRecord,
  ProviderPositionHistoryRecord,
} from "../bitget/provider-ledger.js";
import type { SqlExecutor } from "./schema.js";

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

export function resolveProviderOrigin(executor: SqlExecutor, providerOrderId: string | null, clientOid: string | null, fallback: ProviderOrigin = "UNATTRIBUTED"): ProviderOrigin {
  if (clientOid) {
    const idempotency = executor.sql<{ client_order_id: string }>`SELECT client_order_id FROM idempotency WHERE client_order_id = ${clientOid} LIMIT 1`;
    if (idempotency.length > 0) return "DARWIN";
  }
  if (providerOrderId) {
    const idempotency = executor.sql<{ provider_order_id: string }>`SELECT provider_order_id FROM idempotency WHERE provider_order_id = ${providerOrderId} LIMIT 1`;
    if (idempotency.length > 0) return "DARWIN";
    const existing = executor.sql<{ origin: ProviderOrigin }>`SELECT origin FROM provider_orders WHERE provider_order_id = ${providerOrderId} LIMIT 1`;
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
  nextCursor: ProviderPositionHistoryCursor | null;
  hasMore: boolean;
}

export function loadProviderPositionHistories(executor: SqlExecutor, category: string, limit = 100): ProviderLifecycleHistory[] {
  const historyLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 100;
  const rows = executor.sql<ProviderPositionHistoryRow>`SELECT provider_position_history_key, provider_position_history_id, symbol, position_side, open_total_pos, close_total_pos, avg_entry_price, avg_exit_price, cum_realised_pnl, net_profit, open_fee_total, close_fee_total, total_funding, cash_dividend, opening_time, closing_time, origin FROM provider_position_history WHERE category = ${category} ORDER BY opening_time DESC, provider_position_history_key DESC LIMIT ${historyLimit}`;
  return rows.map(mapProviderPositionHistoryRow);
}

export function loadProviderPositionHistoriesPage(
  executor: SqlExecutor,
  category: string,
  cursor: ProviderPositionHistoryCursor | null,
  limit = 100,
): ProviderPositionHistoryPage {
  const pageLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 100;
  const rows = cursor
    ? executor.sql<ProviderPositionHistoryRow>`
      SELECT provider_position_history_key, provider_position_history_id, symbol, position_side, open_total_pos, close_total_pos, avg_entry_price, avg_exit_price, cum_realised_pnl, net_profit, open_fee_total, close_fee_total, total_funding, cash_dividend, opening_time, closing_time, origin
      FROM provider_position_history
      WHERE category = ${category}
        AND (opening_time > ${cursor.openingTime} OR (opening_time = ${cursor.openingTime} AND provider_position_history_key > ${cursor.providerPositionHistoryKey}))
      ORDER BY opening_time, provider_position_history_key
      LIMIT ${pageLimit + 1}
    `
    : executor.sql<ProviderPositionHistoryRow>`
      SELECT provider_position_history_key, provider_position_history_id, symbol, position_side, open_total_pos, close_total_pos, avg_entry_price, avg_exit_price, cum_realised_pnl, net_profit, open_fee_total, close_fee_total, total_funding, cash_dividend, opening_time, closing_time, origin
      FROM provider_position_history WHERE category = ${category}
      ORDER BY opening_time, provider_position_history_key LIMIT ${pageLimit + 1}
    `;
  const hasMore = rows.length > pageLimit;
  const pageRows = rows.slice(0, pageLimit);
  const lastRow = pageRows[pageRows.length - 1];
  return {
    histories: pageRows.map(mapProviderPositionHistoryRow),
    nextCursor: hasMore && lastRow ? { openingTime: lastRow.opening_time, providerPositionHistoryKey: lastRow.provider_position_history_key } : null,
    hasMore,
  };
}

export function loadProviderPositionHistoryDecisionIds(
  executor: SqlExecutor,
  category: string,
  histories: readonly ProviderLifecycleHistory[],
): Map<string, string> {
  const ids = [...new Set(histories.flatMap((history) => history.providerPositionHistoryId ? [history.providerPositionHistoryId] : []))];
  const identitiesByHistory = new Map<string, Set<string>>();
  const batchSize = 100;
  const maxRowsPerBatch = 5_000;
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const rows = executor.sql<{ history_id: string; decision_id: string; provider_order_id: string; client_oid: string }>`
      SELECT DISTINCT h.provider_position_history_id AS history_id, i.decision_id, o.provider_order_id, o.client_oid
      FROM provider_position_history AS h
      JOIN json_each(${JSON.stringify(batch)}) AS requested ON requested.value = h.provider_position_history_id
      JOIN provider_fills AS f ON f.category = h.category AND f.symbol = h.symbol
        AND UPPER(f.pos_side) = UPPER(h.position_side) AND LOWER(f.trade_side) = 'open'
        AND ABS((julianday(f.created_time) - julianday(h.opening_time)) * 86400.0) <= 5
      JOIN provider_orders AS o ON o.category = f.category AND o.provider_order_id = f.provider_order_id
        AND o.client_oid = f.client_oid AND o.symbol = f.symbol
        AND UPPER(o.pos_side) = UPPER(f.pos_side) AND LOWER(o.trade_side) = 'open' AND o.origin = 'DARWIN'
      JOIN idempotency AS i ON i.client_order_id = f.client_oid AND i.provider_order_id = f.provider_order_id
      WHERE h.category = ${category} AND h.provider_position_history_id IS NOT NULL AND f.origin = 'DARWIN'
      LIMIT ${maxRowsPerBatch + 1}
    `;
    if (rows.length > maxRowsPerBatch) continue;
    for (const row of rows) {
      const candidate = JSON.stringify([row.decision_id, row.provider_order_id, row.client_oid]);
      const identities = identitiesByHistory.get(row.history_id) ?? new Set<string>();
      identities.add(candidate);
      identitiesByHistory.set(row.history_id, identities);
    }
  }
  const result = new Map<string, string>();
  for (const [historyId, candidates] of identitiesByHistory) {
    if (candidates.size !== 1) continue;
    const identity = JSON.parse([...candidates][0]!) as [string, string, string];
    result.set(historyId, identity[0]);
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
): Map<string, { providerOrderId: string; decisionId: string }> {
  const requests = [...new Map(positions.flatMap((position) => {
    if (!position.openedAt || !Number.isFinite(Date.parse(position.openedAt))) return [];
    const key = providerLivePositionLifecycleKey(position);
    return [[key, { key, symbol: position.symbol, positionSide: position.positionSide, openedAt: position.openedAt }]] as const;
  })).values()];
  const candidatesByPosition = new Map<string, Set<string>>();
  const batchSize = 100;
  const maxRowsPerBatch = 5_000;
  for (let offset = 0; offset < requests.length; offset += batchSize) {
    const batch = requests.slice(offset, offset + batchSize);
    const rows = executor.sql<{ position_key: string; provider_order_id: string; client_oid: string; decision_id: string }>`
      SELECT DISTINCT json_extract(requested.value, '$.key') AS position_key, o.provider_order_id, o.client_oid, i.decision_id
      FROM json_each(${JSON.stringify(batch)}) AS requested
      JOIN provider_orders AS o ON o.category = ${category} AND o.symbol = json_extract(requested.value, '$.symbol')
        AND UPPER(o.pos_side) = UPPER(json_extract(requested.value, '$.positionSide'))
        AND LOWER(o.trade_side) = 'open' AND o.origin = 'DARWIN'
      JOIN provider_fills AS f ON f.category = o.category AND f.provider_order_id = o.provider_order_id
        AND f.client_oid = o.client_oid AND f.symbol = o.symbol AND UPPER(f.pos_side) = UPPER(o.pos_side)
        AND LOWER(f.trade_side) = 'open' AND f.origin = 'DARWIN'
        AND ABS((julianday(f.created_time) - julianday(json_extract(requested.value, '$.openedAt'))) * 86400.0) <= 5
      JOIN idempotency AS i ON i.provider_order_id = o.provider_order_id AND i.client_order_id = o.client_oid
      LIMIT ${maxRowsPerBatch + 1}
    `;
    if (rows.length > maxRowsPerBatch) continue;
    for (const row of rows) {
      const identity = JSON.stringify([row.provider_order_id, row.client_oid, row.decision_id]);
      const candidates = candidatesByPosition.get(row.position_key) ?? new Set<string>();
      candidates.add(identity);
      candidatesByPosition.set(row.position_key, candidates);
    }
  }
  const identities = new Map<string, { providerOrderId: string; decisionId: string }>();
  for (const [positionKey, candidates] of candidatesByPosition) {
    if (candidates.size !== 1) continue;
    const [providerOrderId, , decisionId] = JSON.parse([...candidates][0]!) as [string, string, string];
    identities.set(positionKey, { providerOrderId, decisionId });
  }
  return identities;
}

export function loadProviderLifecycleHistoryCandidateIds(executor: SqlExecutor, experience: TradeExperience, category: string): Set<string> {
  const rows = executor.sql<{ provider_position_history_id: string }>`
    SELECT DISTINCT h.provider_position_history_id
    FROM provider_position_history h
    JOIN idempotency i ON i.decision_id = ${experience.entryDecisionId}
    JOIN provider_orders o ON o.category = h.category AND o.provider_order_id = i.provider_order_id AND o.client_oid = i.client_order_id
    JOIN provider_fills f ON f.category = o.category AND f.provider_order_id = o.provider_order_id AND f.client_oid = o.client_oid
    WHERE h.category = ${category} AND h.provider_position_history_id IS NOT NULL
      AND h.symbol = ${experience.symbol} AND UPPER(h.position_side) = ${experience.positionSide?.toUpperCase() ?? ""}
      AND o.symbol = h.symbol AND UPPER(o.pos_side) = UPPER(h.position_side) AND LOWER(o.trade_side) = 'open' AND o.origin = 'DARWIN'
      AND f.symbol = h.symbol AND UPPER(f.pos_side) = UPPER(h.position_side) AND LOWER(f.trade_side) = 'open' AND f.origin = 'DARWIN'
      AND ABS((julianday(f.created_time) - julianday(h.opening_time)) * 86400.0) <= 5
  `;
  return new Set(rows.map((row) => row.provider_position_history_id));
}

export interface ProviderLifecycleEvidenceRequest {
  requestId: string;
  experience: TradeExperience;
  history: ProviderLifecycleHistory | null;
  providerPosition?: ProviderLifecyclePosition | null;
}

const MAX_LIFECYCLE_EVIDENCE_ROWS = 2_000;

export function loadProviderLifecycleEvidence(
  executor: SqlExecutor,
  experience: TradeExperience,
  category: string,
  providerPositionHistoryId: string,
  providerPositions: readonly ProviderLifecyclePosition[],
  deterministicEntryIdentity?: { entryDecisionId: string; clientOid: string },
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
    idempotencyProviderOrderIdExact: identity ? rawProviderOrderId === providerOrderId : null,
  };
  let entryIdentity = rawClientOid === clientOid && rawProviderOrderId === providerOrderId && clientOid && providerOrderId
    ? { entryDecisionId: experience.entryDecisionId, clientOid, providerOrderId }
    : null;
  let entryIdentitySource: ProviderLifecycleEvidence["entryIdentitySource"] = entryIdentity ? "IDEMPOTENCY" : null;
  const recoverableClientOid = identity && rawClientOid && rawClientOid === clientOid && rawProviderOrderId === ""
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
  if (!entryIdentity && row && recoverableClientOid) {
    type CandidateOrder = { provider_order_id: string; client_oid: string | null; symbol: string; pos_side: string | null; trade_side: string | null; origin: ProviderEvidenceOrigin; created_time: string };
    // Only zero/one/many matters here; avoid sorting all rows before the ambiguity cap.
    const candidates = executor.sql<CandidateOrder>`
      SELECT provider_order_id, client_oid, symbol, pos_side, trade_side, origin, created_time
      FROM provider_orders
      WHERE category = ${category} AND client_oid = ${recoverableClientOid}
      LIMIT 2
    `;
    entryIdentityCandidateDiagnostics.entryIdentityCandidateLookupCount = Math.min(candidates.length, 2);
    const candidate = candidates.length === 1 ? candidates[0] : null;
    const candidateTime = candidate ? Date.parse(candidate.created_time) : Number.NaN;
    const historyTime = Date.parse(row.opening_time);
    entryIdentityCandidateDiagnostics.entryIdentityCandidateProviderOrderIdPresent = candidate ? Boolean(candidate.provider_order_id) : null;
    entryIdentityCandidateDiagnostics.entryIdentityCandidateSymbolMatch = candidate ? candidate.symbol === experience.symbol : null;
    entryIdentityCandidateDiagnostics.entryIdentityCandidatePositionSideMatch = candidate ? candidate.pos_side?.toUpperCase() === experience.positionSide : null;
    entryIdentityCandidateDiagnostics.entryIdentityCandidateTradeSideOpen = candidate ? candidate.trade_side === "open" : null;
    entryIdentityCandidateDiagnostics.entryIdentityCandidateDarwinOrigin = candidate ? candidate.origin === "DARWIN" : null;
    entryIdentityCandidateDiagnostics.entryIdentityCandidateOpeningTimeMatch = candidate
      ? Number.isFinite(candidateTime) && Number.isFinite(historyTime) && Math.abs(candidateTime - historyTime) <= 5_000
      : null;
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
    ? new Date(Date.parse(matchingPosition.openedAt) - 5_000).toISOString()
    : null;
  type ProviderOrderRow = { provider_order_id: string; client_oid: string | null; symbol: string; pos_side: string | null; trade_side: string | null; origin: ProviderEvidenceOrigin };
  type ProviderFillRow = ProviderOrderRow & { exec_qty: string; exec_price: string; created_time: string };
  const orders = row
    ? executor.sql<ProviderOrderRow>`SELECT provider_order_id, client_oid, symbol, pos_side, trade_side, origin FROM provider_orders WHERE category = ${category} AND symbol = ${experience.symbol} AND ((provider_order_id = ${entryIdentity?.providerOrderId ?? ""} AND client_oid = ${entryIdentity?.clientOid ?? ""}) OR (created_time >= ${row.opening_time} AND (${matchingPosition ? 1 : 0} = 1 OR created_time <= ${row.closing_time}))) ORDER BY created_time LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
    : livePositionStartAt && entryIdentity
      ? executor.sql<ProviderOrderRow>`SELECT provider_order_id, client_oid, symbol, pos_side, trade_side, origin FROM provider_orders WHERE category = ${category} AND symbol = ${experience.symbol} AND ((provider_order_id = ${entryIdentity.providerOrderId} AND client_oid = ${entryIdentity.clientOid}) OR created_time >= ${livePositionStartAt}) ORDER BY created_time LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
      : livePositionStartAt
        ? executor.sql<ProviderOrderRow>`SELECT provider_order_id, client_oid, symbol, pos_side, trade_side, origin FROM provider_orders WHERE category = ${category} AND symbol = ${experience.symbol} AND created_time >= ${livePositionStartAt} ORDER BY created_time LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
        : entryIdentity
          ? executor.sql<ProviderOrderRow>`SELECT provider_order_id, client_oid, symbol, pos_side, trade_side, origin FROM provider_orders WHERE category = ${category} AND symbol = ${experience.symbol} AND provider_order_id = ${entryIdentity.providerOrderId} AND client_oid = ${entryIdentity.clientOid} LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
          : [];
  const fills = row
    ? executor.sql<ProviderFillRow>`SELECT provider_order_id, client_oid, symbol, pos_side, trade_side, exec_qty, exec_price, created_time, origin FROM provider_fills WHERE category = ${category} AND symbol = ${experience.symbol} AND ((provider_order_id = ${entryIdentity?.providerOrderId ?? ""} AND client_oid = ${entryIdentity?.clientOid ?? ""}) OR (created_time >= ${row.opening_time} AND (${matchingPosition ? 1 : 0} = 1 OR created_time <= ${row.closing_time}))) ORDER BY created_time LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
    : livePositionStartAt && entryIdentity
      ? executor.sql<ProviderFillRow>`SELECT provider_order_id, client_oid, symbol, pos_side, trade_side, exec_qty, exec_price, created_time, origin FROM provider_fills WHERE category = ${category} AND symbol = ${experience.symbol} AND ((provider_order_id = ${entryIdentity.providerOrderId} AND client_oid = ${entryIdentity.clientOid}) OR created_time >= ${livePositionStartAt}) ORDER BY created_time LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
      : livePositionStartAt
        ? executor.sql<ProviderFillRow>`SELECT provider_order_id, client_oid, symbol, pos_side, trade_side, exec_qty, exec_price, created_time, origin FROM provider_fills WHERE category = ${category} AND symbol = ${experience.symbol} AND created_time >= ${livePositionStartAt} ORDER BY created_time LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
        : entryIdentity
          ? executor.sql<ProviderFillRow>`SELECT provider_order_id, client_oid, symbol, pos_side, trade_side, exec_qty, exec_price, created_time, origin FROM provider_fills WHERE category = ${category} AND symbol = ${experience.symbol} AND provider_order_id = ${entryIdentity.providerOrderId} AND client_oid = ${entryIdentity.clientOid} LIMIT ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1}`
          : [];
  const evidenceComplete = orders.length <= MAX_LIFECYCLE_EVIDENCE_ROWS && fills.length <= MAX_LIFECYCLE_EVIDENCE_ROWS;
  const mappedOrders = orders.map((order) => ({ providerOrderId: order.provider_order_id, clientOid: order.client_oid, symbol: order.symbol, positionSide: order.pos_side?.toUpperCase() ?? null, tradeSide: order.trade_side?.toLowerCase() ?? null, origin: order.origin }));
  const mappedFills = fills.map((fill) => ({ providerOrderId: fill.provider_order_id, clientOid: fill.client_oid, symbol: fill.symbol, positionSide: fill.pos_side?.toUpperCase() ?? null, tradeSide: fill.trade_side?.toLowerCase() ?? null, quantity: fill.exec_qty, execPrice: fill.exec_price, createdAt: fill.created_time, origin: fill.origin }));
  if (!row) return { experience, providerPositions, history: null, entryIdentity, entryIdentitySource, entryIdentityLookupCount: Math.min(identities.length, 2), ...idempotencyIdentityDiagnostics, ...entryIdentityCandidateDiagnostics, orders: mappedOrders, fills: mappedFills, evidenceComplete };

  return {
    experience,
    providerPositions,
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
    const queryRequests = batch.map((request) => {
      const identities = identitiesByDecision.get(request.experience.entryDecisionId) ?? [];
      const identity = identityRows.length <= 5_000 && identities.length === 1 && identities[0]?.providerOrderId ? identities[0] : null;
      const position = request.providerPosition;
      const rangeStart = request.history?.openingTime
        ?? (position?.openedAt && Number.isFinite(Date.parse(position.openedAt)) ? new Date(Date.parse(position.openedAt) - 5_000).toISOString() : null);
      const rangeEnd = request.history && !position ? request.history.closingTime : null;
      return { requestId: request.requestId, symbol: request.experience.symbol, positionSide: request.experience.positionSide?.toLowerCase() ?? "", rangeStart, rangeEnd, entryProviderOrderId: identity?.providerOrderId ?? null, entryClientOid: identity?.clientOrderId ?? null };
    });
    const requestJson = JSON.stringify(queryRequests);
    type OrderRow = { request_id: string; provider_order_id: string; client_oid: string | null; symbol: string; pos_side: string | null; trade_side: string | null; origin: ProviderEvidenceOrigin; row_number: number };
    type FillRow = OrderRow & { exec_qty: string; exec_price: string; created_time: string };
    const orders = executor.sql<OrderRow>`
      WITH candidates AS (
        SELECT json_extract(r.value, '$.requestId') AS request_id, o.provider_order_id, o.client_oid, o.symbol, o.pos_side, o.trade_side, o.origin,
          ROW_NUMBER() OVER (PARTITION BY json_extract(r.value, '$.requestId') ORDER BY o.created_time, o.provider_order_id) AS row_number
        FROM json_each(${requestJson}) AS r
        JOIN provider_orders AS o ON o.category = ${category} AND o.symbol = json_extract(r.value, '$.symbol')
          AND UPPER(o.pos_side) = UPPER(json_extract(r.value, '$.positionSide'))
          AND ((json_extract(r.value, '$.entryProviderOrderId') IS NOT NULL AND o.provider_order_id = json_extract(r.value, '$.entryProviderOrderId') AND o.client_oid = json_extract(r.value, '$.entryClientOid'))
            OR (json_extract(r.value, '$.rangeStart') IS NOT NULL AND o.created_time >= json_extract(r.value, '$.rangeStart')
              AND (json_extract(r.value, '$.rangeEnd') IS NULL OR o.created_time <= json_extract(r.value, '$.rangeEnd'))))
      )
      SELECT request_id, provider_order_id, client_oid, symbol, pos_side, trade_side, origin, row_number FROM candidates
      WHERE row_number <= ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1} ORDER BY request_id, row_number
    `;
    const fills = executor.sql<FillRow>`
      WITH candidates AS (
        SELECT json_extract(r.value, '$.requestId') AS request_id, f.provider_order_id, f.client_oid, f.symbol, f.pos_side, f.trade_side, f.origin,
          f.exec_qty, f.exec_price, f.created_time,
          ROW_NUMBER() OVER (PARTITION BY json_extract(r.value, '$.requestId') ORDER BY f.created_time, f.provider_order_id) AS row_number
        FROM json_each(${requestJson}) AS r
        JOIN provider_fills AS f ON f.category = ${category} AND f.symbol = json_extract(r.value, '$.symbol')
          AND (f.pos_side IS NULL OR UPPER(f.pos_side) NOT IN ('LONG', 'SHORT') OR UPPER(f.pos_side) = UPPER(json_extract(r.value, '$.positionSide')))
          AND ((json_extract(r.value, '$.entryProviderOrderId') IS NOT NULL AND f.provider_order_id = json_extract(r.value, '$.entryProviderOrderId') AND f.client_oid = json_extract(r.value, '$.entryClientOid'))
            OR (json_extract(r.value, '$.rangeStart') IS NOT NULL AND f.created_time >= json_extract(r.value, '$.rangeStart')
              AND (json_extract(r.value, '$.rangeEnd') IS NULL OR f.created_time <= json_extract(r.value, '$.rangeEnd'))))
      )
      SELECT request_id, provider_order_id, client_oid, symbol, pos_side, trade_side, origin, exec_qty, exec_price, created_time, row_number FROM candidates
      WHERE row_number <= ${MAX_LIFECYCLE_EVIDENCE_ROWS + 1} ORDER BY request_id, row_number
    `;
    const ordersByRequest = new Map<string, ProviderLifecycleOrder[]>();
    const fillsByRequest = new Map<string, ProviderLifecycleFill[]>();
    const orderCounts = new Map<string, number>();
    const fillCounts = new Map<string, number>();
    for (const row of orders) {
      const values = ordersByRequest.get(row.request_id) ?? [];
      values.push({ providerOrderId: row.provider_order_id, clientOid: row.client_oid, symbol: row.symbol, positionSide: row.pos_side?.toUpperCase() ?? null, tradeSide: row.trade_side?.toLowerCase() ?? null, origin: row.origin });
      ordersByRequest.set(row.request_id, values);
      orderCounts.set(row.request_id, (orderCounts.get(row.request_id) ?? 0) + 1);
    }
    for (const row of fills) {
      const values = fillsByRequest.get(row.request_id) ?? [];
      values.push({ providerOrderId: row.provider_order_id, clientOid: row.client_oid, symbol: row.symbol, positionSide: row.pos_side?.toUpperCase() ?? null, tradeSide: row.trade_side?.toLowerCase() ?? null, quantity: row.exec_qty, execPrice: row.exec_price, createdAt: row.created_time, origin: row.origin });
      fillsByRequest.set(row.request_id, values);
      fillCounts.set(row.request_id, (fillCounts.get(row.request_id) ?? 0) + 1);
    }
    for (const request of batch) {
      const identities = identitiesByDecision.get(request.experience.entryDecisionId) ?? [];
      const identity = identityRows.length <= 5_000 && identities.length === 1 && identities[0]?.providerOrderId ? identities[0] : null;
      const historyId = request.history?.providerPositionHistoryId;
      const duplicateHistory = Boolean(historyId && historyIdCounts.get(historyId)! > 1);
      const evidenceComplete = identityRows.length <= 5_000 && !duplicateHistory && !duplicateRequestIds.has(request.requestId)
        && (orderCounts.get(request.requestId) ?? 0) <= MAX_LIFECYCLE_EVIDENCE_ROWS
        && (fillCounts.get(request.requestId) ?? 0) <= MAX_LIFECYCLE_EVIDENCE_ROWS;
      result.set(request.requestId, {
        experience: request.experience,
        providerPositions: request.providerPosition ? [request.providerPosition] : [],
        history: request.history,
        entryIdentity: identity ? { entryDecisionId: request.experience.entryDecisionId, clientOid: identity.clientOrderId, providerOrderId: identity.providerOrderId! } : null,
        orders: ordersByRequest.get(request.requestId) ?? [],
        fills: fillsByRequest.get(request.requestId) ?? [],
        evidenceComplete,
      });
    }
  }
  return result;
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
): { records: Array<{ type: string; amount: string | null; fee: string | null; coin: string | null }>; truncated: boolean } {
  const requested = [...new Set(categories)].slice(0, 100);
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_EXTERNAL_FLOW_RECORD_READ_ROWS) : MAX_EXTERNAL_FLOW_RECORD_READ_ROWS;
  if (requested.length === 0) return { records: [], truncated: false };
  const rows = executor.sql<{ type: string; amount: string | null; fee: string | null; coin: string | null }>`
    SELECT type, amount, fee, coin FROM provider_financial_records
    WHERE category IN (SELECT value FROM json_each(${JSON.stringify(requested)})) AND provider_timestamp >= ${baselineAt}
    ORDER BY provider_timestamp, category, provider_record_key LIMIT ${boundedLimit + 1}
  `;
  return { records: rows.slice(0, boundedLimit), truncated: rows.length > boundedLimit };
}

export function providerLedgerDiagnostics(executor: SqlExecutor, category: string): ProviderLedgerDiagnostics {
  const count = (table: string): number => {
    const rows = table === "provider_orders"
      ? executor.sql<CountRow>`SELECT COUNT(*) AS count FROM provider_orders WHERE category = ${category}`
      : table === "provider_fills"
        ? executor.sql<CountRow>`SELECT COUNT(*) AS count FROM provider_fills WHERE category = ${category}`
        : table === "provider_position_history"
          ? executor.sql<CountRow>`SELECT COUNT(*) AS count FROM provider_position_history WHERE category = ${category}`
          : executor.sql<CountRow>`SELECT COUNT(*) AS count FROM provider_financial_records WHERE category = ${category}`;
    return Number(rows[0]?.count ?? 0);
  };
  const origins = { DARWIN: 0, PROVIDER_EXTERNAL: 0, UNATTRIBUTED: 0 };
  const originTables = ["provider_orders", "provider_fills", "provider_position_history", "provider_financial_records"] as const;
  for (const table of originTables) {
    const rows = table === "provider_orders"
      ? executor.sql<OriginCountRow>`SELECT origin, COUNT(*) AS count FROM provider_orders WHERE category = ${category} GROUP BY origin`
      : table === "provider_fills"
        ? executor.sql<OriginCountRow>`SELECT origin, COUNT(*) AS count FROM provider_fills WHERE category = ${category} GROUP BY origin`
        : table === "provider_position_history"
          ? executor.sql<OriginCountRow>`SELECT origin, COUNT(*) AS count FROM provider_position_history WHERE category = ${category} GROUP BY origin`
          : executor.sql<OriginCountRow>`SELECT origin, COUNT(*) AS count FROM provider_financial_records WHERE category = ${category} GROUP BY origin`;
    for (const row of rows) if (row.origin in origins) origins[row.origin] += Number(row.count);
  }
  const sync = loadProviderSyncState(executor, category);
  return {
    category,
    counts: {
      orders: count("provider_orders"),
      fills: count("provider_fills"),
      positionHistory: count("provider_position_history"),
      financialRecords: count("provider_financial_records"),
    },
    origins,
    sync,
    lastPartialOrFailureReason: sync?.lastError ?? null,
  };
}
