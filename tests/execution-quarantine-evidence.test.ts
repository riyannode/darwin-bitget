import { describe, expect, it } from "vitest";
import type { ProviderFillEvidence, ProviderOrderReadback } from "../src/trading/late-reconciliation.js";
import { assessExecutionQuarantineHistory, assessExecutionQuarantineRecoveryReadiness, isCompleteBoundedProviderFillHistory, isExactQuarantineQuantityTransition } from "../src/trading/execution-quarantine-evidence.js";

const identity = {
  symbol: "CRCLUSDT",
  clientOrderId: "paper-crcl-entry",
  providerOrderId: "provider-crcl-entry",
  positionSide: "LONG" as const,
  lifecycleSide: "OPEN" as const,
  expectedQuantity: "24.54",
  expectedAveragePrice: "92.11",
};
const order: ProviderOrderReadback = {
  orderId: identity.providerOrderId,
  clientOid: identity.clientOrderId,
  symbol: identity.symbol,
  side: "buy",
  positionSide: "LONG",
  tradeSide: "open_long",
  quantity: "24.54",
  executedQuantity: "24.54",
  averageFillPrice: "92.11",
  status: "filled",
  createdAt: "2026-09-21T05:32:29.335Z",
};
const fills: ProviderFillEvidence[] = [
  { fillId: "fill-1", orderId: order.orderId, clientOid: order.clientOid, symbol: order.symbol, side: "buy", positionSide: "LONG", tradeSide: "open", quantity: "14", price: "92.11", createdAt: "2026-09-21T05:32:29.336Z" },
  { fillId: "fill-2", orderId: order.orderId, clientOid: order.clientOid, symbol: order.symbol, side: "buy", positionSide: "LONG", tradeSide: "open_long", quantity: "10.54", price: "92.11", createdAt: "2026-09-21T05:32:29.337Z" },
];

