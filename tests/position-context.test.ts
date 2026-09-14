import { describe, expect, it } from "vitest";
import type { Decision, TradeExperience } from "../src/types.js";
import { bootstrapPositionContexts, upsertPositionContext } from "../src/agent/position-context.js";
import type { ExecutionResult, TradingJournal } from "../src/types.js";

const base: Decision = {
  decisionId: "entry-1", cycleId: "cycle-entry", action: "OPEN_LONG", positionSide: "LONG", symbol: "CRCLUSDT", marginAllocationPct: "10", leverage: "3", reductionPct: null, confidence: 0.82, thesis: "entry thesis", strategyThesis: "entry strategy", supportingFactors: ["trend"], riskFactors: ["volatility"], evidenceUsed: ["ticker", "bars"], lessonsUsed: ["lesson-1"], createdAt: "2026-09-12T10:00:00.000Z",
};
const experience: TradeExperience = {
  experienceId: "experience-1", symbol: "CRCLUSDT", positionSide: "LONG", action: "OPEN_LONG", entryDecisionId: "entry-1", entryPrice: "90.78", entryTime: "2026-09-12T10:00:01.000Z", exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10", marginAllocated: "100", positionNotional: "300", realizedPnl: "0", realizedPnlPct: "0", maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0", liquidationDistance: "0", entryThesis: "persisted entry thesis", exitThesis: "", evidenceAtEntry: ["ticker", "bars"], evidenceAtExit: [], lessonsUsed: ["lesson-1"], marketContext: "TRENDING_UP", outcomeStatus: "OPEN", realizedPnlVerified: false,
};

function management(action: "HOLD" | "INCREASE" | "REDUCE" | "CLOSE" | "REVERSE", id: string): Decision {
  return { ...base, decisionId: id, cycleId: `cycle-${id}`, action, marginAllocationPct: action === "REVERSE" ? "10" : "0", additionalMarginPct: action === "INCREASE" ? "5" : null, reductionPct: action === "REDUCE" ? "25" : action === "CLOSE" ? "100" : null, targetPositionSide: action === "REVERSE" ? "SHORT" : null, thesis: `${action} thesis`, strategyThesis: `${action} strategy` };
}

function withoutProviderOrderId(value: ExecutionResult): Omit<ExecutionResult, "providerOrderId"> {
  const copy = { ...value };
  delete copy.providerOrderId;
  return copy;
}

describe("bounded position reasoning context", () => {
  it("preserves original entry reasoning while replacing only latest management", () => {
    let context = upsertPositionContext(null, base, experience.entryTime, experience);
    context = upsertPositionContext(context, management("HOLD", "hold-1"), "2026-09-13T10:00:00.000Z");
    context = upsertPositionContext(context, management("INCREASE", "increase-1"), "2026-09-14T10:00:00.000Z");
    expect(context?.entryReasoning).toMatchObject({ thesis: "persisted entry thesis", decisionId: "entry-1", evidenceUsed: ["ticker", "bars"], experienceId: "experience-1" });
    expect(context?.latestManagement).toMatchObject({ action: "INCREASE", thesis: "INCREASE thesis" });
    expect(context?.managementEvents.map((event) => event.action)).toEqual(["HOLD", "INCREASE"]);
  });

  it("keeps LONG and SHORT reasoning contexts separate", () => {
    const long = upsertPositionContext(null, base, experience.entryTime, experience);
    const short = upsertPositionContext(null, { ...base, decisionId: "entry-short", positionSide: "SHORT", action: "OPEN_SHORT" }, experience.entryTime, { ...experience, experienceId: "experience-short", entryDecisionId: "entry-short", positionSide: "SHORT", action: "OPEN_SHORT" });
    expect(long?.positionSide).toBe("LONG");
    expect(short?.positionSide).toBe("SHORT");
    expect(long?.entryDecisionId).not.toBe(short?.entryDecisionId);
  });

  it("does not invent entry reasoning when only a management decision exists", () => {
    const context = upsertPositionContext(null, management("HOLD", "hold-only"), "2026-09-14T10:00:00.000Z");
    expect(context?.entryReasoning).toBeUndefined();
    expect(context?.latestManagement?.action).toBe("HOLD");
  });

  it("bootstraps legacy verified entry reasoning but excludes failed openings", () => {
    const execution: ExecutionResult = { provider: "bitget", providerOrderId: "order-1", clientOrderId: "client-1", symbol: "CRCLUSDT", action: "OPEN_LONG", positionSide: "LONG", providerSide: "buy", tradeSide: "open", marginAllocated: "100", leverage: "3", positionNotional: "300", requestedQuantity: "3", executedQuantity: "3", status: "filled", submittedAt: base.createdAt, readBackAt: base.createdAt };
    const legacy: TradingJournal = { cycleId: base.cycleId, agentVersion: "1", model: "qwen", mode: "AUTONOMOUS", startedAt: base.createdAt, completedAt: base.createdAt, decision: base, executionResult: execution, reconciliationResult: { status: "MATCHED", codes: [], execution }, retrievedLessons: [], createdLessons: [] };
    const failedExecution = { ...withoutProviderOrderId(execution), clientOrderId: "failed-client", status: "unknown" as const };
    const failed: TradingJournal = { ...legacy, cycleId: "failed-cycle", decision: { ...base, decisionId: "failed-entry" }, executionResult: failedExecution, reconciliationResult: { status: "UNKNOWN", codes: ["EXECUTION_UNKNOWN"], execution: failedExecution } };
    expect(bootstrapPositionContexts([legacy], [experience], "2026-09-14T10:00:00.000Z")[0]?.entryReasoning).toMatchObject({ thesis: "persisted entry thesis", decisionId: "entry-1" });
    expect(bootstrapPositionContexts([failed], [{ ...experience, experienceId: "failed-experience", entryDecisionId: "failed-entry", outcomeStatus: "BLOCKED" }], "2026-09-14T10:00:00.000Z")).toHaveLength(0);
  });
});
