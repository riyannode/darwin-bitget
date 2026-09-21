import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
vi.mock("agents", () => ({ Agent: class {}, routeAgentRequest: vi.fn() }));
import { z } from "zod";
import { failureDiagnostic, TraderAgent } from "../src/agent/agent.js";
import { QwenJsonError } from "../src/agent/qwen.js";
import { cycleReadModel } from "../src/storage/journal-normalizer.js";
import { loadLatestCompletedCyclePlanFromHistory, loadLatestValidCyclePlan, saveCycle, saveJournal, saveLatestValidCyclePlan } from "../src/storage/store.js";
import type { SqlExecutor } from "../src/storage/schema.js";
import type { CycleDecisionPlan, Decision, TradingJournal } from "../src/types.js";

const baseJournal = {
  cycleId: "cycle-failed",
  agentVersion: "0.2.0",
  promptVersion: "darwin-mandate-v6",
  model: "qwen3.8-max",
  mode: "AUTONOMOUS",
  startedAt: "2026-09-14T12:00:00.000Z",
  retrievedLessons: [],
  createdLessons: [],
} as unknown as TradingJournal;

const policy = {
  paperOnly: true,
  maxSinglePositionMarginPct: "30",
  maxLeverage: "5",
  maxDailyDrawdownPct: "10",
  drawdownCooldownMinutes: 60,
  scanIntervalMinutes: 15,
  emergencyStop: false,
};

const hold = {
  decisionId: "hold-1",
  cycleId: "cycle-completed",
  action: "HOLD",
  positionSide: "LONG",
  symbol: "CRCLUSDT",
  marginAllocationPct: "0",
  leverage: "3",
  reductionPct: null,
  confidence: 0.8,
  thesis: "Hold the existing long.",
  strategyThesis: "The current evidence supports continuation.",
  supportingFactors: ["Support holds."],
  riskFactors: ["Range risk."],
  evidenceUsed: ["Provider evidence."],
  lessonsUsed: [],
  createdAt: "2026-09-14T12:05:00.000Z",
} as unknown as Decision;

