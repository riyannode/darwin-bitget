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
  executor.sql`CREATE TABLE IF NOT EXISTS idempotency (client_order_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, decision_id TEXT NOT NULL, created_at TEXT NOT NULL)`;
  executor.sql`CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, cycle_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)`;
  executor.sql`CREATE TABLE IF NOT EXISTS position_context (context_key TEXT PRIMARY KEY, symbol TEXT NOT NULL, position_side TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)`;
  executor.sql`CREATE INDEX IF NOT EXISTS journals_created_at_idx ON journals(created_at DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS experiences_created_at_idx ON experiences(created_at DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS position_context_symbol_idx ON position_context(symbol, position_side)`;
  executor.sql`CREATE INDEX IF NOT EXISTS events_created_at_idx ON events(created_at DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS events_cycle_created_at_idx ON events(cycle_id, created_at DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS lessons_updated_at_idx ON lessons(updated_at DESC)`;
  executor.sql`CREATE INDEX IF NOT EXISTS backtests_created_at_idx ON backtests(created_at DESC)`;
}
