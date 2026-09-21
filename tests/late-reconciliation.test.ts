import { describe, expect, it } from "vitest";
import type { DecisionExecutionRecord, PositionContext, PositionSnapshot, TradeExperience } from "../src/types.js";
import { parseProviderFillEvidence, parseProviderOrderEvidence, reconcileLateExecution } from "../src/trading/late-reconciliation.js";
import { emptyPerformance, recordVerifiedOpen } from "../src/trading/performance.js";

const decision = {
  decisionId: "entry-decision",
  cycleId: "source-cycle",
  action: "OPEN_LONG" as const,
  positionSide: "LONG" as const,
  symbol: "CRCLUSDT",
  marginAllocationPct: "1.5",
  additionalMarginPct: null,
  leverage: "3",
  reductionPct: null,
  targetPositionSide: null,
  confidence: 0.65,
  thesis: "provider-confirmed entry",
  strategyThesis: "provider-confirmed strategy",
  supportingFactors: ["fill"],
  riskFactors: ["readback"],
  evidenceUsed: ["provider"],
  lessonsUsed: [],
  createdAt: "2026-09-21T05:32:26.300Z",
};

const execution = {
  provider: "bitget",
  providerOrderId: "1485802113215123456",
  clientOrderId: "paper-db04191935904364-ad6a8a156",
  symbol: "CRCLUSDT",
  action: "OPEN_LONG" as const,
  positionSide: "LONG" as const,
  providerSide: "buy" as const,
  tradeSide: "open" as const,
  marginAllocated: "756.3325326438",
  leverage: "3",
  positionNotional: "2268.9975979314",
  requestedQuantity: "24.54",
  executedQuantity: "24.54",
  status: "filled" as const,
  submittedAt: "2026-09-21T05:32:28.909Z",
  readBackAt: "2026-09-21T05:32:29.566Z",
  averageFillPrice: "92.11",
};

const record = {
  decision,
  riskGateResult: { status: "PASS" as const, codes: [], checkedAt: execution.submittedAt },
  executionResult: execution,
  reconciliationResult: { status: "MISMATCH" as const, codes: ["POSITION_READBACK_UNAVAILABLE", "POSITION_READBACK_MISSING"], execution },
} satisfies DecisionExecutionRecord;

const order = parseProviderOrderEvidence({
  orderId: execution.providerOrderId,
  clientOid: execution.clientOrderId,
  symbol: "CRCLUSDT",
  side: "buy",
  posSide: "long",
  tradeSide: "open_long",
  qty: "24.54",
  cumExecQty: "24.54",
  avgPrice: "92.11",
  orderStatus: "filled",
  createdTime: "1789968749335",
});

