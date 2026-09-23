import { describe, expect, it } from "vitest";
import type { TradeExperience } from "../src/types.js";
import { classifyProviderLifecycle, type ProviderLifecycleEvidence } from "../src/trading/provider-lifecycle-reconciliation.js";

const experience: TradeExperience = {
  experienceId: "80432b47-8fa1-4f41-af10-63e6ac4c55f6",
  symbol: "SAMSUNGUSDT",
  positionSide: "LONG",
  action: "OPEN_LONG",
  entryDecisionId: "87a5c9bc-e24e-4b97-bcaf-c8417d0f6c11",
  entryPrice: "198.02",
  entryTime: "2026-09-21T17:03:30.661Z",
  exitDecisionId: "",
  exitPrice: "0",
  exitTime: "",
  selectedLeverage: "3",
  marginAllocationPct: "10",
  marginAllocated: "100",
  positionNotional: "1490.1302",
  realizedPnl: "19.1364",
  realizedPnlPct: "0",
  maximumFavorableExcursion: "0",
  maximumAdverseExcursion: "0",
  drawdownContribution: "0",
  liquidationDistance: "0",
  entryThesis: "original thesis",
  exitThesis: "",
  evidenceAtEntry: ["entry-evidence"],
  evidenceAtExit: [],
  lessonsUsed: ["lesson-1"],
  marketContext: "original context",
  outcomeStatus: "OPEN",
};

const fixture = (): ProviderLifecycleEvidence => ({
  experience,
  providerPositions: [],
  history: {
    providerPositionHistoryId: "1485976014620573698",
    symbol: "SAMSUNGUSDT",
    positionSide: "LONG",
    openTotalPos: "7.51",
    closeTotalPos: "7.51",
    avgEntryPrice: "198.02",
    avgExitPrice: "202.66",
    cumRealisedPnl: "34.8487",
    netProfit: "33.19485709",
    openFeeTotal: "-0.89227812",
    closeFeeTotal: "-0.91318734",
    totalFunding: "0.15162255",
    cashDividend: "0",
    openingTime: "2026-09-21T17:03:30.661Z",
    closingTime: "2026-09-22T01:43:06.332Z",
    origin: "DARWIN",
  },
  entryIdentity: {
    entryDecisionId: experience.entryDecisionId,
    clientOid: "darwin-entry-oid",
    providerOrderId: "provider-entry-order",
  },
  orders: [
    { providerOrderId: "provider-entry-order", clientOid: "darwin-entry-oid", symbol: "SAMSUNGUSDT", positionSide: "LONG", tradeSide: "open", origin: "DARWIN" },
    ...["close-1", "close-2", "close-3", "close-4", "close-5", "close-6"].map((id) => ({ providerOrderId: id, clientOid: `darwin-${id}`, symbol: "SAMSUNGUSDT", positionSide: "LONG", tradeSide: "close", origin: "DARWIN" as const })),
  ],
  fills: [
    { providerOrderId: "provider-entry-order", clientOid: "darwin-entry-oid", symbol: "SAMSUNGUSDT", positionSide: "LONG", tradeSide: "open", quantity: "7.51", createdAt: "2026-09-21T17:03:30.661Z", origin: "DARWIN" },
    ...["2.47", "1.66", "1.11", "1.13", "0.57", "0.57"].map((quantity, index) => ({
      providerOrderId: `close-${index + 1}`,
      clientOid: `darwin-close-${index + 1}`,
      symbol: "SAMSUNGUSDT",
      positionSide: "LONG" as const,
      tradeSide: "close",
      quantity,
      createdAt: `2026-09-21T${String(18 + index).padStart(2, "0")}:00:00.000Z`,
      origin: "DARWIN" as const,
    })),
  ],
});

