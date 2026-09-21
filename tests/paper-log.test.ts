import { describe, expect, it } from "vitest";
import { buildPaperLogExport, calculatePeakDrawdown, paperLogToCsv, parsePaperLogPeriod, PAPER_LOG_SCHEMA_VERSION } from "../src/storage/paper-log.js";
import type { ActivityEvent, Decision, DecisionExecutionRecord, ExecutionResult, ReconciliationResult, TradeExperience, TradingJournal } from "../src/types.js";

function decision(cycleId: string, action: Decision["action"], decisionId: string, createdAt: string): Decision {
  return { decisionId, cycleId, action, positionSide: action === "OPEN_LONG" || action === "CLOSE" ? "LONG" : null, symbol: "NVDAUSDT", marginAllocationPct: action === "HOLD" ? "0" : "1", leverage: "1", reductionPct: action === "CLOSE" ? null : null, confidence: 0.5, thesis: "bounded thesis", strategyThesis: "bounded strategy thesis", supportingFactors: ["volume"], riskFactors: ["volatility"], evidenceUsed: ["ticker"], lessonsUsed: [], createdAt };
}

function journal(index: number, action: Decision["action"]): TradingJournal {
  const cycleId = `cycle-${index}`;
  const createdAt = new Date(Date.UTC(2026, 8, 12, 0, index)).toISOString();
  const current = decision(cycleId, action, `decision-${index}`, createdAt);
  return { cycleId, agentVersion: "0.2.0", model: "qwen3.8-max", mode: "AUTONOMOUS", startedAt: createdAt, completedAt: createdAt, retrievedLessons: [], decision: current, createdLessons: [], durationMs: 1000 };
}

function experience(): TradeExperience {
  return { experienceId: "experience-1", symbol: "NVDAUSDT", positionSide: "LONG", action: "OPEN_LONG", entryDecisionId: "decision-1", entryPrice: "100", entryTime: "2026-09-12T00:01:00.000Z", exitDecisionId: "decision-2", exitPrice: "99", exitTime: "2026-09-12T00:02:00.000Z", selectedLeverage: "1", marginAllocationPct: "1", marginAllocated: "10", positionNotional: "10", realizedPnl: "-0.0456", realizedPnlPct: "-0.456", maximumFavorableExcursion: "0", maximumAdverseExcursion: "-0.0456", drawdownContribution: "-0.0456", liquidationDistance: "0", entryThesis: "entry", exitThesis: "exit", evidenceAtEntry: ["ticker"], evidenceAtExit: ["ticker"], lessonsUsed: [], marketContext: "RANGE_LOW_VOL", outcomeStatus: "LOSING", realizedPnlVerified: true };
}

function failedExecution(): ExecutionResult {
  return { provider: "bitget", clientOrderId: "paper-test", symbol: "NVDAUSDT", action: "OPEN_LONG", positionSide: "LONG", providerSide: "buy", tradeSide: "open", marginAllocated: "10", leverage: "1", positionNotional: "10", requestedQuantity: "0.01", executedQuantity: "0", status: "unknown", submittedAt: "2026-09-12T00:01:00.000Z", readBackAt: "2026-09-12T00:01:01.000Z", providerOperation: "placeOrder", providerCode: "40010", providerMessage: "ORDER_REJECTED", providerReadbackCode: "ORDER_NOT_FOUND", providerReadbackMessage: "READBACK_EMPTY" };
}

function matchedExecution(action: "OPEN_LONG" | "CLOSE" = "OPEN_LONG"): ExecutionResult {
  return { ...failedExecution(), action, tradeSide: action === "OPEN_LONG" ? "open" : "close", status: "filled", executedQuantity: "0.01", providerOrderId: "order-matched", averageFillPrice: "100", ...(action === "CLOSE" ? { realizedPnl: "1.25" } : {}) };
}

function matchedReconciliation(execution: ExecutionResult): ReconciliationResult {
  return { status: "MATCHED", codes: ["POSITION_MATCHED"], execution, ...(execution.realizedPnl ? { realizedPnl: execution.realizedPnl } : {}) };
}

