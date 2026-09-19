import { DEFAULT_OWNER_POLICY } from "../src/trading/policy.js";
import { evaluateRiskGate } from "../src/trading/risk-gate.js";
import type {
  AccountSnapshot,
  ActivityEvent,
  CycleDecisionPlan,
  DashboardSnapshot,
  Decision,
  Instrument,
  MarketSnapshot,
  RiskGateResult,
  RuntimeConfig,
  TradeLogEntry,
} from "../src/types.js";

export type DemoScenario = "verified-open" | "hold" | "risk-reject";

export interface DemoSnapshot extends DashboardSnapshot {
  demoRiskGate: RiskGateResult;
  demo: {
    scenario: DemoScenario;
    title: string;
    evidenceLabel: "RECORDED_PROVIDER_REPLAY" | "DETERMINISTIC_RISK_REPLAY";
    writesBlocked: true;
    externalCalls: false;
    schedulerEnabled: false;
    qwenCalled: false;
    evaCalled: false;
    preTradeAccount: AccountSnapshot;
    postTradeAccount: AccountSnapshot;
  };
}

const OBSERVED_AT = "2026-09-13T00:00:00.000Z";
const SUPPORTED_UNIVERSE = ["CRCLUSDT", "KORUUSDT", "NVDAUSDT"];

const demoConfig: RuntimeConfig = {
  tradingMode: "PAPER",
  agentMode: "AUTONOMOUS",
  ownerPolicy: DEFAULT_OWNER_POLICY,
  evidenceMaxAgeSeconds: 90,
  bitgetCategory: "USDT-FUTURES",
  bitgetApiBaseUrl: "https://api.bitget.com",
  qwenBaseUrl: "https://hackathon.bitgetops.com/v1",
  qwenModel: "qwen3.8-max",
  version: "judge-demo",
  commit: "judge-demo",
  environment: "judge-demo",
};

const instrument: Instrument = {
  symbol: "CRCLUSDT",
  category: "USDT-FUTURES",
  baseCoin: "CRCL",
  quoteCoin: "USDT",
  marginCoin: "USDT",
  symbolType: "stock",
  isRwa: "YES",
  status: "online",
  minOrderQty: "0.01",
  maxOrderQty: "100000",
  minOrderAmount: "5",
  pricePrecision: 2,
  quantityPrecision: 2,
  quantityStep: "0.01",
  leverageMin: "1",
  leverageMax: "5",
};

const market: MarketSnapshot = { symbol: "CRCLUSDT", lastPrice: "91.7", bidPrice: "91.69", askPrice: "91.71", priceChange24h: "0", volume24h: "1000", observedAt: OBSERVED_AT };

function event(type: string, cycleId: string): ActivityEvent {
  return { eventId: `${cycleId}-${type}`, type, cycleId, createdAt: OBSERVED_AT };
}

function position(): AccountSnapshot["positions"][number] {
  return {
    symbol: "CRCLUSDT",
    positionSide: "LONG",
    quantity: "32.69",
    notional: "2996.3654",
    marginAllocated: "998.7884667",
    leverage: "3",
    entryPrice: "90.78",
    markPrice: "90.76",
    unrealizedPnl: "-0.6538",
    unrealizedPnlPct: "-0.0659896",
    realizedPnl: "0",
    liquidationPrice: "60.52",
    openedAt: OBSERVED_AT,
  };
}

function account(positions: AccountSnapshot["positions"]): AccountSnapshot {
  const totalNotional = positions.reduce((total, current) => total + Number(current.notional), 0).toFixed(4);
  const marginUsed = positions.reduce((total, current) => total + Number(current.marginAllocated), 0).toFixed(7);
  return {
    balance: "50000",
    availableBalance: "49001.2115333",
    availableMargin: "49001.2115333",
    marginUsage: marginUsed,
    positionNotional: totalNotional,
    totalPositionNotional: totalNotional,
    positionQuantity: positions.reduce((total, current) => total + Number(current.quantity), 0).toFixed(2),
    portfolioEquity: "50000",
    positions,
    realizedPnl: "0",
    unrealizedPnl: positions.reduce((total, current) => total + Number(current.unrealizedPnl), 0).toFixed(4),
    openOrders: 0,
    openOrderSymbols: [],
    observedAt: OBSERVED_AT,
  };
}

function decision(cycleId: string, action: Decision["action"], positionSide: Decision["positionSide"], symbol: string, leverage: string, thesis: string): Decision {
  return {
    decisionId: `${cycleId}-decision`,
    cycleId,
    action,
    positionSide,
    symbol,
    marginAllocationPct: action === "HOLD" ? "0" : "2",
    leverage,
    reductionPct: null,
    confidence: action === "HOLD" ? 0.51 : 0.78,
    thesis,
    strategyThesis: thesis,
    supportingFactors: action === "HOLD" ? ["Fresh position evidence remains within the recorded replay context"] : ["Recorded provider fill and readback evidence"],
    riskFactors: action === "HOLD" ? ["No new financial write is authorized by this replay"] : ["This is a recorded provider replay, not a local order"],
    evidenceUsed: ["recorded-market-context", "recorded-account-state"],
    lessonsUsed: [],
    createdAt: OBSERVED_AT,
  };
}