describe("provider/local lifecycle reconciliation", () => {
  it("classifies a provider/local open lifecycle only when current-position and entry identity evidence match", () => {
    const original = fixture();
    const evidence = { ...original, history: null, providerPositions: [{ symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "7.51" }] };
    expect(classifyProviderLifecycle(evidence).classification).toBe("MATCHED_OPEN");
  });

  it("distinguishes a provider position without an active local lifecycle", () => {
    const original = fixture();
    const evidence = { ...original, experience: { ...experience, outcomeStatus: "CLOSED_UNCLASSIFIED" as const }, history: null, providerPositions: [{ symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "1" }] };
    expect(classifyProviderLifecycle(evidence).classification).toBe("PROVIDER_POSITION_WITHOUT_LOCAL_LIFECYCLE");
  });

  it("classifies a reconciled provider/local closed lifecycle", () => {
    const evidence = { ...fixture(), experience: { ...experience, outcomeStatus: "PROFITABLE" as const } };
    expect(classifyProviderLifecycle(evidence).classification).toBe("MATCHED_CLOSED");
  });

  it("does not match an open lifecycle when entry identity is missing", () => {
    const original = fixture();
    const evidence = { ...original, history: null, entryIdentity: null, providerPositions: [{ symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "7.51" }] };
    expect(classifyProviderLifecycle(evidence).classification).toBe("UNRESOLVED");
  });

  it("classifies a provider-external current position as external, not DARWIN", () => {
    const original = fixture();
    const orders = original.orders.map((order) => order.providerOrderId === "close-1" ? { ...order, origin: "PROVIDER_EXTERNAL" as const } : order);
    const fills = original.fills.map((fill) => fill.providerOrderId === "close-1" ? { ...fill, origin: "PROVIDER_EXTERNAL" as const } : fill);
    const evidence = { ...original, history: null, experience: { ...experience, outcomeStatus: "CLOSED_UNCLASSIFIED" as const }, providerPositions: [{ symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "1" }], orders, fills };
    expect(classifyProviderLifecycle(evidence).classification).toBe("PROVIDER_EXTERNAL");
  });

  it("classifies the exact SAMSUNG fixture as LOCAL_OPEN_PROVIDER_CLOSED", () => {
    expect(classifyProviderLifecycle(fixture()).classification).toBe("LOCAL_OPEN_PROVIDER_CLOSED");
  });

  it("reconciles all six DARWIN closing fills exactly to 7.51", () => {
    const result = classifyProviderLifecycle(fixture());
    expect(result.classification).toBe("LOCAL_OPEN_PROVIDER_CLOSED");
    expect(result.closedQuantity).toBe("7.51");
  });

  it("rejects an unexplained residual closing quantity", () => {
    const original = fixture();
    const evidence = { ...original, fills: original.fills.map((fill, index) => index === original.fills.length - 1 ? { ...fill, quantity: "0.56" } : fill) };
    expect(classifyProviderLifecycle(evidence).classification).toBe("CONTRADICTORY");
  });

  it("does not treat malformed current provider quantity as position absence", () => {
    const evidence = { ...fixture(), providerPositions: [{ symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "not-a-decimal" }] };
    expect(classifyProviderLifecycle(evidence)).toMatchObject({ classification: "UNRESOLVED", reason: "CURRENT_PROVIDER_POSITION_QUANTITY_INVALID" });
  });

  it("rejects a still-present current provider position", () => {
    const evidence = fixture();
    evidence.providerPositions = [{ symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "0.01" }];
    expect(classifyProviderLifecycle(evidence).classification).toBe("CONTRADICTORY");
  });

  it("does not reconcile evidence for the wrong symbol or side", () => {
    const evidence = fixture();
    evidence.history = { ...evidence.history!, symbol: "OTHERUSDT", positionSide: "LONG" };
    expect(classifyProviderLifecycle(evidence).classification).toBe("CONTRADICTORY");
  });

  it("rejects position-history evidence for the wrong position side", () => {
    const evidence = fixture();
    evidence.history = { ...evidence.history!, positionSide: "SHORT" };
    expect(classifyProviderLifecycle(evidence).classification).toBe("CONTRADICTORY");
  });

  it("leaves missing position-history evidence unresolved", () => {
    const evidence = fixture();
    evidence.history = null;
    expect(classifyProviderLifecycle(evidence).classification).toBe("UNRESOLVED");
  });

  it("does not label provider-external evidence as DARWIN", () => {
    const evidence = fixture();
    evidence.history = { ...evidence.history!, origin: "PROVIDER_EXTERNAL" };
    expect(classifyProviderLifecycle(evidence).classification).toBe("PROVIDER_EXTERNAL");
  });
});
