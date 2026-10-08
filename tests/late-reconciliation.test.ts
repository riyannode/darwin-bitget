import { describe, expect, it } from "vitest";
import type { DecisionExecutionRecord, PositionContext, PositionReasoning, PositionSnapshot, TradeExperience } from "../src/types.js";
import { aggregateProviderFillEvidence, parseProviderFillEvidence, parseProviderFillEvidenceRows, parseProviderOrderEvidence, parseProviderOrderReadback, reconcileLateExecution, type ProviderFillEvidence } from "../src/trading/late-reconciliation.js";
import type { ProviderLifecycleEvidence } from "../src/trading/provider-lifecycle-reconciliation.js";
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

function managementReasoning(action: "HOLD" | "REDUCE", decisionId: string, createdAt: string): PositionReasoning {
  return {
    action,
    thesis: action,
    strategyThesis: action,
    supportingFactors: [],
    riskFactors: [],
    evidenceUsed: [],
    lessonsUsed: [],
    confidence: 0.5,
    cycleId: "management-cycle",
    decisionId,
    createdAt,
  };
}

function input(overrides: Partial<Parameters<typeof reconcileLateExecution>[0]> = {}) {
  if (!order || !fill) throw new Error("fixture parse failed");
  return { record, order, fill, currentPosition: position, existingExperience: unresolvedExperience, existingContext: oldContext, resolvedAt: "2026-09-21T06:00:00.000Z", ...overrides };
}