describe("cycle status read model", () => {
  it("does not turn a failed pre-decision cycle into a valid zero-action plan", () => {
    const failed = cycleReadModel(baseJournal, "FAILED", "ZOD_VALIDATION_FAILED");
    expect(failed.status).toBe("FAILED");
    expect(failed.hasPersistedPlan).toBe(false);
    expect(failed.hasValidPlan).toBe(false);
    expect(failed.plan.positionActions).toHaveLength(0);
    expect(failed.plan.entryActions).toHaveLength(0);

    const completed = cycleReadModel({ ...baseJournal, cycleId: "cycle-completed", cyclePlan: { positionActions: [hold], entryActions: [] } } as TradingJournal, "COMPLETED");
    expect(completed.status).toBe("COMPLETED");
    expect(completed.hasValidPlan).toBe(true);
    expect(completed.plan.positionActions).toHaveLength(1);
    expect(completed.plan.positionActions[0]?.action).toBe("HOLD");
  });

  it("keeps a failed persisted plan as audit evidence but not as the primary valid plan", () => {
    const failed = cycleReadModel({ ...baseJournal, cyclePlan: { positionActions: [hold], entryActions: [] } } as TradingJournal, "FAILED", "RUNTIME_ERROR");
    expect(failed.hasPersistedPlan).toBe(true);
    expect(failed.hasValidPlan).toBe(false);
    expect(failed.plan.positionActions[0]?.action).toBe("HOLD");

    const completed = cycleReadModel({ ...baseJournal, cycleId: "cycle-completed", cyclePlan: { positionActions: [hold], entryActions: [] } } as TradingJournal, "COMPLETED");
    expect(completed.hasPersistedPlan).toBe(true);
    expect(completed.hasValidPlan).toBe(true);
  });

  it("renders failed cycles separately and preserves the last valid plan contract", () => {
    const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
    expect(dashboard).toContain("CYCLE FAILED BEFORE DECISION");
    expect(dashboard).toContain("CYCLE FAILED AFTER PLAN CREATION");
    expect(dashboard).toContain("Decision plan not produced.");
    expect(dashboard).toContain("const actionCount = cycle.hasPersistedPlan ? cycle.plan.positionActions.length + cycle.plan.entryActions.length : \"UNAVAILABLE\"");
    expect(dashboard).toContain("FAILED-CYCLE AUDIT EVIDENCE");
    expect(dashboard).toContain("const validCycle = snapshot.cyclePlans.find((cycle) => cycle.status === \"COMPLETED\" && cycle.hasValidPlan)");
    expect(dashboard).toContain("No valid cycle plan recorded yet.");
  });

  it("loads the compact latest valid plan without depending on recent journal depth", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE risk_state (state_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)");
    const queries: string[] = [];
    const executor: SqlExecutor = {
      sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) {
        const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
        queries.push(query);
        const sqliteValues = values.map((value) => typeof value === "boolean" ? (value ? 1 : 0) : value) as (string | number | null)[];
        if (query.trimStart().startsWith("SELECT")) return db.prepare(query).all(...sqliteValues) as T[];
        db.prepare(query).run(...sqliteValues);
        return [];
      },
    };
    const plan = { positionActions: [hold], entryActions: [] } as unknown as CycleDecisionPlan;
    saveLatestValidCyclePlan(executor, { cycleId: "cycle-completed", plan, startedAt: baseJournal.startedAt, completedAt: "2026-09-14T12:06:00.000Z" });
    queries.length = 0;
    expect(loadLatestValidCyclePlan(executor)).toMatchObject({ cycleId: "cycle-completed", plan });
    expect(queries).toEqual(["SELECT payload FROM risk_state WHERE state_key = ?"]);
  });

  it("uses the compact completed plan after thirty newer failed cycles", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE cycles (cycle_id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT)");
    db.exec("CREATE TABLE journals (cycle_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.exec("CREATE TABLE risk_state (state_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)");
    db.exec("CREATE TABLE events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, cycle_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)");
    const executor: SqlExecutor = {
      sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) {
        const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
        const sqliteValues = values.map((value) => typeof value === "boolean" ? (value ? 1 : 0) : value) as (string | number | null)[];
        if (query.trimStart().startsWith("SELECT")) return db.prepare(query).all(...sqliteValues) as T[];
        db.prepare(query).run(...sqliteValues);
        return [];
      },
    };
    const plan = { positionActions: [hold], entryActions: [] } as unknown as CycleDecisionPlan;
    saveJournal(executor, { ...baseJournal, cycleId: "cycle-completed", startedAt: "2026-09-14T11:00:00.000Z", completedAt: "2026-09-14T11:01:00.000Z", cyclePlan: plan } as TradingJournal);
    saveCycle(executor, "cycle-completed", "COMPLETED", "2026-09-14T11:00:00.000Z", "2026-09-14T11:01:00.000Z");
    saveLatestValidCyclePlan(executor, { cycleId: "cycle-completed", plan, startedAt: "2026-09-14T11:00:00.000Z", completedAt: "2026-09-14T11:01:00.000Z" });
    for (let index = 0; index < 30; index += 1) {
      const cycleId = `cycle-failed-${index}`;
      const startedAt = `2026-09-14T${String(12 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`;
      saveJournal(executor, { ...baseJournal, cycleId, startedAt } as TradingJournal);
      saveCycle(executor, cycleId, "FAILED", startedAt, startedAt);
    }
    const fake = {
      env: { TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true", EVIDENCE_MAX_AGE_SECONDS: "90", BITGET_CATEGORY: "USDT-FUTURES" },
      state: { runtimeStatus: "ONLINE", currentStage: "ONLINE", lastScanAt: null, nextScanAt: null, model: "qwen", temporaryScanIntervalExpiresAt: null, temporaryScanIntervalCompleted: true, paused: true, emergencyStop: false, lastStatus: "IDLE", cycleStartedAt: null },
      ensureActivePolicy: () => policy,
      activeScanIntervalMinutes: () => 15,
      getSchedulerDiagnostics: async () => ({ nextScanAt: null, nextScanStale: true, configuredIntervalMinutes: 15, matchingScheduleCount: 0, schedulerHealthy: true }),
      sql: executor.sql,
    };
    const snapshot = await TraderAgent.prototype.getDashboardSnapshot.call(fake as never);
    expect(snapshot.latestCyclePlan).toMatchObject({ positionActions: [{ action: "HOLD", symbol: "CRCLUSDT" }] });
    expect(snapshot.latestCycleStatus).toMatchObject({ cycleId: "cycle-failed-29", status: "FAILED", hasPersistedPlan: false, hasValidPlan: false });
  });

  it("backfills from a bounded completed-cycle join and ignores failed cycles", () => {
    const queries: string[] = [];
    const cyclePlanJournal = { ...baseJournal, cycleId: "cycle-plan", completedAt: "2026-09-14T12:10:00.000Z", cyclePlan: { positionActions: [hold], entryActions: [] } } as TradingJournal;
    const legacyJournal = { ...baseJournal, cycleId: "cycle-legacy", completedAt: "2026-09-14T12:09:00.000Z", decision: hold } as TradingJournal;
    const executor: SqlExecutor = {
      sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) {
        const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
        queries.push(query);
        if (!query.includes("JOIN journals")) throw new Error("UNBOUNDED_HISTORY_READ");
        return [
          { cycle_id: "cycle-failed", status: "FAILED", started_at: "2026-09-14T12:11:00.000Z", completed_at: "2026-09-14T12:11:30.000Z", payload: JSON.stringify({ ...baseJournal, cycleId: "cycle-failed", startedAt: "2026-09-14T12:11:00.000Z", completedAt: "2026-09-14T12:11:30.000Z", cyclePlan: { positionActions: [], entryActions: [] } }) },
          { cycle_id: cyclePlanJournal.cycleId, status: "COMPLETED", started_at: cyclePlanJournal.startedAt, completed_at: cyclePlanJournal.completedAt, payload: JSON.stringify(cyclePlanJournal) },
          { cycle_id: legacyJournal.cycleId, status: "COMPLETED", started_at: legacyJournal.startedAt, completed_at: legacyJournal.completedAt, payload: JSON.stringify(legacyJournal) },
        ] as T[];
      },
    };
    const result = loadLatestCompletedCyclePlanFromHistory(executor);
    expect(result).toMatchObject({ cycleId: "cycle-plan", plan: { positionActions: [{ action: "HOLD" }] } });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("c.status = 'COMPLETED'");
    expect(queries[0]).toContain("ORDER BY c.completed_at DESC");
    expect(queries[0]).toContain("LIMIT 50");
  });

  it("backfills a legacy decision plan from the same bounded lookup", () => {
    const legacyJournal = { ...baseJournal, cycleId: "cycle-legacy", completedAt: "2026-09-14T12:09:00.000Z", decision: hold } as TradingJournal;
    const executor: SqlExecutor = {
      sql<T>(strings: TemplateStringsArray) {
        const query = strings.join("");
        if (!query.includes("JOIN journals")) throw new Error("UNBOUNDED_HISTORY_READ");
        return [{ cycle_id: legacyJournal.cycleId, status: "COMPLETED", started_at: legacyJournal.startedAt, completed_at: legacyJournal.completedAt, payload: JSON.stringify(legacyJournal) }] as T[];
      },
    };
    expect(loadLatestCompletedCyclePlanFromHistory(executor)).toMatchObject({ cycleId: "cycle-legacy", plan: { positionActions: [{ action: "HOLD" }] } });
  });
});

