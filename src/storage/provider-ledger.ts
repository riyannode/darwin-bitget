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
}

export function resolveProviderOrigin(executor: SqlExecutor, providerOrderId: string | null, clientOid: string | null): ProviderOrigin {
  if (clientOid) {
    const idempotency = executor.sql<{ client_order_id: string }>`SELECT client_order_id FROM idempotency WHERE client_order_id = ${clientOid} LIMIT 1`;
    if (idempotency.length > 0) return "DARWIN";
  }
  if (providerOrderId) {
    const idempotency = executor.sql<{ provider_order_id: string }>`SELECT provider_order_id FROM idempotency WHERE provider_order_id = ${providerOrderId} LIMIT 1`;
    if (idempotency.length > 0) return "DARWIN";
    const existing = executor.sql<{ origin: ProviderOrigin }>`SELECT origin FROM provider_orders WHERE provider_order_id = ${providerOrderId} LIMIT 1`;
    if (existing[0]?.origin === "DARWIN") return "DARWIN";
  }
  return "PROVIDER_EXTERNAL";
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
      closing_quantity, max_position_size, closing_value, max_position_value,
      position_pnl, position_roi, open_fee_total, close_fee_total, total_funding,
      cash_dividend, origin, raw_provider_json, first_seen_at, last_seen_at
    ) VALUES (
      ${record.providerPositionHistoryKey}, ${record.providerPositionHistoryId}, ${record.category}, ${record.symbol},
      ${record.positionSide}, ${record.openingTime}, ${record.closingTime}, ${record.avgEntryPrice}, ${record.avgExitPrice},
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
      provider_record_key, provider_record_id, category, symbol, type, coin, amount,
      fee, position_amount, position_balance, balance, provider_timestamp,
      origin, raw_provider_json, first_seen_at, last_seen_at
    ) VALUES (
      ${record.providerRecordKey}, ${record.providerRecordId}, ${record.category}, ${record.symbol}, ${record.type}, ${record.coin}, ${record.amount},
      ${record.fee}, ${record.positionAmount}, ${record.positionBalance}, ${record.balance}, ${record.providerTimestamp},
      ${record.origin}, ${record.rawProviderJson}, ${observedAt}, ${observedAt}
    )
    ON CONFLICT(provider_record_key) DO UPDATE SET
      provider_record_id = excluded.provider_record_id,
      category = excluded.category,
      symbol = excluded.symbol,
      type = excluded.type,
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

export function loadProviderSyncState(executor: SqlExecutor, category: string): ProviderSyncState | null {
  const rows = executor.sql<SyncStateRow>`SELECT category, checkpoint_json, last_successful_sync_at, last_reconciliation_at, last_error, updated_at FROM provider_sync_state WHERE category = ${category}`;
  const row = rows[0];
  if (!row) return null;
  try {
    return {
      category: row.category,
      checkpoints: JSON.parse(row.checkpoint_json) as ProviderSyncCheckpoints,
      lastSuccessfulSyncAt: row.last_successful_sync_at,
      lastReconciliationAt: row.last_reconciliation_at,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

export function saveProviderSyncState(executor: SqlExecutor, state: ProviderSyncState): void {
  executor.sql`
    INSERT INTO provider_sync_state (
      category, checkpoint_json, last_successful_sync_at, last_reconciliation_at,
      last_error, updated_at
    ) VALUES (
      ${state.category}, ${JSON.stringify(state.checkpoints)}, ${state.lastSuccessfulSyncAt},
      ${state.lastReconciliationAt}, ${state.lastError}, ${state.updatedAt}
    )
    ON CONFLICT(category) DO UPDATE SET
      checkpoint_json = excluded.checkpoint_json,
      last_successful_sync_at = excluded.last_successful_sync_at,
      last_reconciliation_at = excluded.last_reconciliation_at,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `;
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
  const origins = { DARWIN: 0, PROVIDER_EXTERNAL: 0 };
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
