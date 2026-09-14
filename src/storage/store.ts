import type { ActivityEvent, BacktestReplay, Lesson, LessonEvaluation, OwnerPolicy, PositionContext, PositionSide, TradeExperience, TradingJournal } from "../types.js";
import { parseExperience } from "../learning/experiences.js";
import { parseLesson } from "../learning/lessons.js";
import { parseDailyDrawdownState, type DailyDrawdownState } from "../trading/drawdown.js";
import { parseOwnerPolicy } from "../trading/policy.js";
import type { SqlExecutor } from "./schema.js";

interface LessonRow {
  payload: string;
}

interface IdempotencyRow {
  client_order_id: string;
}

interface ExperienceRow {
  payload: string;
}

interface RiskStateRow {
  payload: string;
}

interface PositionContextRow {
  payload: string;
}

interface JournalRow {
  payload: string;
}

interface BacktestRow {
  payload: string;
}

interface EventRow {
  event_id: string;
  event_type: string;
  cycle_id: string;
  payload: string;
  created_at: string;
}

export interface StoredCycle {
  cycleId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
}

export const MAX_HISTORY_LIMIT = 100;

const PERFORMANCE_STATE_KEY = "performance_aggregate";
const POSITION_CONTEXT_BOOTSTRAP_KEY = "position_context_bootstrap";
const MAX_TARGETED_DECISION_ID_LENGTH = 256;

export function clampHistoryLimit(limit: number, fallback = 25): number {
  if (!Number.isInteger(limit) || limit < 1) return fallback;
  return Math.min(limit, MAX_HISTORY_LIMIT);
}

export function saveCycle(
  executor: SqlExecutor,
  cycleId: string,
  status: string,
  startedAt: string,
  completedAt: string | null,
): void {
  executor.sql`
    INSERT INTO cycles (cycle_id, status, started_at, completed_at)
    VALUES (${cycleId}, ${status}, ${startedAt}, ${completedAt})
    ON CONFLICT(cycle_id) DO UPDATE SET status = excluded.status, completed_at = excluded.completed_at
  `;
}

export function saveJournal(executor: SqlExecutor, journal: TradingJournal): void {
  executor.sql`
    INSERT INTO journals (cycle_id, payload, created_at)
    VALUES (${journal.cycleId}, ${JSON.stringify(journal)}, ${journal.startedAt})
    ON CONFLICT(cycle_id) DO UPDATE SET payload = excluded.payload
  `;
}

export function loadUsableLessons(executor: SqlExecutor): Lesson[] {
  const rows = executor.sql<LessonRow>`SELECT payload FROM lessons WHERE status IN ('ACTIVE', 'CANDIDATE', 'WEAKENED') ORDER BY updated_at DESC LIMIT 100`;
  return rows.flatMap((row) => {
    try {
      return [parseLesson(JSON.parse(row.payload))];
    } catch {
      return [];
    }
  });
}

export function loadRecentLessons(executor: SqlExecutor, limit = 10): Lesson[] {
  const rows = executor.sql<LessonRow>`SELECT payload FROM lessons ORDER BY updated_at DESC LIMIT ${limit}`;
  return rows.flatMap((row) => {
    try {
      return [parseLesson(JSON.parse(row.payload))];
    } catch {
      return [];
    }
  });
}

export function saveLesson(executor: SqlExecutor, lesson: Lesson): void {
  executor.sql`
    INSERT INTO lessons (lesson_id, symbol_scope, market_regime, status, payload, created_at, updated_at)
    VALUES (${lesson.lessonId}, ${lesson.symbolScope}, ${lesson.marketRegime}, ${lesson.status}, ${JSON.stringify(lesson)}, ${lesson.createdAt}, ${lesson.updatedAt})
    ON CONFLICT(lesson_id) DO UPDATE SET payload = excluded.payload, status = excluded.status, updated_at = excluded.updated_at
  `;
}