describe("late filled-open reconciliation", () => {
  it("exposes non-filled order status and all exact-identity provider fills for diagnostics", () => {
    const readback = parseProviderOrderReadback({
      orderId: execution.providerOrderId, clientOid: execution.clientOrderId, symbol: "CRCLUSDT", side: "buy",
      posSide: "long", tradeSide: "open_long", qty: "24.54", cumExecQty: "10", avgPrice: "92.11",
      orderStatus: "cancelled", createdTime: "1789968749335",
    });
    expect(readback?.status).toBe("cancelled");
    const fills = parseProviderFillEvidenceRows({ list: [
      { execId: "fill-1", orderId: execution.providerOrderId, clientOid: execution.clientOrderId, symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open_long", execQty: "4", execPrice: "92", createdTime: "1789968749337" },
      { execId: "fill-2", orderId: execution.providerOrderId, clientOid: execution.clientOrderId, symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open_long", execQty: "6", execPrice: "92.18", createdTime: "1789968749338" },
      { orderId: execution.providerOrderId, clientOid: execution.clientOrderId, symbol: "CRCLUSDT" },
      { execId: "other-fill", orderId: execution.providerOrderId, clientOid: "other-client", symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open_long", execQty: "100", execPrice: "1", createdTime: "1789968739339" },
    ] });
    expect(fills.records.map((fill) => fill.fillId)).toEqual(["fill-1", "fill-2", "other-fill"]);
    expect(fills.providerRowCount).toBe(4);
    expect(fills.invalidProviderRowCount).toBe(1);
    expect(parseProviderFillEvidence({ list: [
      { orderId: order?.orderId, clientOid: order?.clientOid, symbol: "CRCLUSDT" },
      { execId: "later-valid-fill", orderId: order?.orderId, clientOid: order?.clientOid, symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open_long", execQty: "24.54", execPrice: "92.11", createdTime: "1789968749337" },
    ] }, order!)).toBeNull();
  });

  it.each([
    ["0", "100"],
    ["-1", "100"],
    ["1", "0"],
    ["1", "-1"],
  ])("rejects nonpositive provider fill quantity %s and price %s", (quantity, price) => {
    const batch = parseProviderFillEvidenceRows({ list: [{
      execId: "invalid-positive-decimal",
      orderId: "provider-order-1",
      clientOid: "client-order-1",
      symbol: "CRCLUSDT",
      side: "buy",
      posSide: "long",
      tradeSide: "open_long",
      execQty: quantity,
      execPrice: price,
      createdTime: "1789968749337",
    }] });
    expect(batch.records).toEqual([]);
    expect(batch.providerRowCount).toBe(1);
    expect(batch.invalidProviderRowCount).toBe(1);
  });

  it("reconciles the original fill while independently validating a partially reduced, re-increased live position with a different average entry", () => {
    const original = fill!;
    const openedAt = original.createdAt;
    const increaseOrder = { orderId: "increase-order", clientOid: "increase-oid", symbol: "CRCLUSDT", side: "buy" as const, positionSide: "LONG" as const, tradeSide: "open_long", quantity: "20", executedQuantity: "20", averageFillPrice: "68.86012", status: "filled" as const, createdAt: "2026-09-21T06:00:00.000Z" };
    const reduceOrder = { orderId: "reduce-order", clientOid: "reduce-oid", symbol: "CRCLUSDT", side: "sell" as const, positionSide: "LONG" as const, tradeSide: "close_long", quantity: "26.16", executedQuantity: "26.16", averageFillPrice: "80", status: "filled" as const, createdAt: "2026-09-21T06:10:00.000Z" };
    const increaseFill: ProviderFillEvidence = { fillId: "increase-fill", orderId: increaseOrder.orderId, clientOid: increaseOrder.clientOid, symbol: "CRCLUSDT", side: "buy", positionSide: "LONG", tradeSide: "open_long", quantity: "20", price: "68.86012", createdAt: increaseOrder.createdAt };
    const reduceFill: ProviderFillEvidence = { fillId: "reduce-fill", orderId: reduceOrder.orderId, clientOid: reduceOrder.clientOid, symbol: "CRCLUSDT", side: "sell", positionSide: "LONG", tradeSide: "close_long", quantity: "26.16", price: "80", createdAt: reduceOrder.createdAt };
    const lifecycle: ProviderLifecycleEvidence = {
      experience: { ...unresolvedExperience, outcomeStatus: "OPEN" },
      providerPositions: [{ ...position, quantity: "18.38", entryPrice: "81.67", openedAt }],
      history: null,
      entryIdentity: { entryDecisionId: decision.decisionId, clientOid: execution.clientOrderId, providerOrderId: execution.providerOrderId },
      orders: [order!, increaseOrder, reduceOrder].map((item) => ({ providerOrderId: item.orderId, clientOid: item.clientOid, symbol: item.symbol, side: item.side, positionSide: item.positionSide, tradeSide: item.tradeSide, createdAt: item.createdAt, origin: "DARWIN" as const })),
      fills: [original, increaseFill, reduceFill].map((item) => ({ fillId: item.fillId, providerOrderId: item.orderId, clientOid: item.clientOid, symbol: item.symbol, side: item.side, positionSide: item.positionSide, tradeSide: item.tradeSide, quantity: item.quantity, execPrice: item.price, createdAt: item.createdAt, origin: "DARWIN" as const })),
      evidenceComplete: true,
    };
    const result = reconcileLateExecution(input({
      currentPosition: { ...position, quantity: "18.38", entryPrice: "81.67" },
      currentPositionLifecycle: lifecycle,
      fills: [original, ...[]],
    }));
    expect(result.status).toBe("RECONCILED");
    expect(result.experience.entryPrice).toBe("92.11");
    expect(result.auditMetadata.providerOrderId).toBe("1485802113215123456");
    expect(result.auditMetadata.fillIds).toBe("fill-1");
  });

  it("reconciles a matching late provider execution when the original local execution status is UNKNOWN", () => {
    const unknownExecution = { ...execution, executedQuantity: "0", status: "unknown" as const };
    const unknownRecord: DecisionExecutionRecord = {
      ...record,
      executionResult: unknownExecution,
      reconciliationResult: { status: "UNKNOWN", codes: ["EXECUTION_UNKNOWN"], execution: unknownExecution },
      executionRequest: { cycleId: decision.cycleId, decisionId: decision.decisionId, clientOrderId: execution.clientOrderId, symbol: "CRCLUSDT", action: "OPEN_LONG", positionSide: "LONG", providerSide: "buy", tradeSide: "open", marginAllocated: execution.marginAllocated, leverage: "3", positionNotional: execution.positionNotional, reductionPct: null, quantity: "24.54" },
    };
    const { existingExperience: _priorExperience, existingContext: _priorContext, ...unknownInput } = input({ record: unknownRecord, allowUnknownProviderExecution: true });
    const result = reconcileLateExecution({ ...unknownInput, existingContext: null });
    expect(result.status).toBe("RECONCILED");
    expect(result.experience.entryPrice).toBe("92.11");
  });

  it("transitions a provider-filled unresolved open into a usable OPEN lifecycle", () => {
    const result = reconcileLateExecution(input());
    expect(result.status).toBe("RECONCILED");
    expect(result.experience.outcomeStatus).toBe("OPEN");
    expect(result.experience.entryDecisionId).toBe(decision.decisionId);
    expect(result.experience.entryPrice).toBe("92.11");
    expect(order?.createdAt).toBe("2026-09-21T05:32:29.335Z");
    expect(fill?.createdAt).toBe("2026-09-21T05:32:29.337Z");
    expect(result.experience.entryTime).toBe("2026-09-21T05:32:29.337Z");
    expect(Number.isFinite(Date.parse(result.experience.entryTime))).toBe(true);
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

  it("returns an already reconciled context byte-for-byte unchanged", () => {
    const existingExperience: TradeExperience = { ...unresolvedExperience, experienceId: "reconciled-experience", outcomeStatus: "OPEN" };
    const hold = managementReasoning("HOLD", "hold-decision", "2026-09-21T05:40:00.000Z");
    const reduce = managementReasoning("REDUCE", "reduce-decision", "2026-09-21T05:50:00.000Z");
    const existingContext: PositionContext = {
      symbol: decision.symbol,
      positionSide: decision.positionSide,
      experienceId: existingExperience.experienceId,
      entryDecisionId: decision.decisionId,
      managementEvents: [hold, reduce],
      latestManagement: reduce,
      updatedAt: "2026-09-21T05:55:00.000Z",
    };
    const before = JSON.stringify(existingContext);
    const result = reconcileLateExecution(input({ existingExperience, existingContext }));

    expect(result.status).toBe("ALREADY_RECONCILED");
    expect(result.positionContext).toBe(existingContext);
    expect(JSON.stringify(result.positionContext)).toBe(before);
    expect(result.positionContext.managementEvents).toEqual([hold, reduce]);
    expect(result.positionContext.latestManagement).toEqual(reduce);
    expect(result.positionContext.updatedAt).toBe("2026-09-21T05:55:00.000Z");
    expect(result.experience).toBe(existingExperience);
  });

  it("fails closed when an open reconciled lifecycle has no matching context", () => {
    const existingExperience: TradeExperience = { ...unresolvedExperience, experienceId: "reconciled-experience", outcomeStatus: "OPEN" };
    expect(() => reconcileLateExecution(input({ existingExperience, existingContext: null }))).toThrow("LATE_RECONCILIATION_STATE_INCONSISTENCY");
  });

  it("fails closed when an open reconciled lifecycle points to another entry context", () => {
    const existingExperience: TradeExperience = { ...unresolvedExperience, experienceId: "reconciled-experience", outcomeStatus: "OPEN" };
    expect(() => reconcileLateExecution(input({
      existingExperience,
      existingContext: { ...oldContext, experienceId: existingExperience.experienceId, entryDecisionId: "other-entry" },
    }))).toThrow("LATE_RECONCILIATION_STATE_INCONSISTENCY");
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

  it("rejects provider order evidence without an explicit clientOid", () => {
    expect(parseProviderOrderEvidence({ orderId: execution.providerOrderId, symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open_long", qty: "24.54", cumExecQty: "24.54", avgPrice: "92.11", orderStatus: "filled", createdTime: "1789968749335" })).toBeNull();
  });

  it("rejects provider fill evidence without an explicit clientOid", () => {
    if (!order) throw new Error("fixture parse failed");
    expect(parseProviderFillEvidence({ list: [{ execId: "fill-1", orderId: order.orderId, symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open_long", execQty: "24.54", execPrice: "92.11", createdTime: "1789968749337" }] }, order)).toBeNull();
  });

  it("rejects malformed provider order timestamps", () => {
    expect(parseProviderOrderEvidence({ orderId: execution.providerOrderId, clientOid: execution.clientOrderId, symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open_long", qty: "24.54", cumExecQty: "24.54", avgPrice: "92.11", orderStatus: "filled", createdTime: "not-a-timestamp" })).toBeNull();
  });

  it("rejects noncanonical timestamps supplied directly to reconciliation", () => {
    expect(() => reconcileLateExecution(input({ fill: { ...fill!, createdAt: "1789968749337" } }))).toThrow("LATE_RECONCILIATION_TIMESTAMP_INVALID");
  });

  it("rejects impossible ISO provider order dates", () => {
    expect(parseProviderOrderEvidence({ orderId: execution.providerOrderId, clientOid: execution.clientOrderId, symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open_long", qty: "24.54", cumExecQty: "24.54", avgPrice: "92.11", orderStatus: "filled", createdTime: "2026-02-30T00:00:00.000Z" })).toBeNull();
  });

  it("rejects missing provider fill timestamps", () => {
    if (!order) throw new Error("fixture parse failed");
    expect(parseProviderFillEvidence({ list: [{ execId: "fill-1", orderId: order.orderId, clientOid: order.clientOid, symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open_long", execQty: "24.54", execPrice: "92.11" }] }, order)).toBeNull();
  });

  it("rejects authoritative order cumExecQty mismatch", () => {
    const mismatchedOrder = parseProviderOrderEvidence({ orderId: execution.providerOrderId, clientOid: execution.clientOrderId, symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open_long", qty: "24.54", cumExecQty: "24.53", avgPrice: "92.11", orderStatus: "filled", createdTime: "1789968749335" });
    expect(mismatchedOrder).not.toBeNull();
    expect(() => reconcileLateExecution(input({ order: mismatchedOrder! }))).toThrow("LATE_RECONCILIATION_QUANTITY_MISMATCH");
  });

  it("rejects a filled order whose requested quantity differs from its executed quantity", () => {
    const mismatchedOrder = parseProviderOrderEvidence({ orderId: execution.providerOrderId, clientOid: execution.clientOrderId, symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open_long", qty: "25", cumExecQty: "24.54", avgPrice: "92.11", orderStatus: "filled", createdTime: "1789968749335" });
    expect(mismatchedOrder).not.toBeNull();
    expect(mismatchedOrder?.quantity).toBe("25");
    expect(mismatchedOrder?.executedQuantity).toBe("24.54");
    expect(() => reconcileLateExecution(input({ order: mismatchedOrder! }))).toThrow("LATE_RECONCILIATION_QUANTITY_MISMATCH");
  });

  it("rejects symbol mismatch", () => {
    expect(() => reconcileLateExecution(input({ order: { ...order!, symbol: "MSTRUSDT" }, fill: { ...fill!, symbol: "MSTRUSDT" } }))).toThrow("LATE_RECONCILIATION_SYMBOL_MISMATCH");
  });

  it("rejects side mismatch", () => {
    expect(() => reconcileLateExecution(input({ order: { ...order!, positionSide: "SHORT" }, fill: { ...fill!, positionSide: "SHORT" } }))).toThrow("LATE_RECONCILIATION_SIDE_MISMATCH");
  });

  it("aggregates every partial fill exactly and rejects an identity or side alias mismatch", () => {
    if (!order) throw new Error("fixture parse failed");
    const twoFills: ProviderFillEvidence[] = [
      { fillId: "part-1", orderId: order.orderId, clientOid: order.clientOid, symbol: order.symbol, side: "buy", positionSide: "LONG", tradeSide: "open", quantity: "10", price: "92.11", createdAt: "2026-09-21T05:32:29.336Z" },
      { fillId: "part-2", orderId: order.orderId, clientOid: order.clientOid, symbol: order.symbol, side: "buy", positionSide: "LONG", tradeSide: "open_long", quantity: "14.54", price: "92.11", createdAt: "2026-09-21T05:32:29.337Z" },
    ];
    expect(aggregateProviderFillEvidence(twoFills, order, "24.54", "92.11", "OPEN")).toMatchObject({
      valid: true, executedQuantity: "24.54", executedValue: "2260.3794", averageFillPrice: "92.11",
    });
    expect(aggregateProviderFillEvidence([{ ...twoFills[0]!, clientOid: "wrong-client" }], order, "10", "92.11", "OPEN"))
      .toMatchObject({ valid: false, code: "PROVIDER_FILL_IDENTITY_MISMATCH" });
    expect(aggregateProviderFillEvidence([{ ...twoFills[0]!, tradeSide: "open_short" }], order, "10", "92.11", "OPEN"))
      .toMatchObject({ valid: false, code: "PROVIDER_FILL_SIDE_MISMATCH" });
    expect(aggregateProviderFillEvidence(twoFills, { ...order, quantity: "25" }, "24.54", "92.11", "OPEN"))
      .toMatchObject({ valid: false, code: "PROVIDER_FILL_QUANTITY_MISMATCH" });
  });

  it("reconciles the original OPEN fill separately from a verified changed current quantity and average entry", () => {
    if (!order) throw new Error("fixture parse failed");
    const originalFills: ProviderFillEvidence[] = [
      { fillId: "crcl-open-1", orderId: order.orderId, clientOid: order.clientOid, symbol: order.symbol, side: "buy", positionSide: "LONG", tradeSide: "open_long", quantity: "14", price: "92.11", createdAt: "2026-09-21T05:32:29.336Z" },
      { fillId: "crcl-open-2", orderId: order.orderId, clientOid: order.clientOid, symbol: order.symbol, side: "buy", positionSide: "LONG", tradeSide: "open", quantity: "10.54", price: "92.11", createdAt: "2026-09-21T05:32:29.337Z" },
    ];
    const currentPosition = { ...position, quantity: "18.38", entryPrice: "81.67", openedAt: "2026-09-21T05:32:29.335Z" };
    const reduce = { providerOrderId: "crcl-reduce", clientOid: "crcl-reduce-oid", symbol: "CRCLUSDT", side: "sell", positionSide: "LONG", tradeSide: "close_long", createdAt: "2026-09-21T05:40:00.000Z", origin: "DARWIN" as const };
    const increase = { providerOrderId: "crcl-increase", clientOid: "crcl-increase-oid", symbol: "CRCLUSDT", side: "buy", positionSide: "LONG", tradeSide: "open_long", createdAt: "2026-09-21T05:45:00.000Z", origin: "DARWIN" as const };
    const lifecycle: ProviderLifecycleEvidence = {
      experience: { ...unresolvedExperience, outcomeStatus: "OPEN", entryTime: "2026-09-21T05:32:29.335Z" },
      providerPositions: [{ symbol: "CRCLUSDT", positionSide: "LONG", quantity: "18.38", entryPrice: "81.67", openedAt: "2026-09-21T05:32:29.335Z" }],
      history: null,
      entryIdentity: { entryDecisionId: decision.decisionId, clientOid: execution.clientOrderId, providerOrderId: execution.providerOrderId },
      orders: [
        { providerOrderId: order.orderId, clientOid: order.clientOid, symbol: order.symbol, side: order.side, positionSide: "LONG", tradeSide: "open_long", createdAt: order.createdAt, origin: "DARWIN" },
        reduce, increase,
      ],
      fills: [
        ...originalFills.map((item) => ({ providerOrderId: item.orderId, clientOid: item.clientOid, symbol: item.symbol, side: item.side, positionSide: item.positionSide, tradeSide: item.tradeSide, quantity: item.quantity, execPrice: item.price, createdAt: item.createdAt, origin: "DARWIN" as const })),
        { providerOrderId: reduce.providerOrderId, clientOid: reduce.clientOid, symbol: reduce.symbol, side: reduce.side, positionSide: "LONG", tradeSide: reduce.tradeSide, quantity: "20", execPrice: "90", createdAt: reduce.createdAt, origin: "DARWIN" },
        { providerOrderId: increase.providerOrderId, clientOid: increase.clientOid, symbol: increase.symbol, side: increase.side, positionSide: "LONG", tradeSide: increase.tradeSide, quantity: "13.84", execPrice: "78.24531791907514450867052023", createdAt: increase.createdAt, origin: "DARWIN" },
      ],
      evidenceComplete: true,
    };
    const result = reconcileLateExecution(input({
      fill: originalFills[0]!, fills: originalFills, currentPosition, currentPositionLifecycle: lifecycle,
    }));
    expect(result.status).toBe("RECONCILED");
    expect(result.experience).toMatchObject({ entryPrice: "92.11", positionNotional: "2260.3794", outcomeStatus: "OPEN" });
    expect(result.auditMetadata).toMatchObject({ fillCount: "2", fillIds: "crcl-open-1,crcl-open-2" });
  });

  it("rejects multi-fill reconciliation when lifecycle coverage is incomplete", () => {
    if (!order) throw new Error("fixture parse failed");
    const openingFills: ProviderFillEvidence[] = [
      { fillId: "part-1", orderId: order.orderId, clientOid: order.clientOid, symbol: order.symbol, side: "buy", positionSide: "LONG", tradeSide: "open_long", quantity: "10", price: "92.11", createdAt: "2026-09-21T05:32:29.336Z" },
      { fillId: "part-2", orderId: order.orderId, clientOid: order.clientOid, symbol: order.symbol, side: "buy", positionSide: "LONG", tradeSide: "open_long", quantity: "14.54", price: "92.11", createdAt: "2026-09-21T05:32:29.337Z" },
    ];
    const incomplete: ProviderLifecycleEvidence = {
      experience: { ...unresolvedExperience, outcomeStatus: "OPEN" },
      providerPositions: [{ symbol: position.symbol, positionSide: position.positionSide, quantity: position.quantity, entryPrice: position.entryPrice, openedAt: "2026-09-21T05:32:29.335Z" }],
      history: null, entryIdentity: null, orders: [], fills: [], evidenceComplete: false,
    };
    expect(() => reconcileLateExecution(input({ fill: openingFills[0]!, fills: openingFills, currentPositionLifecycle: incomplete })))
      .toThrow("LATE_RECONCILIATION_CURRENT_POSITION_UNRESOLVED_PROVIDER_LIFECYCLE_EVIDENCE_TRUNCATED");
  });

  it("rejects quantity contradiction", () => {
    expect(() => reconcileLateExecution(input({ order: { ...order!, quantity: "24.53" }, fill: { ...fill!, quantity: "24.53" } }))).toThrow("LATE_RECONCILIATION_QUANTITY_MISMATCH");
  });
});
