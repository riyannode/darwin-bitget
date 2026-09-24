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
    { providerOrderId: "provider-entry-order", clientOid: "darwin-entry-oid", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG", tradeSide: "open", createdAt: "2026-09-21T17:03:30.661Z", origin: "DARWIN" },
    ...["close-1", "close-2", "close-3", "close-4", "close-5", "close-6"].map((id, index) => ({ providerOrderId: id, clientOid: `darwin-${id}`, symbol: "SAMSUNGUSDT", side: "sell", positionSide: "LONG", tradeSide: "close", createdAt: `2026-09-21T${String(18 + index).padStart(2, "0")}:00:00.000Z`, origin: "DARWIN" as const })),
  ],
  fills: [
    { providerOrderId: "provider-entry-order", clientOid: "darwin-entry-oid", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG", tradeSide: "open", quantity: "3.755", execPrice: "198.01", createdAt: "2026-09-21T17:03:30.660Z", origin: "DARWIN" },
    { providerOrderId: "provider-entry-order", clientOid: "darwin-entry-oid", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG", tradeSide: "open", quantity: "3.755", execPrice: "198.03", createdAt: "2026-09-21T17:03:30.662Z", origin: "DARWIN" },
    ...["2.47", "1.66", "1.11", "1.13", "0.57", "0.57"].map((quantity, index) => ({
      providerOrderId: `close-${index + 1}`,
      clientOid: `darwin-close-${index + 1}`,
      symbol: "SAMSUNGUSDT",
      side: "sell" as const,
      positionSide: "LONG" as const,
      tradeSide: "close",
      quantity,
      execPrice: "202.66",
      createdAt: `2026-09-21T${String(18 + index).padStart(2, "0")}:00:00.000Z`,
      origin: "DARWIN" as const,
    })),
  ],
});