export function recordLessonRetrieval(executor: SqlExecutor, lessonIds: readonly string[], cycleId: string, createdAt: string): void {
  for (const lessonId of lessonIds) {
    const rows = executor.sql<LessonRow>`SELECT payload FROM lessons WHERE lesson_id = ${lessonId}`;
    const row = rows[0];
    if (!row) continue;
    const lesson = parseLesson(JSON.parse(row.payload));
    saveLesson(executor, { ...lesson, timesRetrieved: lesson.timesRetrieved + 1, updatedAt: createdAt });
    executor.sql`
      INSERT INTO lesson_usage (cycle_id, lesson_id, applied, outcome, created_at)
      VALUES (${cycleId}, ${lessonId}, 0, NULL, ${createdAt})
      ON CONFLICT(cycle_id, lesson_id) DO NOTHING
    `;
  }
}

export function recordLessonApplication(executor: SqlExecutor, cycleId: string, evaluations: readonly LessonEvaluation[], createdAt: string): void {
  for (const evaluation of evaluations) {
    const rows = executor.sql<LessonRow>`SELECT payload FROM lessons WHERE lesson_id = ${evaluation.lessonId}`;
    const row = rows[0];
    if (!row) continue;
    const lesson = parseLesson(JSON.parse(row.payload));
    const successfulApplications = lesson.successfulApplications + (evaluation.assessment === "HELPFUL" ? 1 : 0);
    const failedApplications = lesson.failedApplications + (evaluation.assessment === "HARMFUL" ? 1 : 0);
    const status = failedApplications >= 5 && failedApplications > successfulApplications
      ? "RETIRED"
      : failedApplications >= 3 && failedApplications > successfulApplications
        ? "CONTRADICTED"
        : failedApplications > successfulApplications
          ? "WEAKENED"
          : successfulApplications > 0
            ? "ACTIVE"
            : lesson.status;
    saveLesson(executor, { ...lesson, timesApplied: lesson.timesApplied + 1, successfulApplications, failedApplications, status, updatedAt: createdAt });
    executor.sql`
      INSERT INTO lesson_usage (cycle_id, lesson_id, applied, outcome, created_at)
      VALUES (${cycleId}, ${evaluation.lessonId}, 1, ${evaluation.assessment}, ${createdAt})
      ON CONFLICT(cycle_id, lesson_id) DO UPDATE SET applied = 1, outcome = excluded.outcome
    `;
  }
}

export function loadExperiences(executor: SqlExecutor, limit = MAX_HISTORY_LIMIT): TradeExperience[] {
  const rows = executor.sql<ExperienceRow>`SELECT payload FROM experiences ORDER BY created_at DESC LIMIT ${clampHistoryLimit(limit, MAX_HISTORY_LIMIT)}`;
  return rows.flatMap((row) => {
    try {
      const value = JSON.parse(row.payload);
      return [parseExperience(value)];
    } catch {
      return [];
    }
  });
}

export function loadOpenExperiences(executor: SqlExecutor, limit = MAX_HISTORY_LIMIT): TradeExperience[] {
  const rows = executor.sql<ExperienceRow>`SELECT payload FROM experiences WHERE outcome_status = 'OPEN' ORDER BY created_at DESC, experience_id ASC LIMIT ${clampHistoryLimit(limit, MAX_HISTORY_LIMIT)}`;
  return rows.flatMap((row) => {
    try {
      const experience = parseExperience(JSON.parse(row.payload));
      return experience.outcomeStatus === "OPEN" ? [experience] : [];
    } catch {
      return [];
    }
  });
}

