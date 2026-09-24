import type { ActivityEvent, BacktestReplay, CycleDecisionPlan, LatestValidCyclePlan, Lesson, LessonEvaluation, OwnerPolicy, PositionContext, PositionSide, TradeExperience, TradingJournal } from "../types.js";
import { parseExperience } from "../learning/experiences.js";
import { parseLesson } from "../learning/lessons.js";
import { parseDailyDrawdownState, type DailyDrawdownState } from "../trading/drawdown.js";
import { parseOwnerPolicy } from "../trading/policy.js";
import { normalizeCycleDecisions, cyclePlanDecisions, journalHasPersistedPlan } from "./journal-normalizer.js";
import type { VerifiedExternalFlows } from "../trading/external-flow.js";
import type { ProviderPerformanceTotals } from "../trading/provider-performance.js";
import type { SqlExecutor } from "./schema.js";

interface LessonRow {
  payload: string;
}

interface IdempotencyRow {
  client_order_id: string;
}

interface IdempotencyDecisionRow {
  decision_id: string;
}

interface IdempotencyDecisionCycleRow {
  cycle_id: string;
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

interface ExactJournalRow extends JournalRow {
  cycle_id: string;
}

interface CompletedCyclePlanRow {
  cycle_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
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
const LATEST_VALID_CYCLE_PLAN_STATE_KEY = "latest_valid_cycle_plan";
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

export function loadExperiencesForDecisionIds(executor: SqlExecutor, decisionIds: readonly string[], limit = MAX_HISTORY_LIMIT): TradeExperience[] {
  const requested = [...new Set(decisionIds)].filter((id) => typeof id === "string" && id.trim().length > 0 && id.length <= MAX_TARGETED_DECISION_ID_LENGTH).slice(0, MAX_HISTORY_LIMIT);
  if (requested.length === 0) return [];
  const requestedSet = new Set(requested);
  const rows = executor.sql<ExperienceRow>`
    SELECT experience.payload
    FROM experiences AS experience
    JOIN json_each(${JSON.stringify(requested)}) AS requested
      ON (CASE WHEN json_valid(experience.payload) THEN json_extract(experience.payload, '$.entryDecisionId') END) = requested.value
    ORDER BY experience.created_at DESC, experience.experience_id ASC
    LIMIT ${clampHistoryLimit(limit, MAX_HISTORY_LIMIT)}
  `;
  return rows.flatMap((row) => {
    try {
      const experience = parseExperience(JSON.parse(row.payload));
      return requestedSet.has(experience.entryDecisionId) ? [experience] : [];
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

const MAX_FALLBACK_JOURNAL_ROWS = 25;
const MAX_LOOKUP_JOURNAL_BYTES = 256 * 1024;
const MAX_FALLBACK_JSON_NODES = 20_000;

function journalContainsAnyDecisionId(payload: string, decisionIds: ReadonlySet<string>): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return false;
  }
  const pending: unknown[] = [parsed];
  let visited = 0;
  while (pending.length > 0 && visited < MAX_FALLBACK_JSON_NODES) {
    const value = pending.pop();
    visited += 1;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0 && visited + pending.length < MAX_FALLBACK_JSON_NODES; index -= 1) pending.push(value[index]);
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    for (const key in value) {
      if (visited + pending.length >= MAX_FALLBACK_JSON_NODES) break;
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      visited += 1;
      const child = (value as Record<string, unknown>)[key];
      if (key === "decisionId" && typeof child === "string" && decisionIds.has(child)) return true;
      if (typeof child === "object" && child !== null) pending.push(child);
    }
  }
  return false;
}

export function loadJournalsForDecisionIds(executor: SqlExecutor, decisionIds: readonly string[], limit = MAX_HISTORY_LIMIT): TradingJournal[] {
  const requested = [...new Set(decisionIds)].filter((id) => typeof id === "string" && id.trim().length > 0 && id.length <= MAX_TARGETED_DECISION_ID_LENGTH).slice(0, MAX_HISTORY_LIMIT);
  if (requested.length === 0) return [];
  const maxRows = Math.min(requested.length * 2, MAX_HISTORY_LIMIT * 2);
  const rows = executor.sql<JournalRow>`
    SELECT j.payload
    FROM journals AS j
    JOIN journal_decision_lookup AS indexed ON indexed.cycle_id = j.cycle_id
    JOIN json_each(${JSON.stringify(requested)}) AS requested ON requested.value = indexed.decision_id
    WHERE length(CAST(j.payload AS BLOB)) <= ${MAX_LOOKUP_JOURNAL_BYTES}
    GROUP BY j.cycle_id
    ORDER BY MAX(j.created_at) DESC, j.cycle_id
    LIMIT ${maxRows}
  `;
  const journals = new Map<string, TradingJournal>();
  for (const row of rows) {
    try {
      const journal = JSON.parse(row.payload) as TradingJournal;
      journals.set(journal.cycleId, journal);
    } catch {
      // Ignore malformed historical journal rows during bounded lookup.
    }
  }
  const resolvedIds = new Set<string>();
  const collectVerified = (journal: TradingJournal, wanted: ReadonlySet<string>): void => {
    for (const decision of cyclePlanDecisions(journal)) {
      if (wanted.has(decision.decisionId)) resolvedIds.add(decision.decisionId);
    }
    for (const record of normalizeCycleDecisions(journal).records) {
      const id = record.decision.decisionId;
      if (wanted.has(id)) resolvedIds.add(id);
    }
  };
  for (const journal of journals.values()) collectVerified(journal, new Set(requested));

  let missingIds = requested.filter((id) => !resolvedIds.has(id));
  const idempotentIds = new Set<string>();
  if (missingIds.length > 0) {
    const missingSet = new Set(missingIds);
    const exactDecisionRows = executor.sql<IdempotencyDecisionRow>`
      SELECT DISTINCT decision_id FROM idempotency
      WHERE decision_id IN (SELECT value FROM json_each(${JSON.stringify(missingIds)}))
      LIMIT ${MAX_HISTORY_LIMIT}
    `;
    for (const row of exactDecisionRows) {
      if (missingSet.has(row.decision_id)) idempotentIds.add(row.decision_id);
    }
    const exactCycleRows = executor.sql<IdempotencyDecisionCycleRow>`
      SELECT DISTINCT cycle_id FROM idempotency
      WHERE decision_id IN (SELECT value FROM json_each(${JSON.stringify(missingIds)}))
      ORDER BY cycle_id ASC
      LIMIT ${MAX_HISTORY_LIMIT * 2}
    `;
    const exactCycleIds = [...new Set(exactCycleRows.map((row) => row.cycle_id).filter((cycleId) => typeof cycleId === "string" && cycleId.length > 0))];
    if (exactCycleIds.length > 0) {
      const exactJournalRows = executor.sql<ExactJournalRow>`
        SELECT journal.cycle_id, journal.payload FROM journals AS journal
        WHERE journal.cycle_id IN (SELECT value FROM json_each(${JSON.stringify(exactCycleIds)}))
          AND length(CAST(journal.payload AS BLOB)) <= ${MAX_LOOKUP_JOURNAL_BYTES}
        ORDER BY journal.cycle_id ASC
        LIMIT ${MAX_HISTORY_LIMIT * 2}
      `;
      for (const row of exactJournalRows) {
        try {
          const journal = JSON.parse(row.payload) as TradingJournal;
          if (journal.cycleId !== row.cycle_id) continue;
          const beforeCount = resolvedIds.size;
          collectVerified(journal, missingSet);
          if (resolvedIds.size > beforeCount) journals.set(journal.cycleId, journal);
        } catch {
          // Ignore malformed historical journal rows during exact lookup.
        }
      }
    }
  }

  missingIds = requested.filter((id) => !resolvedIds.has(id) && !idempotentIds.has(id));
  if (missingIds.length > 0) {
    const missingSet = new Set(missingIds);
    const fallbackRows = executor.sql<JournalRow>`WITH recent_journals AS MATERIALIZED (SELECT cycle_id FROM journals ORDER BY created_at DESC LIMIT ${MAX_FALLBACK_JOURNAL_ROWS}) SELECT journal.payload FROM recent_journals JOIN journals AS journal USING (cycle_id) WHERE length(CAST(journal.payload AS BLOB)) <= ${MAX_LOOKUP_JOURNAL_BYTES}`;
    for (const row of fallbackRows) {
      if (!journalContainsAnyDecisionId(row.payload, missingSet)) continue;
      try {
        const journal = JSON.parse(row.payload) as TradingJournal;
        const beforeCount = resolvedIds.size;
        collectVerified(journal, missingSet);
        if (resolvedIds.size > beforeCount) journals.set(journal.cycleId, journal);
      } catch {
        // Ignore malformed historical journal rows during bounded fallback.
      }
    }
  }
  return [...journals.values()].slice(0, clampHistoryLimit(limit, MAX_HISTORY_LIMIT) * 2);
}

export function loadJournalForExactDecisionCycle(executor: SqlExecutor, cycleId: string, decisionId: string): TradingJournal | null {
  if (!cycleId.trim() || cycleId.length > 256 || !decisionId.trim() || decisionId.length > MAX_TARGETED_DECISION_ID_LENGTH) return null;
  const rows = executor.sql<ExactJournalRow>`
    SELECT cycle_id, payload FROM journals
    WHERE cycle_id = ${cycleId}
      AND length(CAST(payload AS BLOB)) <= ${MAX_LOOKUP_JOURNAL_BYTES}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  try {
    const journal = JSON.parse(row.payload) as TradingJournal;
    if (journal.cycleId !== cycleId || row.cycle_id !== cycleId) return null;
    const hasDecision = cyclePlanDecisions(journal).some((decision) => decision.decisionId === decisionId)
      || normalizeCycleDecisions(journal).records.some((record) => record.decision.decisionId === decisionId);
    return hasDecision ? journal : null;
  } catch {
    return null;
  }
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

export function loadExperienceById(executor: SqlExecutor, experienceId: string): TradeExperience | null {
  if (!experienceId || experienceId.length > 256) return null;
  const rows = executor.sql<{ experience_id: string; payload: string }>`
    SELECT experience_id, payload FROM experiences
    WHERE experience_id = ${experienceId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || row.experience_id !== experienceId) return null;
  try {
    const experience = parseExperience(JSON.parse(row.payload));
    return experience.experienceId === experienceId ? experience : null;
  } catch {
    return null;
  }
}

export function saveExperience(executor: SqlExecutor, experience: TradeExperience, createdAt: string): void {
  executor.sql`
    INSERT INTO experiences (experience_id, symbol, outcome_status, payload, created_at)
    VALUES (${experience.experienceId}, ${experience.symbol}, ${experience.outcomeStatus}, ${JSON.stringify(experience)}, ${createdAt})
    ON CONFLICT(experience_id) DO UPDATE SET payload = excluded.payload, outcome_status = excluded.outcome_status
  `;
}

export interface ExternalFlowReadModelCache {
  version: 1;
  signature: string;
  flows: VerifiedExternalFlows;
  truncated: boolean;
}

const EXTERNAL_FLOW_READ_MODEL_STATE_KEY = "external_flow_read_model_v1";

function isExternalFlowReadModelCache(value: unknown): value is ExternalFlowReadModelCache {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ExternalFlowReadModelCache>;
  return candidate.version === 1
    && typeof candidate.signature === "string"
    && typeof candidate.truncated === "boolean"
    && typeof candidate.flows === "object" && candidate.flows !== null
    && (candidate.flows.status === "VERIFIED" || candidate.flows.status === "UNVERIFIED")
    && typeof candidate.flows.netExternalInflows === "string"
    && Array.isArray(candidate.flows.unknownTypes) && candidate.flows.unknownTypes.every((type) => typeof type === "string");
}

export function loadExternalFlowReadModelCache(executor: SqlExecutor): ExternalFlowReadModelCache | null {
  const rows = executor.sql<RiskStateRow>`SELECT payload FROM risk_state WHERE state_key = ${EXTERNAL_FLOW_READ_MODEL_STATE_KEY}`;
  if (!rows[0]) return null;
  try {
    const value: unknown = JSON.parse(rows[0].payload);
    return isExternalFlowReadModelCache(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveExternalFlowReadModelCache(executor: SqlExecutor, cache: ExternalFlowReadModelCache, updatedAt: string): void {
  executor.sql`
    INSERT INTO risk_state (state_key, payload, updated_at)
    VALUES (${EXTERNAL_FLOW_READ_MODEL_STATE_KEY}, ${JSON.stringify(cache)}, ${updatedAt})
    ON CONFLICT(state_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `;
}

export interface ProviderLifecyclePerformanceReadModelCache {
  version: 1;
  semanticVersion: number;
  signature: string;
  totals: ProviderPerformanceTotals;
}

const PROVIDER_LIFECYCLE_PERFORMANCE_READ_MODEL_STATE_KEY = "provider_lifecycle_performance_v1";

function isProviderLifecyclePerformanceCache(value: unknown): value is ProviderLifecyclePerformanceReadModelCache {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ProviderLifecyclePerformanceReadModelCache>;
  const totals = candidate.totals;
  return candidate.version === 1
    && Number.isInteger(candidate.semanticVersion)
    && typeof candidate.signature === "string"
    && typeof totals === "object" && totals !== null
    && totals.source === "PROVIDER_LEDGER"
    && Number.isInteger(totals.closedTrades) && totals.closedTrades >= 0
    && Number.isInteger(totals.openTrades) && totals.openTrades >= 0
    && Number.isInteger(totals.totalTrades) && totals.totalTrades >= 0
    && Number.isInteger(totals.wins) && totals.wins >= 0
    && Number.isInteger(totals.losses) && totals.losses >= 0
    && Number.isInteger(totals.breakeven) && totals.breakeven >= 0
    && Number.isInteger(totals.unresolvedClosedLifecycles) && totals.unresolvedClosedLifecycles >= 0
    && typeof totals.closedEpisodeRealizedPnl === "string"
    && typeof totals.verifiedRealizedPnl === "string"
    && typeof totals.dailyPnl === "object" && totals.dailyPnl !== null;
}

export function loadProviderLifecyclePerformanceReadModelCache(executor: SqlExecutor): ProviderLifecyclePerformanceReadModelCache | null {
  const rows = executor.sql<RiskStateRow>`SELECT payload FROM risk_state WHERE state_key = ${PROVIDER_LIFECYCLE_PERFORMANCE_READ_MODEL_STATE_KEY}`;
  if (!rows[0]) return null;
  try {
    const value: unknown = JSON.parse(rows[0].payload);
    return isProviderLifecyclePerformanceCache(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveProviderLifecyclePerformanceReadModelCache(executor: SqlExecutor, cache: ProviderLifecyclePerformanceReadModelCache, updatedAt: string): void {
  executor.sql`
    INSERT INTO risk_state (state_key, payload, updated_at)
    VALUES (${PROVIDER_LIFECYCLE_PERFORMANCE_READ_MODEL_STATE_KEY}, ${JSON.stringify(cache)}, ${updatedAt})
    ON CONFLICT(state_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
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

function isCycleDecisionPlan(value: unknown): value is CycleDecisionPlan {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Array.isArray((value as { positionActions?: unknown }).positionActions)
    && Array.isArray((value as { entryActions?: unknown }).entryActions);
}

function isLatestValidCyclePlan(value: unknown): value is LatestValidCyclePlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<LatestValidCyclePlan>;
  return typeof candidate.cycleId === "string"
    && isCycleDecisionPlan(candidate.plan)
    && typeof candidate.startedAt === "string"
    && typeof candidate.completedAt === "string";
}

export function loadLatestValidCyclePlan(executor: SqlExecutor): LatestValidCyclePlan | null {
  const rows = executor.sql<RiskStateRow>`SELECT payload FROM risk_state WHERE state_key = ${LATEST_VALID_CYCLE_PLAN_STATE_KEY}`;
  if (!rows[0]) return null;
  try {
    const value: unknown = JSON.parse(rows[0].payload);
    return isLatestValidCyclePlan(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveLatestValidCyclePlan(executor: SqlExecutor, readModel: LatestValidCyclePlan): void {
  executor.sql`
    INSERT INTO risk_state (state_key, payload, updated_at)
    VALUES (${LATEST_VALID_CYCLE_PLAN_STATE_KEY}, ${JSON.stringify(readModel)}, ${readModel.completedAt})
    ON CONFLICT(state_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `;
}

export function loadLatestCompletedCyclePlanFromHistory(executor: SqlExecutor): LatestValidCyclePlan | null {
  const rows = executor.sql<CompletedCyclePlanRow>`
    SELECT c.cycle_id, c.status, c.started_at, c.completed_at, j.payload
    FROM cycles AS c
    INNER JOIN journals AS j ON j.cycle_id = c.cycle_id
    WHERE c.status = 'COMPLETED'
    ORDER BY c.completed_at DESC, c.cycle_id DESC
    LIMIT 50
  `;
  for (const row of rows) {
    if (row.status !== "COMPLETED" || !row.completed_at) continue;
    let journal: TradingJournal;
    try {
      journal = JSON.parse(row.payload) as TradingJournal;
    } catch {
      continue;
    }
    if (!journalHasPersistedPlan(journal)) continue;
    const normalized = normalizeCycleDecisions(journal);
    return { cycleId: journal.cycleId, plan: normalized.plan, ...(normalized.discovery ? { discovery: normalized.discovery } : {}), startedAt: row.started_at, completedAt: row.completed_at };
  }
  return null;
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

export function loadPositionContextsForKeys(executor: SqlExecutor, contextKeys: readonly string[], limit = MAX_HISTORY_LIMIT): Map<string, PositionContext> {
  const maxContextKeys = MAX_HISTORY_LIMIT * 4;
  const keys = [...new Set(contextKeys)].filter((key) => typeof key === "string" && key.trim().length > 0 && key.length <= 80).slice(0, maxContextKeys);
  if (keys.length === 0) return new Map();
  const rows = executor.sql<PositionContextRow & { context_key: string }>`
    SELECT context_key, payload FROM position_context
    WHERE context_key IN (SELECT value FROM json_each(${JSON.stringify(keys)}))
    ORDER BY updated_at DESC LIMIT ${Math.min(Number.isInteger(limit) && limit > 0 ? limit : maxContextKeys, maxContextKeys)}
  `;
  const contexts = new Map<string, PositionContext>();
  for (const row of rows) {
    try {
      contexts.set(row.context_key, JSON.parse(row.payload) as PositionContext);
    } catch {
      // Ignore malformed contexts while loading bounded history reasoning.
    }
  }
  return contexts;
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

export function hasEvent(executor: SqlExecutor, eventId: string): boolean {
  return executor.sql<{ event_id: string }>`SELECT event_id FROM events WHERE event_id = ${eventId} LIMIT 1`.length > 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function persistProviderLifecycleRepair(
  executor: SqlExecutor,
  transactionSync: <T>(closure: () => T) => T,
  expectedExperience: TradeExperience,
  expectedContext: PositionContext,
  experience: TradeExperience,
  context: PositionContext,
  event: ActivityEvent,
): boolean {
  return transactionSync(() => {
    if (hasEvent(executor, event.eventId)) return false;
    const experienceRows = executor.sql<ExperienceRow>`SELECT payload FROM experiences WHERE experience_id = ${expectedExperience.experienceId}`;
    const currentExperience = experienceRows[0] ? JSON.parse(experienceRows[0].payload) as TradeExperience : null;
    if (experienceRows.length !== 1 || canonicalJson(currentExperience) !== canonicalJson(expectedExperience) || currentExperience?.outcomeStatus !== "OPEN") {
      throw new Error("PROVIDER_LIFECYCLE_REPAIR_CONFLICT");
    }
    const contextKey = `${expectedContext.symbol}:${expectedContext.positionSide}`;
    const contextRows = executor.sql<PositionContextRow>`SELECT payload FROM position_context WHERE context_key = ${contextKey}`;
    const currentContext = contextRows[0] ? JSON.parse(contextRows[0].payload) as PositionContext : null;
    if (contextRows.length !== 1 || canonicalJson(currentContext) !== canonicalJson(expectedContext)) throw new Error("POSITION_CONTEXT_CHANGED_DURING_REPAIR");
    saveExperience(executor, experience, event.createdAt);
    savePositionContext(executor, context);
    saveEvent(executor, event);
    return true;
  });
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

export function loadEventById(executor: SqlExecutor, eventId: string): ActivityEvent | undefined {
  if (!eventId || eventId.length > 512) return undefined;
  const rows = executor.sql<EventRow>`
    SELECT event_id, event_type, cycle_id, payload, created_at FROM events
    WHERE event_id = ${eventId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || row.event_id !== eventId) return undefined;
  try {
    const event = JSON.parse(row.payload) as ActivityEvent;
    const result = {
      eventId: event.eventId || row.event_id,
      type: event.type || row.event_type,
      cycleId: event.cycleId || row.cycle_id,
      createdAt: event.createdAt || row.created_at,
      ...(event.metadata ? { metadata: event.metadata } : {}),
    };
    return result.eventId === eventId ? result : undefined;
  } catch {
    return undefined;
  }
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

export function recordProviderOrderReference(executor: SqlExecutor, clientOrderId: string, providerOrderId: string): void {
  executor.sql`
    UPDATE idempotency
    SET provider_order_id = ${providerOrderId}
    WHERE client_order_id = ${clientOrderId}
  `;
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