const costBasisFixture = (entryPrice: string, increaseOrigin: ProviderLifecycleEvidence["fills"][number]["origin"] = "DARWIN"): ProviderLifecycleEvidence => {
  const openedAt = "2026-09-21T17:03:30.661Z";
  const increaseOrder = { providerOrderId: "increase-1", clientOid: "darwin-increase-1", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG", tradeSide: "open", createdAt: "2026-09-21T17:15:00.000Z", origin: increaseOrigin } as const;
  return {
    experience,
    providerPositions: [{ symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "10", entryPrice, openedAt }],
    history: null,
    entryIdentity: { entryDecisionId: experience.entryDecisionId, clientOid: "darwin-entry-oid", providerOrderId: "provider-entry-order" },
    orders: [
      { providerOrderId: "provider-entry-order", clientOid: "darwin-entry-oid", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG", tradeSide: "open", createdAt: openedAt, origin: "DARWIN" },
      { providerOrderId: "reduce-1", clientOid: "darwin-reduce-1", symbol: "SAMSUNGUSDT", side: "sell", positionSide: "LONG", tradeSide: "close", createdAt: "2026-09-21T17:10:00.000Z", origin: "DARWIN" },
      increaseOrder,
    ],
    fills: [
      { providerOrderId: "provider-entry-order", clientOid: "darwin-entry-oid", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG", tradeSide: "open", quantity: "10", execPrice: "100", createdAt: openedAt, origin: "DARWIN" },
      { providerOrderId: "reduce-1", clientOid: "darwin-reduce-1", symbol: "SAMSUNGUSDT", side: "sell", positionSide: "LONG", tradeSide: "close", quantity: "5", execPrice: "105", createdAt: "2026-09-21T17:10:00.000Z", origin: "DARWIN" },
      { providerOrderId: "increase-1", clientOid: "darwin-increase-1", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG", tradeSide: "open", quantity: "5", execPrice: "110", createdAt: "2026-09-21T17:15:00.000Z", origin: increaseOrigin },
    ],
  };
};

describe("provider/local lifecycle reconciliation", () => {
  it("replays current cost basis across reduce then increase instead of averaging all historical opens", () => {
    expect(classifyProviderLifecycle(costBasisFixture("105"))).toMatchObject({ classification: "MATCHED_OPEN" });
  });

  it("rejects a live avgPrice that matches gross opening-fill average but not current cost basis", () => {
    expect(classifyProviderLifecycle(costBasisFixture("103.333333"))).toMatchObject({
      classification: "CONTRADICTORY",
      reason: "CURRENT_POSITION_COST_BASIS_MISMATCH",
    });
  });

  it("does not classify an externally increased current position as fully DARWIN-owned", () => {
    expect(classifyProviderLifecycle(costBasisFixture("105", "PROVIDER_EXTERNAL")).classification).toBe("PROVIDER_EXTERNAL");
  });

  it("fails closed when a current-position increase is unattributed", () => {
    expect(classifyProviderLifecycle(costBasisFixture("105", "UNATTRIBUTED"))).toMatchObject({
      classification: "UNRESOLVED",
      reason: "LIFECYCLE_FILL_ORIGIN_UNATTRIBUTED",
    });
  });

  it("classifies a provider/local open lifecycle only when current-position and entry identity evidence match", () => {
    const original = fixture();
    const evidence = {
      ...original,
      experience: { ...experience, entryPrice: "92.45", entryTime: "2026-09-21T17:03:36.000Z" },
      history: null,
      providerPositions: [{ symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "7.51", entryPrice: "92.11", openedAt: "2026-09-21T17:03:30.661Z" }],
      orders: original.orders.filter((order) => order.tradeSide === "open"),
      fills: original.fills.filter((fill) => fill.tradeSide === "open").map((fill) => ({ ...fill, execPrice: "92.11" })),
    };
    expect(classifyProviderLifecycle(evidence).classification).toBe("MATCHED_OPEN");
  });

  it("reconstructs a closed lifecycle across an opening increase and all closing fills", () => {
    const original = fixture();
    const increaseOrder = { providerOrderId: "increase-1", clientOid: "darwin-increase-1", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG" as const, tradeSide: "open", createdAt: "2026-09-21T17:10:00.000Z", origin: "DARWIN" as const };
    const increaseFill = { providerOrderId: "increase-1", clientOid: "darwin-increase-1", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG" as const, tradeSide: "open", quantity: "2", execPrice: "110", createdAt: "2026-09-21T17:10:00.000Z", origin: "DARWIN" as const };
    const additionalCloseOrder = { providerOrderId: "close-extra", clientOid: "darwin-close-extra", symbol: "SAMSUNGUSDT", side: "sell", positionSide: "LONG" as const, tradeSide: "close", createdAt: "2026-09-22T00:00:00.000Z", origin: "DARWIN" as const };
    const additionalCloseFill = { providerOrderId: "close-extra", clientOid: "darwin-close-extra", symbol: "SAMSUNGUSDT", side: "sell", positionSide: "LONG" as const, tradeSide: "close", quantity: "2", execPrice: "202.66", createdAt: "2026-09-22T00:00:00.000Z", origin: "DARWIN" as const };
    const evidence = {
      ...original,
      history: { ...original.history!, openTotalPos: "9.51", closeTotalPos: "9.51", avgEntryPrice: "102.10" },
      orders: [...original.orders, increaseOrder, additionalCloseOrder],
      fills: [...original.fills.map((fill) => fill.tradeSide === "open" ? { ...fill, execPrice: "100" } : fill), increaseFill, additionalCloseFill],
    };
    expect(classifyProviderLifecycle(evidence)).toMatchObject({ classification: "LOCAL_OPEN_PROVIDER_CLOSED", closedQuantity: "9.51" });
  });

  it("reconciles an open position after an increase and partial reduction using provider quantity", () => {
    const original = fixture();
    const evidence = {
      ...original,
      history: { ...original.history!, openTotalPos: "9.51", closeTotalPos: "2", avgEntryPrice: "102.10", closingTime: "2026-09-22T00:00:00.000Z" },
      providerPositions: [{ symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "7.51", entryPrice: "102.10", openedAt: "2026-09-21T17:03:30.661Z" }],
      orders: [
        original.orders[0]!,
        { providerOrderId: "increase-1", clientOid: "darwin-increase-1", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG" as const, tradeSide: "open", createdAt: "2026-09-21T17:10:00.000Z", origin: "DARWIN" as const },
        { providerOrderId: "partial-close", clientOid: "darwin-partial-close", symbol: "SAMSUNGUSDT", side: "sell", positionSide: "LONG" as const, tradeSide: "close", createdAt: "2026-09-22T00:00:00.000Z", origin: "DARWIN" as const },
      ],
      fills: [
        ...original.fills.filter((fill) => fill.tradeSide === "open").map((fill) => ({ ...fill, execPrice: "100" })),
        { providerOrderId: "increase-1", clientOid: "darwin-increase-1", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG" as const, tradeSide: "open", quantity: "2", execPrice: "110", createdAt: "2026-09-21T17:10:00.000Z", origin: "DARWIN" as const },
        { providerOrderId: "partial-close", clientOid: "darwin-partial-close", symbol: "SAMSUNGUSDT", side: "sell", positionSide: "LONG" as const, tradeSide: "close", quantity: "2", execPrice: "202.66", createdAt: "2026-09-22T00:00:00.000Z", origin: "DARWIN" as const },
      ],
    };
    expect(classifyProviderLifecycle(evidence)).toMatchObject({ classification: "MATCHED_OPEN" });
  });

  it("does not attribute an externally increased position to DARWIN performance", () => {
    const original = fixture();
    const externalOrder = { providerOrderId: "external-increase", clientOid: "external-oid", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG" as const, tradeSide: "open", createdAt: "2026-09-21T17:10:00.000Z", origin: "PROVIDER_EXTERNAL" as const };
    const externalFill = { providerOrderId: "external-increase", clientOid: "external-oid", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG" as const, tradeSide: "open", quantity: "2", execPrice: "110", createdAt: "2026-09-21T17:10:00.000Z", origin: "PROVIDER_EXTERNAL" as const };
    const extraCloseOrder = { providerOrderId: "close-extra", clientOid: "darwin-close-extra", symbol: "SAMSUNGUSDT", side: "sell", positionSide: "LONG" as const, tradeSide: "close", createdAt: "2026-09-22T00:00:00.000Z", origin: "DARWIN" as const };
    const extraCloseFill = { providerOrderId: "close-extra", clientOid: "darwin-close-extra", symbol: "SAMSUNGUSDT", side: "sell", positionSide: "LONG" as const, tradeSide: "close", quantity: "2", execPrice: "202.66", createdAt: "2026-09-22T00:00:00.000Z", origin: "DARWIN" as const };
    const evidence = {
      ...original,
      history: { ...original.history!, openTotalPos: "9.51", closeTotalPos: "9.51", avgEntryPrice: "102.10" },
      orders: [...original.orders, externalOrder, extraCloseOrder],
      fills: [...original.fills.map((fill) => fill.tradeSide === "open" ? { ...fill, execPrice: "100" } : fill), externalFill, extraCloseFill],
    };
    expect(classifyProviderLifecycle(evidence)).toMatchObject({ classification: "PROVIDER_EXTERNAL" });
  });

  it("fails closed when a same-symbol quantity fill has no provider position side", () => {
    const original = fixture();
    const evidence = {
      ...original,
      fills: [...original.fills, {
        providerOrderId: "unattributed-no-side",
        clientOid: "manual-no-side",
        symbol: "SAMSUNGUSDT",
        side: null,
        positionSide: null,
        tradeSide: "open" as const,
        quantity: "0.25",
        execPrice: "198.02",
        createdAt: "2026-09-21T17:15:00.000Z",
        origin: "UNATTRIBUTED" as const,
      }],
    };
    expect(classifyProviderLifecycle(evidence).classification).toBe("UNRESOLVED");
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

  it("derives all UTA open and close directions from side plus positionSide when tradeSide is absent", () => {
    const cases = [
      { label: "LONG opening", positionSide: "LONG", openSide: "buy", closeSide: "sell", close: false },
      { label: "SHORT opening", positionSide: "SHORT", openSide: "sell", closeSide: "buy", close: false },
      { label: "LONG close", positionSide: "LONG", openSide: "buy", closeSide: "sell", close: true },
      { label: "SHORT close", positionSide: "SHORT", openSide: "sell", closeSide: "buy", close: true },
    ] as const;

    for (const example of cases) {
      const positionSide = example.positionSide;
      const openOrder = { providerOrderId: "open-order", clientOid: "open-oid", symbol: "SAMSUNGUSDT", side: example.openSide, positionSide, tradeSide: null, createdAt: "2026-09-21T17:03:30.661Z", origin: "DARWIN" };
      const closeOrder = { providerOrderId: "close-order", clientOid: "close-oid", symbol: "SAMSUNGUSDT", side: example.closeSide, positionSide, tradeSide: null, createdAt: "2026-09-21T17:04:30.661Z", origin: "DARWIN" };
      const openFill = { providerOrderId: "open-order", clientOid: "open-oid", symbol: "SAMSUNGUSDT", side: example.openSide, positionSide, tradeSide: null, quantity: "1", execPrice: "100", createdAt: "2026-09-21T17:03:30.661Z", origin: "DARWIN" };
      const closeFill = { providerOrderId: "close-order", clientOid: "close-oid", symbol: "SAMSUNGUSDT", side: example.closeSide, positionSide, tradeSide: null, quantity: "0.5", execPrice: "110", createdAt: "2026-09-21T17:04:30.661Z", origin: "DARWIN" };
      const evidence = {
        experience: { ...experience, positionSide, action: positionSide === "SHORT" ? "OPEN_SHORT" : "OPEN_LONG" },
        providerPositions: [{ symbol: "SAMSUNGUSDT", positionSide, quantity: example.close ? "0.5" : "1", entryPrice: "100", openedAt: "2026-09-21T17:03:30.661Z" }],
        history: null,
        entryIdentity: { entryDecisionId: experience.entryDecisionId, clientOid: "open-oid", providerOrderId: "open-order" },
        orders: example.close ? [openOrder, closeOrder] : [openOrder],
        fills: example.close ? [openFill, closeFill] : [openFill],
      } as unknown as ProviderLifecycleEvidence;
      expect(classifyProviderLifecycle(evidence), example.label).toMatchObject({ classification: "MATCHED_OPEN" });
    }
  });

  it("fails closed when explicit tradeSide conflicts with authoritative side and positionSide", () => {
    const evidence = {
      ...fixture(),
      history: null,
      providerPositions: [{ symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "1", entryPrice: "100", openedAt: "2026-09-21T17:03:30.661Z" }],
      orders: [{ providerOrderId: "provider-entry-order", clientOid: "darwin-entry-oid", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG", tradeSide: "close", createdAt: "2026-09-21T17:03:30.661Z", origin: "DARWIN" }],
      fills: [{ providerOrderId: "provider-entry-order", clientOid: "darwin-entry-oid", symbol: "SAMSUNGUSDT", side: "buy", positionSide: "LONG", tradeSide: "close", quantity: "1", execPrice: "100", createdAt: "2026-09-21T17:03:30.661Z", origin: "DARWIN" }],
    } as unknown as ProviderLifecycleEvidence;
    expect(classifyProviderLifecycle(evidence)).toMatchObject({ classification: "CONTRADICTORY", reason: "LIFECYCLE_FILL_SIDE_CONTRADICTORY" });
  });

  it("classifies the exact SAMSUNG fixture as LOCAL_OPEN_PROVIDER_CLOSED", () => {
    expect(classifyProviderLifecycle(fixture()).classification).toBe("LOCAL_OPEN_PROVIDER_CLOSED");
  });

  it("accepts the real provider opening-fill timestamp 2 ms before history while matching exact 7.51 quantity", () => {
    const original = fixture();
    const evidence = { ...original, fills: original.fills.map((fill, index) => index === 0 ? { ...fill, createdAt: "2026-09-21T17:03:30.659Z" } : fill) };
    expect(evidence.history?.openingTime).toBe("2026-09-21T17:03:30.661Z");
    expect(classifyProviderLifecycle(evidence)).toMatchObject({ classification: "LOCAL_OPEN_PROVIDER_CLOSED", closedQuantity: "7.51" });
  });

  it("uses proven provider entry identity rather than derived local entryTime", () => {
    const original = fixture();
    const evidence = {
      ...original,
      experience: { ...experience, entryTime: "2026-09-21T17:03:32.134Z" },
      fills: original.fills.map((fill, index) => index === 0 ? { ...fill, createdAt: "2026-09-21T17:03:30.659Z" } : fill),
    };
    expect(classifyProviderLifecycle(evidence)).toMatchObject({ classification: "LOCAL_OPEN_PROVIDER_CLOSED", closedQuantity: "7.51" });
  });

  it("does not let delayed local entryTime or conflicting local entryPrice override exact provider identity", () => {
    const original = fixture();
    const evidence = {
      ...original,
      experience: { ...experience, entryPrice: "92.45", entryTime: "2026-09-21T17:03:36.000Z" },
      fills: original.fills.map((fill, index) => index === 0 ? { ...fill, createdAt: "2026-09-21T17:03:30.659Z" } : fill),
    };
    expect(classifyProviderLifecycle(evidence)).toMatchObject({ classification: "LOCAL_OPEN_PROVIDER_CLOSED", closedQuantity: "7.51" });
  });

  it("rejects provider opening fills whose weighted entry price does not round to position history precision", () => {
    const original = fixture();
    const evidence = {
      ...original,
      fills: original.fills.map((fill, index) => index < 2 ? { ...fill, execPrice: "198.04" } : fill),
    };
    expect(classifyProviderLifecycle(evidence)).toMatchObject({ classification: "CONTRADICTORY", reason: "OPENING_FILL_WEIGHTED_PRICE_MISMATCH" });
  });

  it("uses the provider 92.11 entry despite local 92.45 and delayed local readback time", () => {
    const original = fixture();
    const evidence = {
      ...original,
      experience: { ...experience, entryPrice: "92.45", entryTime: "2026-09-21T17:03:36.000Z" },
      history: { ...original.history!, avgEntryPrice: "92.11" },
      fills: original.fills.map((fill, index) => index < 2 ? { ...fill, execPrice: "92.11", createdAt: "2026-09-21T17:03:30.659Z" } : fill),
    };
    expect(classifyProviderLifecycle(evidence)).toMatchObject({ classification: "LOCAL_OPEN_PROVIDER_CLOSED", closedQuantity: "7.51" });
    expect(evidence.history?.avgEntryPrice).toBe("92.11");
  });

  it("requires the exact opening-fill quantity after identity matching", () => {
    const original = fixture();
    const evidence = { ...original, fills: original.fills.map((fill, index) => index === 0 ? { ...fill, quantity: "7.50" } : fill) };
    expect(classifyProviderLifecycle(evidence)).toMatchObject({ classification: "CONTRADICTORY", reason: "OPENING_FILL_QUANTITY_RESIDUAL" });
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