export function loadJournalsForDecisionIds(executor: SqlExecutor, decisionIds: readonly string[], limit = MAX_HISTORY_LIMIT): TradingJournal[] {
  const journals = new Map<string, TradingJournal>();
  for (const decisionId of [...new Set(decisionIds)].slice(0, limit)) {
    if (typeof decisionId !== "string" || decisionId.length === 0 || decisionId.length > MAX_TARGETED_DECISION_ID_LENGTH || decisionId.trim().length === 0) continue;
    const marker = `"decisionId":${JSON.stringify(decisionId)}`;
    const rows = executor.sql<JournalRow>`SELECT payload FROM journals WHERE instr(payload, ${marker}) > 0 ORDER BY created_at DESC LIMIT 2`;
    for (const row of rows) {
      try {
        const journal = JSON.parse(row.payload) as TradingJournal;
        journals.set(journal.cycleId, journal);
      } catch {
        // Ignore malformed historical journal rows during bounded bootstrap.
      }
    }
  }
  return [...journals.values()];
}

export function loadAllExperiences(executor: SqlExecutor): TradeExperience[] {
  const rows = executor.sql<ExperienceRow>`SELECT payload FROM experiences ORDER BY created_at ASC, experience_id ASC`;
  return rows.flatMap((row) => {
    try {
      return [parseExperience(JSON.parse(row.payload))];
    } catch {
      return [];
    }
  });
}

export function saveExperience(executor: SqlExecutor, experience: TradeExperience, createdAt: string): void {
  executor.sql`
    INSERT INTO experiences (experience_id, symbol, outcome_status, payload, created_at)
    VALUES (${experience.experienceId}, ${experience.symbol}, ${experience.outcomeStatus}, ${JSON.stringify(experience)}, ${createdAt})
    ON CONFLICT(experience_id) DO UPDATE SET payload = excluded.payload, outcome_status = excluded.outcome_status
  `;
}

export function loadPerformanceAggregate<T>(executor: SqlExecutor): T | null {
  const rows = executor.sql<RiskStateRow>`SELECT payload FROM risk_state WHERE state_key = ${PERFORMANCE_STATE_KEY}`;
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].payload) as T;
  } catch {
    return null;
  }
}

export function savePerformanceAggregate(executor: SqlExecutor, aggregate: unknown, updatedAt: string): void {
  executor.sql`
    INSERT INTO risk_state (state_key, payload, updated_at)
    VALUES (${PERFORMANCE_STATE_KEY}, ${JSON.stringify(aggregate)}, ${updatedAt})
    ON CONFLICT(state_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `;
}

export function loadPositionContext(executor: SqlExecutor, symbol: string, positionSide: PositionSide): PositionContext | null {
  const contextKey = `${symbol}:${positionSide}`;
  const rows = executor.sql<PositionContextRow>`SELECT payload FROM position_context WHERE context_key = ${contextKey}`;
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].payload) as PositionContext;
  } catch {
    return null;
  }
}

export function savePositionContext(executor: SqlExecutor, context: PositionContext): void {
  const contextKey = `${context.symbol}:${context.positionSide}`;
  executor.sql`
    INSERT INTO position_context (context_key, symbol, position_side, payload, updated_at)
    VALUES (${contextKey}, ${context.symbol}, ${context.positionSide}, ${JSON.stringify(context)}, ${context.updatedAt})
    ON CONFLICT(context_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `;
}

export function loadPositionContextBootstrap(executor: SqlExecutor): { version: string } | null {
  const rows = executor.sql<RiskStateRow>`SELECT payload FROM risk_state WHERE state_key = ${POSITION_CONTEXT_BOOTSTRAP_KEY}`;
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].payload) as { version: string };
  } catch {
    return null;
  }
}

export function savePositionContextBootstrap(executor: SqlExecutor, version: string, updatedAt: string): void {
  executor.sql`
    INSERT INTO risk_state (state_key, payload, updated_at)
    VALUES (${POSITION_CONTEXT_BOOTSTRAP_KEY}, ${JSON.stringify({ version })}, ${updatedAt})
    ON CONFLICT(state_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `;
}

export function loadDailyDrawdownState(executor: SqlExecutor): DailyDrawdownState | undefined {
  const rows = executor.sql<RiskStateRow>`SELECT payload FROM risk_state WHERE state_key = 'daily_drawdown'`;
  if (rows.length === 0) return undefined;
  try {
    return parseDailyDrawdownState(JSON.parse(rows[0]?.payload ?? ""));
  } catch {
    return undefined;
  }
}