describe("authoritative quarantine history identity", () => {
  it("accepts exact reductions that reach zero only when the closed position is fully consumed", () => {
    expect(isExactQuarantineQuantityTransition("0.49", "0", "0.49")).toBe(true);
    expect(isExactQuarantineQuantityTransition("1.49", "1", "0.49")).toBe(true);
    expect(isExactQuarantineQuantityTransition("0.49", "0.01", "0.49")).toBe(false);
    expect(isExactQuarantineQuantityTransition("0.49", "-0.01", "0.50")).toBe(false);
  });

  it("aggregates all exact partial fills and normalizes open aliases using provider position side", () => {
    const result = assessExecutionQuarantineHistory({ identity, orders: [order], fills, historyComplete: true });
    expect(result).toMatchObject({ status: "FOUND_EXACT", reason: "EXACT_ORDER_AND_AGGREGATE_FILLS_CONFIRMED", authoritativeNotFound: false });
    expect(result.aggregate).toMatchObject({ valid: true, executedQuantity: "24.54", executedValue: "2260.3794" });
    expect(result.aggregate?.valid && result.aggregate.fills.map((fill) => fill.fillId)).toEqual(["fill-1", "fill-2"]);
  });

  it("only calls NOT_FOUND authoritative within the provider's canceled-order retention with explicit not-found and complete coverage", () => {
    const recent = {
      identity, orders: [], fills: [], historyComplete: true,
      directOrderLookup: "PROVIDER_NOT_FOUND" as const,
      submittedAt: "2026-10-07T23:00:00.000Z",
      observedAt: "2026-10-08T00:00:00.000Z",
    };
    expect(assessExecutionQuarantineHistory(recent))
      .toMatchObject({ status: "NOT_FOUND_AUTHORITATIVE", reason: "DIRECT_NOT_FOUND_WITHIN_RETENTION_AND_COMPLETE_HISTORY", authoritativeNotFound: true });
    expect(assessExecutionQuarantineHistory({ ...recent, directOrderLookup: "TRANSIENT_FAILURE" }))
      .toMatchObject({ status: "INCOMPLETE", reason: "DIRECT_ORDER_LOOKUP_TRANSIENT_FAILURE", authoritativeNotFound: false });
    expect(assessExecutionQuarantineHistory({ ...recent, historyComplete: false }))
      .toMatchObject({ status: "INCOMPLETE", reason: "PROVIDER_HISTORY_COVERAGE_INCOMPLETE", authoritativeNotFound: false });
    expect(assessExecutionQuarantineHistory({ ...recent, submittedAt: "2026-09-21T05:32:29.335Z" }))
      .toMatchObject({ status: "INCOMPLETE", reason: "ORDER_HISTORY_CANCELED_RETENTION_EXPIRED", authoritativeNotFound: false });
  });

  it("rejects wrong client order, provider order, symbol, and LONG/SHORT or OPEN/CLOSE aliases", () => {
    expect(assessExecutionQuarantineHistory({ identity, orders: [{ ...order, clientOid: "wrong-client" }], fills: [], historyComplete: true }))
      .toMatchObject({ status: "IDENTITY_CONFLICT", reason: "PROVIDER_ORDER_IDENTITY_OR_SIDE_MISMATCH" });
    expect(assessExecutionQuarantineHistory({ identity, orders: [{ ...order, orderId: "wrong-provider" }], fills, historyComplete: true }))
      .toMatchObject({ status: "IDENTITY_CONFLICT" });
    expect(assessExecutionQuarantineHistory({ identity, orders: [{ ...order, symbol: "MSTRUSDT" }], fills, historyComplete: true }))
      .toMatchObject({ status: "IDENTITY_CONFLICT" });
    expect(assessExecutionQuarantineHistory({ identity, orders: [{ ...order, tradeSide: "open_short" }], fills, historyComplete: true }))
      .toMatchObject({ status: "IDENTITY_CONFLICT" });
    expect(assessExecutionQuarantineHistory({ identity, orders: [{ ...order, tradeSide: "close_long" }], fills, historyComplete: true }))
      .toMatchObject({ status: "IDENTITY_CONFLICT" });
  });

  it("does not call an exact order recovery-ready when history coverage is incomplete", () => {
    expect(assessExecutionQuarantineHistory({ identity, orders: [order], fills, historyComplete: false }))
      .toMatchObject({ status: "INCOMPLETE", reason: "EXACT_ORDER_FOUND_HISTORY_COVERAGE_INCOMPLETE", order });
  });

  it("marks complete matching evidence eligible only after lifecycle and current-state preconditions pass", () => {
    expect(assessExecutionQuarantineRecoveryReadiness({
      action: "OPEN_LONG", identityExact: true, historyComplete: true, orderFound: true, fillsComplete: true,
      lifecycleClassification: "MATCHED_OPEN", lifecycleEvidenceComplete: true, actionSpecificRequirementsMet: true,
      currentPositionRead: "OK", currentPositionPresent: true, currentPositionUnchanged: true,
    })).toEqual({ recoveryEligible: true, blockers: [] });
  });

  it("blocks complete evidence when the current lifecycle classification is inconsistent", () => {
    expect(assessExecutionQuarantineRecoveryReadiness({
      action: "OPEN_LONG", identityExact: true, historyComplete: true, orderFound: true, fillsComplete: true,
      lifecycleClassification: "CONTRADICTORY", lifecycleEvidenceComplete: true, actionSpecificRequirementsMet: true,
      currentPositionRead: "OK", currentPositionPresent: true, currentPositionUnchanged: true,
    }).blockers).toContain("CURRENT_LIFECYCLE_CLASSIFICATION_CONTRADICTORY");
  });

  it("blocks partial provider history and exhausted pagination", () => {
    expect(assessExecutionQuarantineRecoveryReadiness({
      action: "OPEN_LONG", identityExact: true, historyComplete: false, orderFound: true, fillsComplete: true,
      lifecycleClassification: "MATCHED_OPEN", lifecycleEvidenceComplete: true, actionSpecificRequirementsMet: true,
      currentPositionRead: "OK", currentPositionPresent: true, currentPositionUnchanged: true,
    }).blockers).toContain("PROVIDER_HISTORY_COVERAGE_INCOMPLETE");
  });

  it("reports missing direct order and fill evidence as separate blockers", () => {
    const blockers = assessExecutionQuarantineRecoveryReadiness({
      action: "OPEN_LONG", identityExact: true, historyComplete: true, orderFound: false, fillsComplete: false,
      lifecycleClassification: "UNRESOLVED", lifecycleEvidenceComplete: true, actionSpecificRequirementsMet: true,
      currentPositionRead: "OK", currentPositionPresent: true, currentPositionUnchanged: true,
    }).blockers;
    expect(blockers).toContain("DIRECT_PROVIDER_ORDER_MISSING");
    expect(blockers).toContain("PROVIDER_FILL_AGGREGATION_INCOMPLETE");
  });

  it("blocks when provider position state changed after the evidence observation", () => {
    expect(assessExecutionQuarantineRecoveryReadiness({
      action: "OPEN_LONG", identityExact: true, historyComplete: true, orderFound: true, fillsComplete: true,
      lifecycleClassification: "MATCHED_OPEN", lifecycleEvidenceComplete: true, actionSpecificRequirementsMet: true,
      currentPositionRead: "OK", currentPositionPresent: true, currentPositionUnchanged: false,
    }).blockers).toContain("CURRENT_PROVIDER_POSITION_CHANGED_REDRY_RUN_REQUIRED");
  });

  it("blocks exact identity mismatch", () => {
    expect(assessExecutionQuarantineRecoveryReadiness({
      action: "OPEN_LONG", identityExact: false, historyComplete: true, orderFound: true, fillsComplete: true,
      lifecycleClassification: "MATCHED_OPEN", lifecycleEvidenceComplete: true, actionSpecificRequirementsMet: true,
      currentPositionRead: "OK", currentPositionPresent: true, currentPositionUnchanged: true,
    }).blockers).toContain("EXACT_QUARANTINE_IDENTITY_MISMATCH");
  });

  it("accepts explicit complete fill pagination at exactly 100 rows and beyond", () => {
    expect(isCompleteBoundedProviderFillHistory({ complete: true, cursor: null, pages: 1, rowCount: 100 }, 100)).toBe(true);
    expect(isCompleteBoundedProviderFillHistory({ complete: true, cursor: null, pages: 2, rowCount: 101 }, 101)).toBe(true);
  });

  it("rejects missing or exhausted fill pagination metadata", () => {
    expect(isCompleteBoundedProviderFillHistory({ list: Array.from({ length: 100 }, () => ({})) }, 100)).toBe(false);
    expect(isCompleteBoundedProviderFillHistory({ complete: false, cursor: "next-page", pages: 24, rowCount: 2_400 }, 2_400)).toBe(false);
    expect(isCompleteBoundedProviderFillHistory({ complete: true, cursor: null, pages: 25, rowCount: 2_401 }, 2_401)).toBe(false);
  });
});