describe("safe failure diagnostics", () => {
  it("persists Qwen JSON_PARSE as a structured safe diagnostic field", () => {
    const diagnostic = failureDiagnostic(new QwenJsonError("QWEN_INVALID_JSON", { finishReason: "stop", textLength: 20, inputTokens: 10, outputTokens: 5, hasOpeningBrace: true, hasClosingBrace: true, parserStage: "JSON_PARSE" }));
    expect(diagnostic).toMatchObject({ category: "RUNTIME_ERROR", code: "QWEN_INVALID_JSON", parserStage: "JSON_PARSE" });
    expect(JSON.stringify(diagnostic)).not.toContain("model output");
  });

  it("persists Qwen RESPONSE_JSON_EXTRACTION as a structured safe diagnostic field", () => {
    const diagnostic = failureDiagnostic(new QwenJsonError("QWEN_INVALID_JSON", { finishReason: "stop", textLength: 8, hasOpeningBrace: false, hasClosingBrace: false, parserStage: "RESPONSE_JSON_EXTRACTION" }));
    expect(diagnostic).toMatchObject({ category: "RUNTIME_ERROR", code: "QWEN_INVALID_JSON", parserStage: "RESPONSE_JSON_EXTRACTION" });
  });

  it("keeps multiline Zod issues structured and bounded", () => {
    const schema = z.object({ positionActions: z.array(z.object({ marginAllocationPct: z.literal("0") })) });
    const result = schema.safeParse({ positionActions: [{ marginAllocationPct: "10" }] });
    if (result.success) throw new Error("expected schema failure");
    const diagnostic = failureDiagnostic(result.error);
    expect(diagnostic).toMatchObject({
      category: "ZOD_VALIDATION_FAILED",
      code: "ZOD_VALIDATION_FAILED",
      issueCount: "1",
      firstIssuePath: "positionActions.0.marginAllocationPct",
    });
    expect(diagnostic.firstIssueMessage).not.toContain("[ { \"code\"");
    expect(Object.values(diagnostic).every((value) => value.length <= 240)).toBe(true);
  });

  it("does not persist raw prompt or secret material in ordinary errors", () => {
    const diagnostic = failureDiagnostic(new Error("QWEN_REQUEST_FAILED: system message prompt Bearer super-secret-token"));
    expect(diagnostic).toEqual({ category: "RUNTIME_ERROR", code: "QWEN_REQUEST_FAILED", message: "Runtime error" });
    expect(JSON.stringify(diagnostic)).not.toContain("super-secret-token");
    expect(JSON.stringify(diagnostic)).not.toContain("system message prompt");
  });

  it("bounds Zod diagnostics and keeps only the first three issues", () => {
    const error = new z.ZodError([
      { code: "custom", path: ["a"], message: "first" },
      { code: "custom", path: ["b"], message: "second" },
      { code: "custom", path: ["c"], message: "third" },
      { code: "custom", path: ["d"], message: "fourth" },
    ]);
    const diagnostic = failureDiagnostic(error);
    expect(diagnostic.issueCount).toBe("4");
    expect(diagnostic.issue4Path).toBeUndefined();
    expect(diagnostic.issue3Path).toBe("c");
    expect(JSON.stringify(diagnostic).length).toBeLessThan(1200);
  });
});