export function saveDailyDrawdownState(executor: SqlExecutor, state: DailyDrawdownState, updatedAt: string): void {
  executor.sql`
    INSERT INTO risk_state (state_key, payload, updated_at)
    VALUES ('daily_drawdown', ${JSON.stringify(state)}, ${updatedAt})
    ON CONFLICT(state_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `;
}

export function loadActiveOwnerPolicy(executor: SqlExecutor): OwnerPolicy | null {
  const rows = executor.sql<RiskStateRow>`SELECT payload FROM risk_state WHERE state_key = 'owner_policy'`;
  if (rows.length === 0) return null;
  return parseOwnerPolicy(JSON.parse(rows[0]?.payload ?? ""));
}

export function saveActiveOwnerPolicy(executor: SqlExecutor, policy: OwnerPolicy, updatedAt: string): void {
  executor.sql`
    INSERT INTO risk_state (state_key, payload, updated_at)
    VALUES ('owner_policy', ${JSON.stringify(policy)}, ${updatedAt})
    ON CONFLICT(state_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `;
}

export function saveBacktest(executor: SqlExecutor, replay: BacktestReplay): void {
  executor.sql`
    INSERT INTO backtests (backtest_id, payload, created_at)
    VALUES (${replay.backtestId}, ${JSON.stringify(replay)}, ${replay.createdAt})
    ON CONFLICT(backtest_id) DO UPDATE SET payload = excluded.payload
  `;
}

export function loadLatestJournal(executor: SqlExecutor): TradingJournal | null {
  const rows = executor.sql<JournalRow>`SELECT payload FROM journals ORDER BY created_at DESC LIMIT 1`;
  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0]?.payload ?? "") as TradingJournal;
  } catch {
    return null;
  }
}

export function loadRecentJournals(executor: SqlExecutor, limit = 50): TradingJournal[] {
  const rows = executor.sql<JournalRow>`SELECT payload FROM journals ORDER BY created_at DESC LIMIT ${clampHistoryLimit(limit, 50)}`;
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.payload) as TradingJournal];
    } catch {
      return [];
    }
  });
}

export function loadAllAutonomousJournals(executor: SqlExecutor, from?: string, to?: string): TradingJournal[] {
  const rows = from && to
    ? executor.sql<JournalRow>`SELECT payload FROM journals WHERE created_at >= ${from} AND created_at <= ${to} ORDER BY created_at ASC, cycle_id ASC`
    : from
      ? executor.sql<JournalRow>`SELECT payload FROM journals WHERE created_at >= ${from} ORDER BY created_at ASC, cycle_id ASC`
      : to
        ? executor.sql<JournalRow>`SELECT payload FROM journals WHERE created_at <= ${to} ORDER BY created_at ASC, cycle_id ASC`
        : executor.sql<JournalRow>`SELECT payload FROM journals ORDER BY created_at ASC, cycle_id ASC`;
  return rows.flatMap((row) => {
    try {
      const journal = JSON.parse(row.payload) as TradingJournal;
      return journal.mode === "AUTONOMOUS" ? [journal] : [];
    } catch {
      return [];
    }
  });
}