const fill = order ? parseProviderFillEvidence({ list: [{ execId: "fill-1", orderId: order.orderId, clientOid: order.clientOid, symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open_long", execQty: "24.54", execPrice: "92.11", createdTime: "1789968749337" }] }, order) : null;

const position: PositionSnapshot = {
  symbol: "CRCLUSDT",
  positionSide: "LONG",
  quantity: "24.54",
  notional: "2257.4346",
  marginAllocated: "753.83266076",
  leverage: "3",
  entryPrice: "92.11",
  markPrice: "91.99",
  unrealizedPnl: "-2.9448",
  realizedPnl: "0",
};

const unresolvedExperience: TradeExperience = {
  experienceId: "unresolved-experience",
  symbol: "CRCLUSDT",
  positionSide: "LONG",
  action: "OPEN_LONG",
  entryDecisionId: decision.decisionId,
  entryPrice: "92.45",
  entryTime: "2026-09-21T05:32:30.110Z",
  exitDecisionId: "",
  exitPrice: "92.45",
  exitTime: "",
  selectedLeverage: "3",
  marginAllocationPct: "1.5",
  marginAllocated: execution.marginAllocated,
  positionNotional: execution.positionNotional,
  realizedPnl: "0",
  realizedPnlPct: "0",
  maximumFavorableExcursion: "0",
  maximumAdverseExcursion: "0",
  drawdownContribution: "0",
  liquidationDistance: "0",
  entryThesis: decision.thesis,
  exitThesis: "",
  evidenceAtEntry: ["TICKER"],
  evidenceAtExit: ["TICKER"],
  lessonsUsed: [],
  marketContext: "RANGE_LOW_VOL",
  outcomeStatus: "EXECUTION_UNRESOLVED",
  lastAction: "OPEN_LONG",
};

const oldContext: PositionContext = {
  symbol: "CRCLUSDT",
  positionSide: "LONG",
  entryDecisionId: "old-entry",
  managementEvents: [],
  updatedAt: "2026-09-21T02:06:16.913Z",
};

function input(overrides: Partial<Parameters<typeof reconcileLateExecution>[0]> = {}) {
  if (!order || !fill) throw new Error("fixture parse failed");
  return { record, order, fill, currentPosition: position, existingExperience: unresolvedExperience, existingContext: oldContext, resolvedAt: "2026-09-21T06:00:00.000Z", ...overrides };
}

describe("late filled-open reconciliation", () => {
  it("transitions a provider-filled unresolved open into a usable OPEN lifecycle", () => {
    const result = reconcileLateExecution(input());
    expect(result.status).toBe("RECONCILED");
    expect(result.experience.outcomeStatus).toBe("OPEN");
    expect(result.experience.entryDecisionId).toBe(decision.decisionId);
    expect(result.experience.entryPrice).toBe("92.11");
    expect(result.positionContext.entryDecisionId).toBe(decision.decisionId);
    expect(result.auditMetadata.originalCycleId).toBe("source-cycle");
  });

  it("idempotent when the same lifecycle is reconciled twice", () => {
    const first = reconcileLateExecution(input());
    const second = reconcileLateExecution(input({ existingExperience: first.experience, existingContext: first.positionContext }));
    expect(second.status).toBe("ALREADY_RECONCILED");
    expect(second.experience.experienceId).toBe(first.experience.experienceId);
    expect(second.positionContext.entryDecisionId).toBe(decision.decisionId);
  });

  it("keeps the original mismatch evidence unchanged", () => {
    const original = JSON.stringify(record.reconciliationResult);
    reconcileLateExecution(input());
    expect(JSON.stringify(record.reconciliationResult)).toBe(original);
  });

  it("gives the derived performance read model one verified-open increment", () => {
    const first = reconcileLateExecution(input());
    const second = reconcileLateExecution(input({ existingExperience: first.experience, existingContext: first.positionContext }));
    let performance = emptyPerformance("2026-09-21T06:00:00.000Z");
    if (first.status === "RECONCILED") performance = recordVerifiedOpen(performance, "50000", "2026-09-21T06:00:00.000Z");
    if (second.status === "RECONCILED") performance = recordVerifiedOpen(performance, "50000", "2026-09-21T06:00:01.000Z");
    expect(performance.totalTrades).toBe(1);
    expect(performance.openTrades).toBe(1);
  });

  it("rejects a non-filled execution", () => {
    expect(() => reconcileLateExecution(input({ record: { ...record, executionResult: { ...execution, status: "rejected" }, reconciliationResult: { ...record.reconciliationResult, execution: { ...execution, status: "rejected" } } } }))).toThrow("LATE_RECONCILIATION_NOT_ELIGIBLE");
  });

  it("rejects provider order ID mismatch", () => {
    expect(() => reconcileLateExecution(input({ order: { ...order!, orderId: "other-order" }, fill: { ...fill!, orderId: "other-order" } }))).toThrow("LATE_RECONCILIATION_PROVIDER_ORDER_MISMATCH");
  });

  it("rejects client order ID mismatch", () => {
    expect(() => reconcileLateExecution(input({ order: { ...order!, clientOid: "other-client" }, fill: { ...fill!, clientOid: "other-client" } }))).toThrow("LATE_RECONCILIATION_CLIENT_ORDER_MISMATCH");
  });

  it("rejects symbol mismatch", () => {
    expect(() => reconcileLateExecution(input({ order: { ...order!, symbol: "MSTRUSDT" }, fill: { ...fill!, symbol: "MSTRUSDT" } }))).toThrow("LATE_RECONCILIATION_SYMBOL_MISMATCH");
  });

  it("rejects side mismatch", () => {
    expect(() => reconcileLateExecution(input({ order: { ...order!, positionSide: "SHORT" }, fill: { ...fill!, positionSide: "SHORT" } }))).toThrow("LATE_RECONCILIATION_SIDE_MISMATCH");
  });

  it("rejects quantity contradiction", () => {
    expect(() => reconcileLateExecution(input({ order: { ...order!, quantity: "24.53" }, fill: { ...fill!, quantity: "24.53" } }))).toThrow("LATE_RECONCILIATION_QUANTITY_MISMATCH");
  });
});