describe("paper log export", () => {
  it("separates closed episode PnL from verified partial reductions", () => {
    const closes = ["-64.857", "-18.173", "73.6127", "-21.1194"];
    const closedExperiences = closes.map((pnl, index) => ({ ...experience(), experienceId: `closed-${index}`, realizedPnl: pnl, outcomeStatus: pnl === "73.6127" ? "PROFITABLE" as const : "LOSING" as const, entryDecisionId: `entry-${index}`, exitDecisionId: `exit-${index}` }));
    const partial = { ...experience(), experienceId: "partial-coin", symbol: "COINUSDT", realizedPnl: "3.1374", outcomeStatus: "OPEN" as const, entryDecisionId: "partial-entry", exitDecisionId: "", exitTime: "" };
    const allExperiences = [...closedExperiences, partial];
    const reduceDecision = { ...decision("partial-cycle", "REDUCE", "partial-reduce", "2026-09-19T19:00:00.000Z"), symbol: "COINUSDT", positionSide: "LONG" as const };
    const reduceExecution = { ...matchedExecution("CLOSE"), action: "REDUCE" as const, tradeSide: "close" as const, symbol: "COINUSDT", positionSide: "LONG" as const, realizedPnl: "3.1374" };
    const reduceJournal = { ...journal(99, "REDUCE"), cycleId: "partial-cycle", decision: reduceDecision, executionResult: reduceExecution, reconciliationResult: matchedReconciliation(reduceExecution), experienceIds: [partial.experienceId] };
    const journals = allExperiences.slice(0, -1).map((item, index) => ({ ...journal(index, "OPEN_LONG"), experienceIds: [item.experienceId] })).concat(reduceJournal);
    const exported = buildPaperLogExport({ generatedAt: "2026-09-19T20:00:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.3.0", commit: "abc123", cycles: journals.map((entry) => ({ cycleId: entry.cycleId, status: "COMPLETED", startedAt: entry.startedAt, completedAt: entry.completedAt ?? null })), journals, experiences: allExperiences, events: [] });
    expect(exported.summary.closedTrades).toMatchObject({ total: 4, wins: 1, losses: 3, breakeven: 0, realizedPnl: "-30.5367", closedEpisodeRealizedPnl: "-30.5367", openEpisodePartialRealizedPnl: "3.1374", verifiedRealizedPnl: "-27.3993" });
    expect(exported.closedTrades).toHaveLength(4);
    const csv = paperLogToCsv(exported);
    expect(csv).toContain("closedEpisodeRealizedPnl,openEpisodePartialRealizedPnl,verifiedRealizedPnl");
    expect(csv).toContain("-30.5367");
  });

  it("uses classified closed episodes rather than total closed rows for CSV win rate", () => {
    const win = { ...experience(), experienceId: "win", outcomeStatus: "PROFITABLE" as const, realizedPnl: "1" };
    const unclassified = { ...experience(), experienceId: "unclassified", outcomeStatus: "CLOSED_UNCLASSIFIED" as const, realizedPnl: "0", realizedPnlVerified: false };
    const journals = [win, unclassified].map((item, index) => ({ ...journal(index, "OPEN_LONG"), experienceIds: [item.experienceId] }));
    const exported = buildPaperLogExport({ generatedAt: "2026-09-19T20:00:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen", version: "1", commit: "abc", cycles: journals.map((entry) => ({ cycleId: entry.cycleId, status: "COMPLETED", startedAt: entry.startedAt, completedAt: entry.completedAt ?? null })), journals, experiences: [win, unclassified], events: [] });
    expect(exported.summary.closedTrades).toMatchObject({ total: 2, classifiedClosedTrades: 1, winRatePct: "100" });
    expect(paperLogToCsv(exported)).toContain(",1,100\r\n");
  });
  it("calculates peak-to-trough drawdown after a new peak", () => {
    expect(calculatePeakDrawdown(["10000", "10500", "10100"])).toEqual({ current: "-3.80952381", maximum: "-3.80952381" });
  });

  it("keeps the worst drawdown after a partial recovery", () => {
    expect(calculatePeakDrawdown(["10000", "9000", "9500"])).toEqual({ current: "-5.00000000", maximum: "-10.00000000" });
  });

  it("reports zero drawdown for monotonic rising equity", () => {
    expect(calculatePeakDrawdown(["10000", "10500", "11000"])).toEqual({ current: "0.00000000", maximum: "0.00000000" });
  });

  it("emits judge-facing schema version and pretty-printed JSON", () => {
    const exported = buildPaperLogExport({
      generatedAt: "2026-09-12T00:03:00.000Z",
      period: { start: null, end: null },
      environment: "test",
      model: "qwen3.8-max",
      version: "0.3.0",
      commit: "abc123def456",
      cycles: [{ cycleId: "cycle-1", status: "COMPLETED", startedAt: "2026-09-12T00:00:00.000Z", completedAt: "2026-09-12T00:01:00.000Z" }],
      journals: [journal(1, "HOLD")],
      experiences: [],
      events: [],
    });
    expect(exported.schemaVersion).toBe(PAPER_LOG_SCHEMA_VERSION);
    expect(exported.export.commit).toBe("abc123def456");
    expect(exported.export.commitStatus).toBe("AVAILABLE");
    const serialized = JSON.stringify(exported, null, 2);
    expect(serialized).toContain("\n");
    expect(serialized).toContain("  ");
    const parsed = JSON.parse(serialized);
    expect(parsed.schemaVersion).toBe(PAPER_LOG_SCHEMA_VERSION);
    expect(parsed.summary.cycles.total).toBe(1);
  });

  it("marks commit as UNAVAILABLE for unknown or local placeholders", () => {
    const exported = buildPaperLogExport({
      generatedAt: "2026-09-12T00:03:00.000Z",
      period: { start: null, end: null },
      environment: "test",
      model: "qwen3.8-max",
      version: "0.3.0",
      commit: "unknown",
      cycles: [{ cycleId: "cycle-1", status: "COMPLETED", startedAt: "2026-09-12T00:00:00.000Z", completedAt: "2026-09-12T00:01:00.000Z" }],
      journals: [journal(1, "HOLD")],
      experiences: [],
      events: [],
    });
    expect(exported.export.commit).toBe(null);
    expect(exported.export.commitStatus).toBe("UNAVAILABLE");
  });

  it("exports full autonomous history, including HOLD, while excluding non-autonomous journals", () => {
    const journals = Array.from({ length: 30 }, (_, index) => journal(index, index === 0 ? "HOLD" : "OPEN_LONG"));
    const manual = { ...journal(31, "OPEN_LONG"), cycleId: "manual-test" , mode: "EVA_EVALUATION" as const };
    const events: ActivityEvent[] = journals.map((entry) => ({ eventId: `event-${entry.cycleId}`, type: "CYCLE_COMPLETED", cycleId: entry.cycleId, createdAt: entry.startedAt }));
    const autonomousJournals = journals.map((entry, index) => index === 1 ? { ...entry, experienceIds: ["experience-1"] } : entry);
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.2.0", commit: "abc123", cycles: autonomousJournals.concat(manual).map((entry) => ({ cycleId: entry.cycleId, status: "COMPLETED", startedAt: entry.startedAt, completedAt: entry.completedAt ?? null })), journals: [...autonomousJournals, manual], experiences: [experience()], events });

    expect(exported.cycles).toHaveLength(30);
    expect(exported.decisions).toHaveLength(30);
    expect(exported.summary.decisions.HOLD).toBe(1);
    expect(exported.experiences[0]?.realizedPnl).toBe("-0.0456");
    expect(JSON.stringify(exported)).not.toContain("manual-test");
    expect(exported.summary.cycles.total).toBe(30);
    expect(exported.summary.cycles.completed).toBe(30);
    expect(exported.summary.cycles.failed).toBe(0);
    expect(exported.summary.executions.verified).toBe(0);
    expect(exported.closedTrades.length).toBe(1);
    expect(exported.recentWindow.size).toBe(25);
    expect(exported.recentWindow.completed).toBe(25);
  });

  it("produces a flattened CSV with decision and execution fields", () => {
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.2.0", commit: "abc123", cycles: [{ cycleId: "cycle-1", status: "COMPLETED", startedAt: "2026-09-12T00:00:00.000Z", completedAt: "2026-09-12T00:01:00.000Z" }], journals: [journal(1, "HOLD")], experiences: [], events: [] });
    const csv = paperLogToCsv(exported);

    expect(csv).toContain("cycleId,cycleStatus");
    expect(csv).toContain("decision-1");
    expect(csv).toContain("HOLD");
    expect(csv).not.toContain("apiKey");
    expect(csv).not.toContain("passphrase");
  });

  it("exports provider diagnostics in JSON and CSV", () => {
    const base = journal(1, "OPEN_LONG");
    const current = { ...base, executionRequest: { cycleId: base.cycleId, decisionId: "decision-1", symbol: "NVDAUSDT", action: "OPEN_LONG" as const, positionSide: "LONG" as const, providerSide: "buy" as const, tradeSide: "open" as const, marginAllocated: "10", leverage: "1", positionNotional: "10", reductionPct: null, quantity: "0.01", clientOrderId: "paper-test" }, executionResult: failedExecution() };
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.2.0", commit: "abc123", cycles: [{ cycleId: base.cycleId, status: "COMPLETED", startedAt: base.startedAt, completedAt: base.completedAt ?? null }], journals: [current], experiences: [], events: [] });
    expect(exported.decisions[0]?.executionResult).toMatchObject({ providerOperation: "placeOrder", providerCode: "40010", providerMessage: "ORDER_REJECTED", providerReadbackCode: "ORDER_NOT_FOUND", providerReadbackMessage: "READBACK_EMPTY" });
    const csv = paperLogToCsv(exported);
    expect(csv).toContain("providerOperation");
    expect(csv).toContain("placeOrder");
    expect(csv).toContain("ORDER_REJECTED");
  });

  it("uses legacy primary execution and reconciliation fallback for provider verification", () => {
    const execution = matchedExecution();
    const current = { ...journal(1, "OPEN_LONG"), executionResult: execution, reconciliationResult: matchedReconciliation(execution) };
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.2.0", commit: "abc123", cycles: [{ cycleId: current.cycleId, status: "COMPLETED", startedAt: current.startedAt, completedAt: current.completedAt ?? null }], journals: [current], experiences: [], events: [] });
    expect(exported.decisions[0]?.providerVerified).toBe(true);
    expect(exported.summary.executions.verified).toBe(1);
    expect(exported.summary.executions.unresolved).toBe(0);
    expect(exported.verifiedExecutions).toHaveLength(1);
    expect(exported.verifiedExecutions[0]?.symbol).toBe("NVDAUSDT");
  });

  it("keeps filled unresolved and unknown execution states unresolved", () => {
    const filled = matchedExecution();
    const unresolved = { ...journal(1, "OPEN_LONG"), executionResult: filled, reconciliationResult: { ...matchedReconciliation(filled), status: "UNKNOWN" as const } };
    const unknownExecution = failedExecution();
    const unknown = { ...journal(2, "OPEN_LONG"), executionResult: unknownExecution, reconciliationResult: { ...matchedReconciliation(unknownExecution), status: "UNKNOWN" as const } };
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.2.0", commit: "abc123", cycles: [unresolved, unknown].map((entry) => ({ cycleId: entry.cycleId, status: "COMPLETED", startedAt: entry.startedAt, completedAt: entry.completedAt ?? null })), journals: [unresolved, unknown], experiences: [], events: [] });
    expect(exported.decisions.every((entry) => entry.providerVerified === false)).toBe(true);
    expect(exported.summary.executions.verified).toBe(0);
    expect(exported.summary.executions.unresolved).toBe(2);
    expect(exported.verifiedExecutions).toHaveLength(0);
  });

  it("uses matched exit records and exports each action in a new cycle plan", () => {
    const close = decision("cycle-plan", "CLOSE", "decision-close", "2026-09-12T00:01:00.000Z");
    const hold = decision("cycle-plan", "HOLD", "decision-hold", "2026-09-12T00:01:00.000Z");
    const entry = decision("cycle-plan", "OPEN_LONG", "decision-entry", "2026-09-12T00:01:00.000Z");
    const execution = matchedExecution("CLOSE");
    const record: DecisionExecutionRecord = { decision: close, riskGateResult: { status: "PASS", codes: [], checkedAt: close.createdAt }, executionResult: execution, reconciliationResult: matchedReconciliation(execution) };
    const current: TradingJournal = { cycleId: "cycle-plan", agentVersion: "0.3.0", model: "qwen3.8-max", mode: "AUTONOMOUS", startedAt: close.createdAt, completedAt: close.createdAt, retrievedLessons: [], createdLessons: [], cyclePlan: { positionActions: [hold as NonNullable<TradingJournal["cyclePlan"]>["positionActions"][number], close as NonNullable<TradingJournal["cyclePlan"]>["positionActions"][number]], entryActions: [entry as NonNullable<TradingJournal["cyclePlan"]>["entryActions"][number]] }, executionRecords: [record] };
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.3.0", commit: "abc123", cycles: [{ cycleId: "cycle-plan", status: "COMPLETED", startedAt: current.startedAt, completedAt: current.completedAt ?? null }], journals: [current], experiences: [], events: [] });
    expect(exported.decisions).toHaveLength(3);
    expect(exported.decisions.map((entry) => entry.actionCategory)).toEqual(["POSITION_MANAGEMENT", "POSITION_MANAGEMENT", "NEW_ENTRY"]);
    expect(exported.decisions.find((entry) => entry.decisionId === "decision-close")?.providerVerified).toBe(true);
    expect(exported.decisions.find((entry) => entry.decisionId === "decision-hold")?.providerVerified).toBe(false);
    expect(exported.summary.executions.verified).toBe(1);
    expect(exported.closedTrades).toHaveLength(0);
    expect(exported.failureBreakdown.byCode).toEqual({});
    expect(exported.failureBreakdown.byStage).toEqual({});
  });

  it("preserves REVERSE as one intent while counting its two physical writes separately", () => {
    const reverse: Decision = { ...decision("cycle-reverse", "REVERSE", "decision-reverse", "2026-09-12T00:01:00.000Z"), positionSide: "LONG", targetPositionSide: "SHORT", marginAllocationPct: "10" };
    const close = matchedExecution("CLOSE");
    const open = matchedExecution("OPEN_LONG");
    const records: DecisionExecutionRecord[] = [
      { decision: { ...reverse, decisionId: "decision-reverse:close", action: "CLOSE", reductionPct: "100", marginAllocationPct: "0" }, parentDecisionId: reverse.decisionId, parentAction: "REVERSE", riskGateResult: { status: "PASS", codes: [], checkedAt: reverse.createdAt }, executionResult: close, reconciliationResult: matchedReconciliation(close) },
      { decision: { ...reverse, decisionId: "decision-reverse:open", action: "OPEN_LONG", positionSide: "SHORT", targetPositionSide: null, reductionPct: null }, parentDecisionId: reverse.decisionId, parentAction: "REVERSE", riskGateResult: { status: "PASS", codes: [], checkedAt: reverse.createdAt }, executionResult: open, reconciliationResult: matchedReconciliation(open) },
    ];
    const current: TradingJournal = { cycleId: "cycle-reverse", agentVersion: "0.3.0", model: "qwen3.8-max", mode: "AUTONOMOUS", startedAt: reverse.createdAt, completedAt: reverse.createdAt, retrievedLessons: [], createdLessons: [], cyclePlan: { positionActions: [reverse as NonNullable<TradingJournal["cyclePlan"]>["positionActions"][number]], entryActions: [] }, executionRecords: records };
    const exported = buildPaperLogExport({ generatedAt: reverse.createdAt, period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.3.0", commit: "abc123", cycles: [{ cycleId: current.cycleId, status: "COMPLETED", startedAt: current.startedAt, completedAt: current.completedAt ?? null }], journals: [current], experiences: [], events: [] });
    expect(exported.decisions).toHaveLength(1);
    expect(exported.decisions[0]?.action).toBe("REVERSE");
    expect(exported.decisions[0]?.providerVerified).toBe(false);
    expect(exported.decisions[0]?.physicalWrites).toHaveLength(2);
    expect(exported.summary.executions.verified).toBe(2);
  });

  it("surfaces failed-cycle-with-verified-write as FAILED with execution outcome metadata", () => {
    const close = decision("cycle-fail", "CLOSE", "decision-close", "2026-09-12T00:01:00.000Z");
    const execution = matchedExecution("CLOSE");
    const record: DecisionExecutionRecord = { decision: close, riskGateResult: { status: "PASS", codes: [], checkedAt: close.createdAt }, executionResult: execution, reconciliationResult: matchedReconciliation(execution) };
    const current: TradingJournal = { cycleId: "cycle-fail", agentVersion: "0.3.0", model: "qwen3.8-max", mode: "AUTONOMOUS", startedAt: close.createdAt, completedAt: close.createdAt, retrievedLessons: [], createdLessons: [], cyclePlan: { positionActions: [close as NonNullable<TradingJournal["cyclePlan"]>["positionActions"][number]], entryActions: [] }, executionRecords: [record] };
    const events: ActivityEvent[] = [
      { eventId: "ev-1", type: "CYCLE_STARTED", cycleId: "cycle-fail", createdAt: close.createdAt },
      { eventId: "ev-2", type: "PAPER_ORDER_SUBMITTED", cycleId: "cycle-fail", createdAt: close.createdAt },
      { eventId: "ev-3", type: "EXECUTION_VERIFIED", cycleId: "cycle-fail", createdAt: close.createdAt },
      { eventId: "ev-4", type: "CYCLE_FAILED", cycleId: "cycle-fail", createdAt: close.createdAt, metadata: { category: "RUNTIME_ERROR", code: "RUNTIME_ERROR" } },
    ];
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.3.0", commit: "abc123", cycles: [{ cycleId: "cycle-fail", status: "FAILED", startedAt: current.startedAt, completedAt: current.completedAt ?? null }], journals: [current], experiences: [], events });
    expect(exported.cycles[0]?.status).toBe("FAILED");
    expect(exported.cycles[0]?.failure?.code).toBe("RUNTIME_ERROR");
    expect(exported.cycles[0]?.failure?.executionOutcome).toBe("VERIFIED_WRITE_BEFORE_CYCLE_FAILURE");
    expect(exported.cycles[0]?.failure?.lastSuccessfulEvent).toBe("EXECUTION_VERIFIED");
    expect(exported.failureBreakdown.byCode.RUNTIME_ERROR).toBe(1);
    expect(exported.failureBreakdown.byStage.post_write_portfolio_refresh).toBe(1);
    expect(exported.cycles[0]?.failure?.stage).toBe("post_write_portfolio_refresh");
    expect(exported.summary.cycles.failed).toBe(1);
    expect(exported.summary.cycles.completed).toBe(0);
    expect(exported.summary.executions.verified).toBe(1);
  });

  it("derives failure breakdown with stage attribution", () => {
    const events: ActivityEvent[] = [
      { eventId: "ev-1", type: "CYCLE_STARTED", cycleId: "cycle-a", createdAt: "2026-09-12T00:00:00.000Z" },
      { eventId: "ev-2", type: "MARKET_SCAN", cycleId: "cycle-a", createdAt: "2026-09-12T00:00:01.000Z" },
      { eventId: "ev-3", type: "CYCLE_FAILED", cycleId: "cycle-a", createdAt: "2026-09-12T00:00:02.000Z", metadata: { category: "RUNTIME_ERROR", code: "RUNTIME_ERROR" } },
      { eventId: "ev-4", type: "CYCLE_STARTED", cycleId: "cycle-b", createdAt: "2026-09-12T00:00:00.000Z" },
      { eventId: "ev-5", type: "RISK_GATE_PASS", cycleId: "cycle-b", createdAt: "2026-09-12T00:00:01.000Z" },
      { eventId: "ev-6", type: "DECISION_CREATED", cycleId: "cycle-b", createdAt: "2026-09-12T00:00:02.000Z" },
      { eventId: "ev-7", type: "CYCLE_FAILED", cycleId: "cycle-b", createdAt: "2026-09-12T00:00:03.000Z", metadata: { category: "ZOD_VALIDATION_FAILED", code: "ZOD_VALIDATION_FAILED" } },
    ];
    const ja = decision("cycle-a", "HOLD", "decision-a", "2026-09-12T00:00:00.000Z");
    const jb = decision("cycle-b", "HOLD", "decision-b", "2026-09-12T00:00:00.000Z");
    const journals: TradingJournal[] = [
      { cycleId: "cycle-a", agentVersion: "0.3.0", model: "qwen3.8-max", mode: "AUTONOMOUS", startedAt: "2026-09-12T00:00:00.000Z", completedAt: "2026-09-12T00:00:02.000Z", retrievedLessons: [], decision: ja, createdLessons: [], durationMs: 2000 },
      { cycleId: "cycle-b", agentVersion: "0.3.0", model: "qwen3.8-max", mode: "AUTONOMOUS", startedAt: "2026-09-12T00:00:00.000Z", completedAt: "2026-09-12T00:00:03.000Z", retrievedLessons: [], decision: jb, createdLessons: [], durationMs: 3000 },
    ];
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.3.0", commit: "abc123", cycles: [{ cycleId: "cycle-a", status: "FAILED", startedAt: "2026-09-12T00:00:00.000Z", completedAt: "2026-09-12T00:00:02.000Z" }, { cycleId: "cycle-b", status: "FAILED", startedAt: "2026-09-12T00:00:00.000Z", completedAt: "2026-09-12T00:00:03.000Z" }], journals, experiences: [], events });
    expect(exported.failureBreakdown.byCode.RUNTIME_ERROR).toBe(1);
    expect(exported.failureBreakdown.byCode.ZOD_VALIDATION_FAILED).toBe(1);
    expect(exported.failureBreakdown.byStage.market_scan).toBe(1);
    expect(exported.failureBreakdown.byStage.decision).toBe(1);
  });

  it("uses explicit decision schema validation telemetry without treating it as the last successful event", () => {
    const current = journal(77, "HOLD");
    current.cycleId = "cycle-schema-fail";
    const events: ActivityEvent[] = [
      { eventId: "schema-1", type: "CYCLE_STARTED", cycleId: current.cycleId, createdAt: current.startedAt },
      { eventId: "schema-2", type: "MARKET_SCAN", cycleId: current.cycleId, createdAt: "2026-09-12T00:00:01.000Z" },
      { eventId: "schema-3", type: "DECISION_SCHEMA_VALIDATION_FAILED", cycleId: current.cycleId, createdAt: "2026-09-12T00:00:02.000Z", metadata: { stage: "decision_schema_validation", code: "ZOD_VALIDATION_FAILED" } },
      { eventId: "schema-4", type: "CYCLE_FAILED", cycleId: current.cycleId, createdAt: "2026-09-12T00:00:03.000Z", metadata: { category: "ZOD_VALIDATION_FAILED", code: "ZOD_VALIDATION_FAILED", stage: "decision_schema_validation" } },
    ];
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.3.0", commit: "abc123", cycles: [{ cycleId: current.cycleId, status: "FAILED", startedAt: current.startedAt, completedAt: current.completedAt ?? null }], journals: [current], experiences: [], events });
    expect(exported.cycles[0]?.failure?.stage).toBe("decision_schema_validation");
    expect(exported.cycles[0]?.failure?.lastSuccessfulEvent).toBe("MARKET_SCAN");
    expect(exported.failureBreakdown.byStage.decision_schema_validation).toBe(1);
  });

  it("sorts cycles newest first and recent window is deterministic", () => {
    const journals = Array.from({ length: 30 }, (_, index) => journal(index, "HOLD"));
    const events: ActivityEvent[] = journals.map((entry) => ({ eventId: `event-${entry.cycleId}`, type: "CYCLE_COMPLETED", cycleId: entry.cycleId, createdAt: entry.startedAt }));
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.2.0", commit: "abc123", cycles: journals.map((entry) => ({ cycleId: entry.cycleId, status: "COMPLETED", startedAt: entry.startedAt, completedAt: entry.completedAt ?? null })), journals, experiences: [], events });
    expect(exported.cycles[0]?.cycleId).toBe("cycle-29");
    expect(exported.cycles[29]?.cycleId).toBe("cycle-0");
    expect(exported.recentWindow.size).toBe(25);
    expect(exported.recentWindow.completed).toBe(25);
    expect(exported.recentWindow.start).toBe("2026-09-12T00:05:00.000Z");
    expect(exported.recentWindow.end).toBe("2026-09-12T00:29:00.000Z");
  });

  it("excludes secrets from exported JSON", () => {
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.3.0", commit: "abc123", cycles: [{ cycleId: "cycle-1", status: "COMPLETED", startedAt: "2026-09-12T00:00:00.000Z", completedAt: "2026-09-12T00:01:00.000Z" }], journals: [journal(1, "HOLD")], experiences: [], events: [] });
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("secret");
  });

  it("validates export periods deterministically", () => {
    expect(parsePaperLogPeriod("2026-09-12T00:00:00Z", "2026-09-12T01:00:00Z")).toEqual({ start: "2026-09-12T00:00:00.000Z", end: "2026-09-12T01:00:00.000Z" });
    expect(() => parsePaperLogPeriod("invalid", null)).toThrow("INVALID_EXPORT_PERIOD");
    expect(() => parsePaperLogPeriod("2026-09-12T01:00:00Z", "2026-09-12T00:00:00Z")).toThrow("INVALID_EXPORT_PERIOD");
  });

  it("classifies post_write_portfolio_refresh only when EXECUTION_VERIFIED is the last event before failure with verified-write outcome", () => {
    const close = decision("cycle-fail", "CLOSE", "decision-close", "2026-09-12T00:01:00.000Z");
    const execution = matchedExecution("CLOSE");
    const record: DecisionExecutionRecord = { decision: close, riskGateResult: { status: "PASS", codes: [], checkedAt: close.createdAt }, executionResult: execution, reconciliationResult: matchedReconciliation(execution) };
    const current: TradingJournal = { cycleId: "cycle-fail", agentVersion: "0.3.0", model: "qwen3.8-max", mode: "AUTONOMOUS", startedAt: close.createdAt, completedAt: close.createdAt, retrievedLessons: [], createdLessons: [], cyclePlan: { positionActions: [close as NonNullable<TradingJournal["cyclePlan"]>["positionActions"][number]], entryActions: [] }, executionRecords: [record] };
    const events: ActivityEvent[] = [
      { eventId: "ev-1", type: "CYCLE_STARTED", cycleId: "cycle-fail", createdAt: close.createdAt },
      { eventId: "ev-2", type: "PAPER_ORDER_SUBMITTED", cycleId: "cycle-fail", createdAt: close.createdAt },
      { eventId: "ev-3", type: "EXECUTION_VERIFIED", cycleId: "cycle-fail", createdAt: close.createdAt },
      { eventId: "ev-4", type: "CYCLE_FAILED", cycleId: "cycle-fail", createdAt: close.createdAt, metadata: { category: "RUNTIME_ERROR", code: "RUNTIME_ERROR" } },
    ];
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.3.0", commit: "abc123", cycles: [{ cycleId: "cycle-fail", status: "FAILED", startedAt: current.startedAt, completedAt: current.completedAt ?? null }], journals: [current], experiences: [], events });
    expect(exported.cycles[0]?.failure?.executionOutcome).toBe("VERIFIED_WRITE_BEFORE_CYCLE_FAILURE");
    expect(exported.cycles[0]?.failure?.lastSuccessfulEvent).toBe("EXECUTION_VERIFIED");
    expect(exported.cycles[0]?.failure?.stage).toBe("post_write_portfolio_refresh");
    expect(exported.failureBreakdown.byStage.post_write_portfolio_refresh).toBe(1);
  });

  it("does NOT classify as post_write_portfolio_refresh when last event is PAPER_ORDER_SUBMITTED with submitted-before-failure outcome", () => {
    const close = decision("cycle-submit-fail", "CLOSE", "decision-submit", "2026-09-12T00:01:00.000Z");
    const execution = matchedExecution("CLOSE");
    const record: DecisionExecutionRecord = { decision: close, riskGateResult: { status: "PASS", codes: [], checkedAt: close.createdAt }, executionResult: execution, reconciliationResult: matchedReconciliation(execution) };
    const current: TradingJournal = { cycleId: "cycle-submit-fail", agentVersion: "0.3.0", model: "qwen3.8-max", mode: "AUTONOMOUS", startedAt: close.createdAt, completedAt: close.createdAt, retrievedLessons: [], createdLessons: [], cyclePlan: { positionActions: [close as NonNullable<TradingJournal["cyclePlan"]>["positionActions"][number]], entryActions: [] }, executionRecords: [record] };
    const events: ActivityEvent[] = [
      { eventId: "ev-1", type: "CYCLE_STARTED", cycleId: "cycle-submit-fail", createdAt: close.createdAt },
      { eventId: "ev-2", type: "PAPER_ORDER_SUBMITTED", cycleId: "cycle-submit-fail", createdAt: close.createdAt },
      { eventId: "ev-3", type: "CYCLE_FAILED", cycleId: "cycle-submit-fail", createdAt: close.createdAt, metadata: { category: "RUNTIME_ERROR", code: "RUNTIME_ERROR" } },
    ];
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.3.0", commit: "abc123", cycles: [{ cycleId: "cycle-submit-fail", status: "FAILED", startedAt: current.startedAt, completedAt: current.completedAt ?? null }], journals: [current], experiences: [], events });
    expect(exported.cycles[0]?.failure?.executionOutcome).toBe("SUBMITTED_BEFORE_CYCLE_FAILURE");
    expect(exported.cycles[0]?.failure?.lastSuccessfulEvent).toBe("PAPER_ORDER_SUBMITTED");
    expect(exported.cycles[0]?.failure?.stage).toBe("execution");
    expect(exported.failureBreakdown.byStage.execution).toBe(1);
    expect(exported.failureBreakdown.byStage.post_write_portfolio_refresh).toBeUndefined();
  });

  it("classifies reflection when a later successful event exists after EXECUTION_VERIFIED before CYCLE_FAILED", () => {
    const close = decision("cycle-reflect-fail", "CLOSE", "decision-reflect", "2026-09-12T00:01:00.000Z");
    const execution = matchedExecution("CLOSE");
    const record: DecisionExecutionRecord = { decision: close, riskGateResult: { status: "PASS", codes: [], checkedAt: close.createdAt }, executionResult: execution, reconciliationResult: matchedReconciliation(execution) };
    const current: TradingJournal = { cycleId: "cycle-reflect-fail", agentVersion: "0.3.0", model: "qwen3.8-max", mode: "AUTONOMOUS", startedAt: close.createdAt, completedAt: close.createdAt, retrievedLessons: [], createdLessons: [], cyclePlan: { positionActions: [close as NonNullable<TradingJournal["cyclePlan"]>["positionActions"][number]], entryActions: [] }, executionRecords: [record] };
    const events: ActivityEvent[] = [
      { eventId: "ev-1", type: "CYCLE_STARTED", cycleId: "cycle-reflect-fail", createdAt: close.createdAt },
      { eventId: "ev-2", type: "EXECUTION_VERIFIED", cycleId: "cycle-reflect-fail", createdAt: close.createdAt },
      { eventId: "ev-3", type: "REFLECTION_COMPLETED", cycleId: "cycle-reflect-fail", createdAt: close.createdAt },
      { eventId: "ev-4", type: "CYCLE_FAILED", cycleId: "cycle-reflect-fail", createdAt: close.createdAt, metadata: { category: "RUNTIME_ERROR", code: "RUNTIME_ERROR" } },
    ];
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.3.0", commit: "abc123", cycles: [{ cycleId: "cycle-reflect-fail", status: "FAILED", startedAt: current.startedAt, completedAt: current.completedAt ?? null }], journals: [current], experiences: [], events });
    expect(exported.cycles[0]?.failure?.executionOutcome).toBe("VERIFIED_WRITE_BEFORE_CYCLE_FAILURE");
    expect(exported.cycles[0]?.failure?.lastSuccessfulEvent).toBe("REFLECTION_COMPLETED");
    expect(exported.cycles[0]?.failure?.stage).toBe("reflection");
    expect(exported.failureBreakdown.byStage.reflection).toBe(1);
    expect(exported.failureBreakdown.byStage.post_write_portfolio_refresh).toBeUndefined();
  });

  it("returns unknown when there is no useful prior event before failure", () => {
    const close = decision("cycle-empty-fail", "CLOSE", "decision-empty", "2026-09-12T00:01:00.000Z");
    const current: TradingJournal = { cycleId: "cycle-empty-fail", agentVersion: "0.3.0", model: "qwen3.8-max", mode: "AUTONOMOUS", startedAt: close.createdAt, completedAt: close.createdAt, retrievedLessons: [], createdLessons: [], cyclePlan: { positionActions: [close as NonNullable<TradingJournal["cyclePlan"]>["positionActions"][number]], entryActions: [] } };
    const events: ActivityEvent[] = [
      { eventId: "ev-1", type: "CYCLE_FAILED", cycleId: "cycle-empty-fail", createdAt: close.createdAt, metadata: { category: "RUNTIME_ERROR", code: "RUNTIME_ERROR" } },
    ];
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.3.0", commit: "abc123", cycles: [{ cycleId: "cycle-empty-fail", status: "FAILED", startedAt: current.startedAt, completedAt: current.completedAt ?? null }], journals: [current], experiences: [], events });
    expect(exported.cycles[0]?.failure?.executionOutcome).toBeNull();
    expect(exported.cycles[0]?.failure?.lastSuccessfulEvent).toBeNull();
    expect(exported.cycles[0]?.failure?.stage).toBe("unknown");
    expect(exported.failureBreakdown.byStage.unknown).toBe(1);
  });

  it("CSV escaping: comma, quote, and newline all produce valid quoted CSV", () => {
    const close = decision("cycle-csv", "CLOSE", "decision-csv", "2026-09-12T00:01:00.000Z");
    const current: TradingJournal = { cycleId: "cycle-csv", agentVersion: "0.3.0", model: "qwen3.8-max", mode: "AUTONOMOUS", startedAt: close.createdAt, completedAt: close.createdAt, retrievedLessons: [], createdLessons: [], cyclePlan: { positionActions: [{ ...close, strategyThesis: 'thesis, with "quotes" and\nnewline' } as NonNullable<TradingJournal["cyclePlan"]>["positionActions"][number]], entryActions: [] } };
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.3.0", commit: "abc123", cycles: [{ cycleId: "cycle-csv", status: "COMPLETED", startedAt: current.startedAt, completedAt: current.completedAt ?? null }], journals: [current], experiences: [], events: [] });
    const csv = paperLogToCsv(exported);
    const lines = csv.split("\r\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // The header row should have a fixed number of columns
    const headerCols = lines[0]!.split(",").length;
    // Data row should have the same number of columns when parsed correctly
    const dataRow = lines[1];
    // Manually parse: the strategyThesis field contains commas and quotes so it must be quoted
    expect(dataRow).toContain('"thesis, with ""quotes"" and\nnewline"');
    // Verify every data line has the same column count as header
    for (const line of lines.slice(1)) {
      if (line.trim() === "") continue;
      // Simple CSV parse respecting quotes: split on commas not inside quotes
      let colCount = 1;
      let inQuotes = false;
      for (const ch of line) {
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === ',' && !inQuotes) colCount++;
      }
      expect(colCount).toBe(headerCols);
    }
  });
});