export function loadAllStoredCycles(executor: SqlExecutor, from?: string, to?: string): StoredCycle[] {
  const rows = from && to
    ? executor.sql<{ cycle_id: string; status: string; started_at: string; completed_at: string | null }>`SELECT cycle_id, status, started_at, completed_at FROM cycles WHERE started_at >= ${from} AND started_at <= ${to} ORDER BY started_at ASC, cycle_id ASC`
    : from
      ? executor.sql<{ cycle_id: string; status: string; started_at: string; completed_at: string | null }>`SELECT cycle_id, status, started_at, completed_at FROM cycles WHERE started_at >= ${from} ORDER BY started_at ASC, cycle_id ASC`
      : to
        ? executor.sql<{ cycle_id: string; status: string; started_at: string; completed_at: string | null }>`SELECT cycle_id, status, started_at, completed_at FROM cycles WHERE started_at <= ${to} ORDER BY started_at ASC, cycle_id ASC`
        : executor.sql<{ cycle_id: string; status: string; started_at: string; completed_at: string | null }>`SELECT cycle_id, status, started_at, completed_at FROM cycles ORDER BY started_at ASC, cycle_id ASC`;
  return rows.map((row) => ({ cycleId: row.cycle_id, status: row.status, startedAt: row.started_at, completedAt: row.completed_at }));
}

export function loadRecentStoredCycles(executor: SqlExecutor, limit = 25): StoredCycle[] {
  const rows = executor.sql<{ cycle_id: string; status: string; started_at: string; completed_at: string | null }>`SELECT cycle_id, status, started_at, completed_at FROM cycles ORDER BY started_at DESC, cycle_id DESC LIMIT ${clampHistoryLimit(limit, 25)}`;
  return rows.map((row) => ({ cycleId: row.cycle_id, status: row.status, startedAt: row.started_at, completedAt: row.completed_at }));
}

export function loadLatestBacktest(executor: SqlExecutor): BacktestReplay | null {
  const rows = executor.sql<BacktestRow>`SELECT payload FROM backtests ORDER BY created_at DESC LIMIT 1`;
  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0]?.payload ?? "") as BacktestReplay;
  } catch {
    return null;
  }
}

export function saveEvent(executor: SqlExecutor, event: ActivityEvent): void {
  executor.sql`
    INSERT INTO events (event_id, event_type, cycle_id, payload, created_at)
    VALUES (${event.eventId}, ${event.type}, ${event.cycleId}, ${JSON.stringify(event)}, ${event.createdAt})
  `;
}

export function loadRecentEvents(executor: SqlExecutor, limit = 25): ActivityEvent[] {
  const rows = executor.sql<EventRow>`SELECT event_id, event_type, cycle_id, payload, created_at FROM events ORDER BY created_at DESC LIMIT ${clampHistoryLimit(limit, 25)}`;
  return rows.flatMap((row) => {
    try {
      const event = JSON.parse(row.payload) as ActivityEvent;
      return [{
        eventId: event.eventId || row.event_id,
        type: event.type || row.event_type,
        cycleId: event.cycleId || row.cycle_id,
        createdAt: event.createdAt || row.created_at,
        ...(event.metadata ? { metadata: event.metadata } : {}),
      }];
    } catch {
      return [];
    }
  });
}

export function loadAllEvents(executor: SqlExecutor): ActivityEvent[] {
  const rows = executor.sql<EventRow>`SELECT event_id, event_type, cycle_id, payload, created_at FROM events ORDER BY created_at ASC, event_id ASC`;
  return rows.flatMap((row) => {
    try {
      const event = JSON.parse(row.payload) as ActivityEvent;
      return [{
        eventId: event.eventId || row.event_id,
        type: event.type || row.event_type,
        cycleId: event.cycleId || row.cycle_id,
        createdAt: event.createdAt || row.created_at,
        ...(event.metadata ? { metadata: event.metadata } : {}),
      }];
    } catch {
      return [];
    }
  });
}

export function recordIdempotency(
  executor: SqlExecutor,
  clientOrderId: string,
  cycleId: string,
  decisionId: string,
  createdAt: string,
): boolean {
  const existing = executor.sql<IdempotencyRow>`SELECT client_order_id FROM idempotency WHERE client_order_id = ${clientOrderId}`;
  if (existing.length > 0) return false;
  executor.sql`
    INSERT INTO idempotency (client_order_id, cycle_id, decision_id, created_at)
    VALUES (${clientOrderId}, ${cycleId}, ${decisionId}, ${createdAt})
  `;
  return true;
}