function riskResult(currentAccount: AccountSnapshot, proposed: Decision): RiskGateResult {
  return evaluateRiskGate(demoConfig, {
    decision: proposed,
    instrument,
    account: currentAccount,
    market,
    evidenceObservedAt: OBSERVED_AT,
    openOrderSymbols: [],
    supportedUniverse: SUPPORTED_UNIVERSE,
    emergencyStop: false,
    dailyDrawdownBlocked: false,
    now: new Date(OBSERVED_AT),
  });
}

function trade(): TradeLogEntry {
  return {
    tradeId: "RECORDED-CRCLUSDT-OPEN",
    timestamp: OBSERVED_AT,
    symbol: "CRCLUSDT",
    action: "OPEN_LONG",
    marginAllocationPct: "2",
    marginAllocated: "998.7884667",
    leverage: "3",
    positionNotional: "2996.3654",
    entry: "90.78",
    exit: "—",
    realizedPnl: "0",
    status: "OPEN",
    thesis: "Recorded CRCLUSDT PAPER lifecycle with provider fill, readback, and matched reconciliation.",
    orderReference: "RECORDED-CRCLUSDT-OPEN",
    positionSide: "LONG",
    openedAt: OBSERVED_AT,
  };
}

function baseSnapshot(cycleId: string, proposed: Decision, cyclePlan: CycleDecisionPlan, riskGateResult: RiskGateResult, preTradeAccount: AccountSnapshot, postTradeAccount: AccountSnapshot, scenario: DemoScenario, title: string, evidenceLabel: DemoSnapshot["demo"]["evidenceLabel"], activities: string[]): DemoSnapshot {
  const portfolio = postTradeAccount;
  const isRecordedOpen = scenario === "verified-open";
  return {
    version: "judge-demo",
    commit: "judge-demo",
    environment: "judge-demo",
    agent: {
      status: "PAUSED",
      runtimeMode: "AUTONOMOUS",
      currentStage: "JUDGE_REPLAY",
      lastScan: null,
      nextScan: null,
      model: "qwen3.8-max (fixture; not called)",
      paperMode: true,
    },
    portfolio,
    portfolioFreshness: { source: "JOURNAL_FALLBACK", observedAt: OBSERVED_AT, stale: true },
    performance: {
      totalPnl: "0",
      winRate: "0",
      dailyDrawdown: "0",
      totalTrades: 0,
      openTrades: 0,
      closedTrades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      verifiedRealizedPnl: "",
      competitionBaselineEquity: null,
      latestEquity: null,
      performanceBaselineAt: null,
      dailyPnl: {},
    },
    performanceAccounting: {
      baselineEquity: null,
      baselineObservedAt: null,
      baselineSource: "JUDGE_DEMO_FIXTURE",
      initializationReason: "RECORDED_REPLAY",
      currentEquity: portfolio.portfolioEquity,
      currentEquityObservedAt: OBSERVED_AT,
      equityDeltaSinceBaseline: "UNAVAILABLE",
      netExternalInflows: "UNAVAILABLE",
      externalFlowStatus: "UNVERIFIED_ZERO_FLOW_INVARIANT",
      netPnlSinceBaseline: "UNAVAILABLE",
      verifiedRealizedPnl: "UNAVAILABLE",
      unrealizedPnl: portfolio.unrealizedPnl,
      unrealizedPnlSource: portfolio.unrealizedPnlSource ?? "POSITIONS",
      wins: 0,
      losses: 0,
      breakeven: 0,
      classifiedClosedTrades: 0,
      winRatePct: "UNAVAILABLE",
      peakEquity: null,
      peakEquityObservedAt: null,
      currentDrawdownPct: "UNAVAILABLE",
      maxDrawdownPct: "UNAVAILABLE",
      source: "UNAVAILABLE",
    },
    trades: isRecordedOpen ? [trade()] : [],
    latestDecision: proposed,
    decisions: [proposed],
    latestCyclePlan: cyclePlan,
    latestCycleStatus: { cycleId, status: "COMPLETED", startedAt: OBSERVED_AT, completedAt: OBSERVED_AT, hasPersistedPlan: true, hasValidPlan: true },
    cyclePlans: [{ cycleId, plan: cyclePlan, records: [], status: "COMPLETED", hasPersistedPlan: true, hasValidPlan: true, startedAt: OBSERVED_AT, completedAt: OBSERVED_AT }],
    latestDiscovery: { scannedUniverseCount: SUPPORTED_UNIVERSE.length, selectedEntryCandidateSymbols: cyclePlan.entryActions.map((decision) => decision.symbol), managedExistingPositionSymbols: cyclePlan.positionActions.map((decision) => decision.symbol), financialWritesPerformed: 0 },
    executionEvidence: isRecordedOpen ? {
      provider: "Bitget Demo (recorded evidence)",
      action: "OPEN_LONG",
      symbol: "CRCLUSDT",
      marginAllocated: "998.7884667",
      leverage: "3",
      positionNotional: "2996.3654",
      orderReference: "RECORDED-CRCLUSDT-OPEN",
      executionStatus: "filled",
      reconciliationStatus: "MATCHED",
      timestamp: OBSERVED_AT,
    } : null,
    scheduler: { completedCycles: 0, averageDurationMs: 0, maxDurationMs: 0, inProgressCount: 0, staleCount: 0, failureCount: 0, timeoutCount: 0, nextScanAt: null, nextScanStale: false, configuredIntervalMinutes: 15, matchingScheduleCount: 0, schedulerHealthy: true },
    learning: { reflection: null, lessons: [], lessonsUsed: [], backtest: null, recentExperiences: [] },
    riskControls: { ...DEFAULT_OWNER_POLICY, drawdownBlocked: false, drawdownCode: "", cooldownUntil: null, temporaryScanIntervalExpiresAt: null },
    activity: activities.map((type) => event(type, cycleId)),
    lastPolicyUpdate: null,
    demoRiskGate: riskGateResult,
    demo: {
      scenario,
      title,
      evidenceLabel,
      writesBlocked: true,
      externalCalls: false,
      schedulerEnabled: false,
      qwenCalled: false,
      evaCalled: false,
      preTradeAccount,
      postTradeAccount,
    },
  };
}

