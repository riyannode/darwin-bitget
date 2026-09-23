import type { SqlExecutor } from "./schema.js";

export const JOURNAL_LOOKUP_BATCH_SIZE = 25;
export const JOURNAL_LOOKUP_MIGRATION_INTERVAL_MS = 5_000;

export type JournalLookupMigrationStatus = "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";

export interface JournalLookupMigrationSchedulePayload {
  lastCycleId: string | null;
}

export interface JournalLookupMigrationState {
  status: JournalLookupMigrationStatus;
  lastCreatedAt: string | null;
  lastCycleId: string | null;
  processedJournalCount: number;
  indexedDecisionCount: number;
  lastError: string | null;
  updatedAt: string;
}

type MigrationStateRow = {
  status: string;
  last_created_at: string | null;
  last_cycle_id: string | null;
  processed_journal_count: number;
  indexed_decision_count: number;
  last_error: string | null;
  updated_at: string;
};

type JournalBatchRow = { cycle_id: string; created_at: string; payload: string };
type CountRow = { count: number };

export type TransactionSync = <T>(callback: () => T) => T;

export function journalLookupMigrationSchedulePayload(state: Pick<JournalLookupMigrationState, "lastCycleId">): JournalLookupMigrationSchedulePayload {
  return { lastCycleId: state.lastCycleId };
}

export function isCurrentJournalLookupMigrationSchedule(payload: JournalLookupMigrationSchedulePayload, state: Pick<JournalLookupMigrationState, "lastCycleId">): boolean {
  return payload.lastCycleId === state.lastCycleId;
}

const MIGRATION_KEY = "journal_decision_lookup_v1";

export function initializeJournalLookupMigrationState(executor: SqlExecutor, now = new Date().toISOString()): void {
  executor.sql`INSERT OR IGNORE INTO journal_decision_lookup_migration (migration_key, status, last_created_at, last_cycle_id, processed_journal_count, indexed_decision_count, last_error, updated_at)
    VALUES (${MIGRATION_KEY}, CASE WHEN EXISTS (SELECT 1 FROM risk_state WHERE state_key = ${MIGRATION_KEY}) THEN 'COMPLETE' ELSE 'PENDING' END, NULL, NULL, 0, 0, NULL, ${now})`;
}

export function loadJournalLookupMigrationState(executor: SqlExecutor): JournalLookupMigrationState {
  const [row] = executor.sql<MigrationStateRow>`SELECT status, last_created_at, last_cycle_id, processed_journal_count, indexed_decision_count, last_error, updated_at FROM journal_decision_lookup_migration WHERE migration_key = ${MIGRATION_KEY} LIMIT 1`;
  if (!row) {
    return {
      status: "PENDING",
      lastCreatedAt: null,
      lastCycleId: null,
      processedJournalCount: 0,
      indexedDecisionCount: 0,
      lastError: null,
      updatedAt: new Date(0).toISOString(),
    };
  }
  const status = row.status === "RUNNING" || row.status === "COMPLETE" || row.status === "FAILED" ? row.status : "PENDING";
  return {
    status,
    lastCreatedAt: row.last_created_at,
    lastCycleId: row.last_cycle_id,
    processedJournalCount: Number(row.processed_journal_count),
    indexedDecisionCount: Number(row.indexed_decision_count),
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export function runJournalLookupMigrationBatch(
  executor: SqlExecutor,
  transactionSync: TransactionSync,
  now = new Date().toISOString(),
): JournalLookupMigrationState {
  return transactionSync(() => {
    initializeJournalLookupMigrationState(executor, now);
    const current = loadJournalLookupMigrationState(executor);
    if (current.status === "COMPLETE" || current.status === "FAILED") return current;

    const rows = current.lastCycleId === null
      ? executor.sql<JournalBatchRow>`SELECT cycle_id, created_at, payload FROM journals ORDER BY cycle_id ASC LIMIT ${JOURNAL_LOOKUP_BATCH_SIZE}`
      : executor.sql<JournalBatchRow>`SELECT cycle_id, created_at, payload FROM journals WHERE cycle_id > ${current.lastCycleId} ORDER BY cycle_id ASC LIMIT ${JOURNAL_LOOKUP_BATCH_SIZE}`;

    if (rows.length === 0) {
      executor.sql`UPDATE journal_decision_lookup_migration SET status = 'COMPLETE', last_error = NULL, updated_at = ${now} WHERE migration_key = ${MIGRATION_KEY}`;
      return { ...current, status: "COMPLETE", lastError: null, updatedAt: now };
    }

    let indexedDecisionCount = 0;
    for (const row of rows) {
      executor.sql`INSERT OR IGNORE INTO journal_decision_lookup (cycle_id, decision_id)
        SELECT DISTINCT ${row.cycle_id}, decision.value
        FROM json_tree(CASE WHEN json_valid(${row.payload}) THEN ${row.payload} ELSE '{}' END) AS decision
        WHERE decision.key = 'decisionId' AND decision.type = 'text' AND length(decision.value) BETWEEN 1 AND 256
`;
      const [changed] = executor.sql<CountRow>`SELECT changes() AS count`;
      indexedDecisionCount += Number(changed?.count ?? 0);
    }

    const cursor = rows[rows.length - 1]!;
    const processedJournalCount = current.processedJournalCount + rows.length;
    const totalIndexedDecisionCount = current.indexedDecisionCount + indexedDecisionCount;
    executor.sql`UPDATE journal_decision_lookup_migration SET
      status = 'RUNNING', last_created_at = ${cursor.created_at}, last_cycle_id = ${cursor.cycle_id},
      processed_journal_count = ${processedJournalCount}, indexed_decision_count = ${totalIndexedDecisionCount},
      last_error = NULL, updated_at = ${now}
      WHERE migration_key = ${MIGRATION_KEY}`;
    return {
      status: "RUNNING",
      lastCreatedAt: cursor.created_at,
      lastCycleId: cursor.cycle_id,
      processedJournalCount,
      indexedDecisionCount: totalIndexedDecisionCount,
      lastError: null,
      updatedAt: now,
    };
  });
}

export function markJournalLookupMigrationFailed(executor: SqlExecutor, error: unknown, now = new Date().toISOString()): JournalLookupMigrationState {
  initializeJournalLookupMigrationState(executor, now);
  const lastError = (error instanceof Error ? error.message : String(error)).split("\n", 1)[0]?.slice(0, 200) || "MIGRATION_FAILED";
  executor.sql`UPDATE journal_decision_lookup_migration SET status = 'FAILED', last_error = ${lastError}, updated_at = ${now} WHERE migration_key = ${MIGRATION_KEY}`;
  return { ...loadJournalLookupMigrationState(executor), status: "FAILED", lastError, updatedAt: now };
}
