import { describe, expect, it } from "vitest";
import { buildPaperLogExport, calculatePeakDrawdown, paperLogToCsv, parsePaperLogPeriod } from "../src/storage/paper-log.js";
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
  it("calculates peak-to-trough drawdown after a new peak", () => {
    expect(calculatePeakDrawdown(["10000", "10500", "10100"])).toEqual({ current: "-3.80952381", maximum: "-3.80952381" });
  });

  it("keeps the worst drawdown after a partial recovery", () => {
    expect(calculatePeakDrawdown(["10000", "9000", "9500"])).toEqual({ current: "-5.00000000", maximum: "-10.00000000" });
  });

  it("reports zero drawdown for monotonic rising equity", () => {
    expect(calculatePeakDrawdown(["10000", "10500", "11000"])).toEqual({ current: "0.00000000", maximum: "0.00000000" });
  });

  it("exports full autonomous history, including HOLD, while excluding non-autonomous journals", () => {
    const journals = Array.from({ length: 30 }, (_, index) => journal(index, index === 0 ? "HOLD" : "OPEN_LONG"));
    const manual = { ...journal(31, "OPEN_LONG"), cycleId: "manual-test" , mode: "EVA_EVALUATION" as const };
    const events: ActivityEvent[] = journals.map((entry) => ({ eventId: `event-${entry.cycleId}`, type: "CYCLE_COMPLETED", cycleId: entry.cycleId, createdAt: entry.startedAt }));
    const autonomousJournals = journals.map((entry, index) => index === 1 ? { ...entry, experienceIds: ["experience-1"] } : entry);
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.2.0", commit: "test", cycles: autonomousJournals.concat(manual).map((entry) => ({ cycleId: entry.cycleId, status: "COMPLETED", startedAt: entry.startedAt, completedAt: entry.completedAt ?? null })), journals: [...autonomousJournals, manual], experiences: [experience()], events });

    expect(exported.cycles).toHaveLength(30);
    expect(exported.decisions).toHaveLength(30);
    expect(exported.summary.decisions.HOLD).toBe(1);
    expect(exported.experiences[0]?.realizedPnl).toBe("-0.0456");
    expect(JSON.stringify(exported)).not.toContain("manual-test");
  });

  it("produces a flattened CSV with decision and execution fields", () => {
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.2.0", commit: "test", cycles: [{ cycleId: "cycle-1", status: "COMPLETED", startedAt: "2026-09-12T00:00:00.000Z", completedAt: "2026-09-12T00:01:00.000Z" }], journals: [journal(1, "HOLD")], experiences: [], events: [] });
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
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.2.0", commit: "test", cycles: [{ cycleId: base.cycleId, status: "COMPLETED", startedAt: base.startedAt, completedAt: base.completedAt ?? null }], journals: [current], experiences: [], events: [] });
    expect(exported.decisions[0]?.executionResult).toMatchObject({ providerOperation: "placeOrder", providerCode: "40010", providerMessage: "ORDER_REJECTED", providerReadbackCode: "ORDER_NOT_FOUND", providerReadbackMessage: "READBACK_EMPTY" });
    const csv = paperLogToCsv(exported);
    expect(csv).toContain("providerOperation");
    expect(csv).toContain("placeOrder");
    expect(csv).toContain("ORDER_REJECTED");
  });

  it("uses legacy primary execution and reconciliation fallback for provider verification", () => {
    const execution = matchedExecution();
    const current = { ...journal(1, "OPEN_LONG"), executionResult: execution, reconciliationResult: matchedReconciliation(execution) };
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.2.0", commit: "test", cycles: [{ cycleId: current.cycleId, status: "COMPLETED", startedAt: current.startedAt, completedAt: current.completedAt ?? null }], journals: [current], experiences: [], events: [] });
    expect(exported.decisions[0]?.providerVerified).toBe(true);
    expect(exported.summary.verifiedExecutions).toBe(1);
    expect(exported.summary.unresolvedExecutions).toBe(0);
  });

  it("keeps filled unresolved and unknown execution states unresolved", () => {
    const filled = matchedExecution();
    const unresolved = { ...journal(1, "OPEN_LONG"), executionResult: filled, reconciliationResult: { ...matchedReconciliation(filled), status: "UNKNOWN" as const } };
    const unknownExecution = failedExecution();
    const unknown = { ...journal(2, "OPEN_LONG"), executionResult: unknownExecution, reconciliationResult: { ...matchedReconciliation(unknownExecution), status: "UNKNOWN" as const } };
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.2.0", commit: "test", cycles: [unresolved, unknown].map((entry) => ({ cycleId: entry.cycleId, status: "COMPLETED", startedAt: entry.startedAt, completedAt: entry.completedAt ?? null })), journals: [unresolved, unknown], experiences: [], events: [] });
    expect(exported.decisions.every((entry) => entry.providerVerified === false)).toBe(true);
    expect(exported.summary.verifiedExecutions).toBe(0);
    expect(exported.summary.unresolvedExecutions).toBe(2);
  });

  it("uses matched exit records and exports each action in a new cycle plan", () => {
    const close = decision("cycle-plan", "CLOSE", "decision-close", "2026-09-12T00:01:00.000Z");
    const hold = decision("cycle-plan", "HOLD", "decision-hold", "2026-09-12T00:01:00.000Z");
    const entry = decision("cycle-plan", "OPEN_LONG", "decision-entry", "2026-09-12T00:01:00.000Z");
    const execution = matchedExecution("CLOSE");
    const record: DecisionExecutionRecord = { decision: close, riskGateResult: { status: "PASS", codes: [], checkedAt: close.createdAt }, executionResult: execution, reconciliationResult: matchedReconciliation(execution) };
    const current: TradingJournal = { cycleId: "cycle-plan", agentVersion: "0.3.0", model: "qwen3.8-max", mode: "AUTONOMOUS", startedAt: close.createdAt, completedAt: close.createdAt, retrievedLessons: [], createdLessons: [], cyclePlan: { positionActions: [hold as NonNullable<TradingJournal["cyclePlan"]>["positionActions"][number], close as NonNullable<TradingJournal["cyclePlan"]>["positionActions"][number]], entryActions: [entry as NonNullable<TradingJournal["cyclePlan"]>["entryActions"][number]] }, executionRecords: [record] };
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.3.0", commit: "test", cycles: [{ cycleId: "cycle-plan", status: "COMPLETED", startedAt: current.startedAt, completedAt: current.completedAt ?? null }], journals: [current], experiences: [], events: [] });
    expect(exported.decisions).toHaveLength(3);
    expect(exported.decisions.map((entry) => entry.actionCategory)).toEqual(["POSITION_MANAGEMENT", "POSITION_MANAGEMENT", "NEW_ENTRY"]);
    expect(exported.decisions.find((entry) => entry.decisionId === "decision-close")?.providerVerified).toBe(true);
    expect(exported.decisions.find((entry) => entry.decisionId === "decision-hold")?.providerVerified).toBe(false);
    expect(exported.summary.verifiedExecutions).toBe(1);
  });

  it("validates export periods deterministically", () => {
    expect(parsePaperLogPeriod("2026-09-12T00:00:00Z", "2026-09-12T01:00:00Z")).toEqual({ start: "2026-09-12T00:00:00.000Z", end: "2026-09-12T01:00:00.000Z" });
    expect(() => parsePaperLogPeriod("invalid", null)).toThrow("INVALID_EXPORT_PERIOD");
    expect(() => parsePaperLogPeriod("2026-09-12T01:00:00Z", "2026-09-12T00:00:00Z")).toThrow("INVALID_EXPORT_PERIOD");
  });
});
