export interface SqlExecutor {
  sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[];
}

export function ensureStorage(executor: SqlExecutor): void {
  executor.sql`CREATE TABLE IF NOT EXISTS cycles (cycle_id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT)`;
  executor.sql`CREATE TABLE IF NOT EXISTS journals (cycle_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)`;
  executor.sql`CREATE TABLE IF NOT EXISTS experiences (experience_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, outcome_status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)`;
  executor.sql`CREATE TABLE IF NOT EXISTS risk_state (state_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)`;
  executor.sql`CREATE TABLE IF NOT EXISTS backtests (backtest_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)`;
  executor.sql`CREATE TABLE IF NOT EXISTS lessons (lesson_id TEXT PRIMARY KEY, symbol_scope TEXT NOT NULL, market_regime TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
  executor.sql`CREATE TABLE IF NOT EXISTS lesson_usage (cycle_id TEXT NOT NULL, lesson_id TEXT NOT NULL, applied INTEGER NOT NULL, outcome TEXT, created_at TEXT NOT NULL, PRIMARY KEY (cycle_id, lesson_id))`;
  executor.sql`CREATE TABLE IF NOT EXISTS idempotency (client_order_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, decision_id TEXT NOT NULL, provider_order_id TEXT, created_at TEXT NOT NULL)`;
  const idempotencyColumns = executor.sql<{ name: string }>`SELECT name FROM pragma_table_info('idempotency')`;
  if (!idempotencyColumns.some((column) => column.name === "provider_order_id")) executor.sql`ALTER TABLE idempotency ADD COLUMN provider_order_id TEXT`;
  executor.sql`CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, cycle_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)`;
  executor.sql`CREATE TABLE IF NOT EXISTS position_context (context_key TEXT PRIMARY KEY, symbol TEXT NOT NULL, position_side TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)`;
  executor.sql`CREATE TABLE IF NOT EXISTS provider_orders (
    provider_order_id TEXT PRIMARY KEY,
    client_oid TEXT,
    category TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    pos_side TEXT,
    trade_side TEXT,
    reduce_only TEXT,
    order_type TEXT,
    qty TEXT NOT NULL,
    cum_exec_qty TEXT NOT NULL,
    cum_exec_value TEXT,
    avg_price TEXT,
    order_status TEXT NOT NULL,
    fee_total TEXT,
    fee_details_json TEXT,
    created_time TEXT NOT NULL,
    updated_time TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('DARWIN', 'PROVIDER_EXTERNAL', 'UNATTRIBUTED')),
    raw_provider_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`;
  executor.sql`CREATE TABLE IF NOT EXISTS provider_fills (
    exec_id TEXT PRIMARY KEY,
    provider_order_id TEXT NOT NULL,
    client_oid TEXT,
    category TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    pos_side TEXT,
    trade_side TEXT,
    exec_qty TEXT NOT NULL,
    exec_price TEXT NOT NULL,
    exec_value TEXT,
    exec_pnl TEXT,
    fee_total TEXT,
    fee_details_json TEXT,
    created_time TEXT NOT NULL,
    updated_time TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('DARWIN', 'PROVIDER_EXTERNAL', 'UNATTRIBUTED')),
    raw_provider_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`;
  executor.sql`CREATE TABLE IF NOT EXISTS provider_position_history (
    provider_position_history_key TEXT PRIMARY KEY,
    provider_position_history_id TEXT,
    category TEXT NOT NULL,
    symbol TEXT NOT NULL,
    position_side TEXT NOT NULL,
    opening_time TEXT NOT NULL,
    closing_time TEXT NOT NULL,
    avg_entry_price TEXT,
    avg_exit_price TEXT,
    open_total_pos TEXT,
    close_total_pos TEXT,
    cum_realised_pnl TEXT,
    net_profit TEXT,
    closing_quantity TEXT NOT NULL,
    max_position_size TEXT,
    closing_value TEXT,
    max_position_value TEXT,
    position_pnl TEXT,
    position_roi TEXT,
    open_fee_total TEXT,
    close_fee_total TEXT,
    total_funding TEXT,
    cash_dividend TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('DARWIN', 'PROVIDER_EXTERNAL', 'UNATTRIBUTED')),
    raw_provider_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`;
  executor.sql`CREATE TABLE IF NOT EXISTS provider_financial_records (
    provider_record_key TEXT PRIMARY KEY,
    provider_record_id TEXT,
    category TEXT NOT NULL,
    symbol TEXT,
    type TEXT NOT NULL,
    position_type TEXT,
    coin TEXT,
    amount TEXT,
    fee TEXT,
    position_amount TEXT,
    position_balance TEXT,
    balance TEXT,
    provider_timestamp TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('DARWIN', 'PROVIDER_EXTERNAL', 'UNATTRIBUTED')),
    raw_provider_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`;
  executor.sql`CREATE TABLE IF NOT EXISTS provider_sync_state (
    category TEXT PRIMARY KEY,
    checkpoint_json TEXT NOT NULL,
    last_successful_sync_at TEXT,
    last_reconciliation_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  )`;
  const positionHistoryColumns = executor.sql<{ name: string }>`SELECT name FROM pragma_table_info('provider_position_history')`;
  if (!positionHistoryColumns.some((column) => column.name === "open_total_pos")) executor.sql`ALTER TABLE provider_position_history ADD COLUMN open_total_pos TEXT`;
  if (!positionHistoryColumns.some((column) => column.name === "close_total_pos")) executor.sql`ALTER TABLE provider_position_history ADD COLUMN close_total_pos TEXT`;
  if (!positionHistoryColumns.some((column) => column.name === "cum_realised_pnl")) executor.sql`ALTER TABLE provider_position_history ADD COLUMN cum_realised_pnl TEXT`;
  if (!positionHistoryColumns.some((column) => column.name === "net_profit")) executor.sql`ALTER TABLE provider_position_history ADD COLUMN net_profit TEXT`;
  if (!positionHistoryColumns.some((column) => column.name === "origin")) executor.sql`ALTER TABLE provider_position_history ADD COLUMN origin TEXT NOT NULL DEFAULT 'UNATTRIBUTED'`;
  const financialRecordColumns = executor.sql<{ name: string }>`SELECT name FROM pragma_table_info('provider_financial_records')`;
  if (!financialRecordColumns.some((column) => column.name === "position_type")) executor.sql`ALTER TABLE provider_financial_records ADD COLUMN position_type TEXT`;
  if (!financialRecordColumns.some((column) => column.name === "origin")) executor.sql`ALTER TABLE provider_financial_records ADD COLUMN origin TEXT NOT NULL DEFAULT 'UNATTRIBUTED'`;
  executor.sql`DROP INDEX IF EXISTS provider_orders_category_client_oid_uq`;
  executor.sql`CREATE INDEX IF NOT EXISTS journals_created_at_idx ON journals(created_at DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS experiences_created_at_idx ON experiences(created_at DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS position_context_symbol_idx ON position_context(symbol, position_side)`;
  executor.sql`CREATE INDEX IF NOT EXISTS events_created_at_idx ON events(created_at DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS events_cycle_created_at_idx ON events(cycle_id, created_at DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS lessons_updated_at_idx ON lessons(updated_at DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS backtests_created_at_idx ON backtests(created_at DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS idempotency_decision_idx ON idempotency(decision_id)`;
  executor.sql`CREATE INDEX IF NOT EXISTS provider_position_history_category_opening_idx ON provider_position_history(category, symbol, position_side, opening_time)`;
  executor.sql`CREATE INDEX IF NOT EXISTS provider_orders_category_updated_idx ON provider_orders(category, updated_time DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS provider_orders_client_oid_idx ON provider_orders(client_oid)`;
  executor.sql`CREATE INDEX IF NOT EXISTS provider_fills_order_created_idx ON provider_fills(provider_order_id, created_time)`;
  executor.sql`CREATE INDEX IF NOT EXISTS provider_fills_category_created_idx ON provider_fills(category, created_time DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS provider_fills_client_oid_idx ON provider_fills(client_oid)`;
  executor.sql`CREATE INDEX IF NOT EXISTS provider_position_history_category_closing_idx ON provider_position_history(category, closing_time DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS provider_position_history_symbol_idx ON provider_position_history(symbol, position_side, closing_time DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS provider_financial_records_category_timestamp_idx ON provider_financial_records(category, provider_timestamp DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS provider_financial_records_type_timestamp_idx ON provider_financial_records(type, provider_timestamp DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS provider_sync_state_updated_idx ON provider_sync_state(updated_at DESC)`;
}