export function buildDemoSnapshot(scenario: DemoScenario): DemoSnapshot {
  const cycleId = `JUDGE-${scenario.toUpperCase().replace(/-/g, "-")}`;
  if (scenario === "verified-open") {
    const preTradeAccount = account([]);
    const postTradeAccount = account([position()]);
    const proposed = decision(cycleId, "OPEN_LONG", "LONG", "CRCLUSDT", "3", "Recorded CRCLUSDT OPEN_LONG evidence shows a bounded proposal followed by provider fill, readback, and matched reconciliation.");
    return baseSnapshot(cycleId, proposed, { positionActions: [], entryActions: [proposed as CycleDecisionPlan["entryActions"][number]] }, riskResult(preTradeAccount, proposed), preTradeAccount, postTradeAccount, scenario, "Verified Open Replay", "RECORDED_PROVIDER_REPLAY", ["RECORDED_PROVIDER_FILL", "PROVIDER_READBACK", "RECONCILIATION_MATCHED"]);
  }
  if (scenario === "hold") {
    const preTradeAccount = account([position()]);
    const postTradeAccount = account([position()]);
    const proposed = decision(cycleId, "HOLD", "LONG", "CRCLUSDT", "3", "Fresh replay evidence does not justify changing the existing CRCLUSDT LONG position; no financial write is proposed.");
    const entry = decision(cycleId, "OPEN_LONG", "LONG", "NVDAUSDT", "2", "Independent recorded NVDAUSDT entry evidence justifies a bounded opportunity while CRCLUSDT remains HOLD.");
    return baseSnapshot(cycleId, proposed, { positionActions: [proposed as CycleDecisionPlan["positionActions"][number]], entryActions: [entry as CycleDecisionPlan["entryActions"][number]] }, riskResult(preTradeAccount, proposed), preTradeAccount, postTradeAccount, scenario, "Independent Management and Entry Replay", "RECORDED_PROVIDER_REPLAY", ["MARKET_SCAN", "POSITION_READBACK", "DECISION_CREATED", "NO_FINANCIAL_WRITE"]);
  }
  const preTradeAccount = account([]);
  const postTradeAccount = account([]);
  const proposed = decision(cycleId, "OPEN_LONG", "LONG", "CRCLUSDT", "6", "Synthetic proposal intentionally exceeds the owner leverage boundary to demonstrate deterministic rejection.");
  return baseSnapshot(cycleId, proposed, { positionActions: [], entryActions: [proposed as CycleDecisionPlan["entryActions"][number]] }, riskResult(preTradeAccount, proposed), preTradeAccount, postTradeAccount, scenario, "Risk Reject", "DETERMINISTIC_RISK_REPLAY", ["DECISION_CREATED", "RISK_GATE_BLOCK", "NO_ORDER_SUBMISSION"]);
}

export function normalizeScenario(value: string | null): DemoScenario {
  if (value === "hold" || value === "risk-reject") return value;
  return "verified-open";
}

export const DEMO_SCENARIOS: Array<{ id: DemoScenario; label: string }> = [
  { id: "verified-open", label: "Verified Open Replay" },
  { id: "hold", label: "Hold Existing Position" },
  { id: "risk-reject", label: "Risk Reject" },
];
