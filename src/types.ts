export type Action = "OPEN_LONG" | "OPEN_SHORT" | "HOLD" | "REDUCE" | "CLOSE";
export type PositionSide = "LONG" | "SHORT";
export type AgentMode = "AUTONOMOUS" | "EVA_EVALUATION";
export type TradingMode = "PAPER";
export type RiskStatus = "PASS" | "BLOCK";
export type ExecutionStatus =
  | "new"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "cancelled"
  | "rejected"
  | "not_found"
  | "unknown";
export type LessonStatus = "CANDIDATE" | "ACTIVE" | "WEAKENED" | "CONTRADICTED" | "RETIRED";
export type ExperienceOutcomeStatus = "PROFITABLE" | "LOSING" | "BREAK_EVEN" | "BLOCKED" | "EXECUTION_FAILURE" | "OPEN";
export type AgentRuntimeStatus = "ONLINE" | "SCANNING" | "ANALYZING" | "DECIDING" | "RISK_CHECK" | "EXECUTING" | "RECONCILING" | "REFLECTING" | "BACKTESTING" | "COOLDOWN" | "PAUSED" | "ERROR";
export type MarketRegime = "TRENDING_UP" | "TRENDING_DOWN" | "RANGE_LOW_VOL" | "RANGE_HIGH_VOL" | "VOLATILITY_EXPANSION" | "EVENT_DRIVEN" | "UNKNOWN";
export type LessonAssessment = "HELPFUL" | "NEUTRAL" | "HARMFUL";
export type TradeLifecycleStatus = "OPEN" | "PARTIALLY_REDUCED" | "CLOSED" | "BLOCKED" | "EXECUTION_FAILURE" | "UNRESOLVED";

export interface Env extends Cloudflare.Env {
  TRADER_AGENT: DurableObjectNamespace;
  ASSETS?: Fetcher;
  TRADING_MODE?: string;
  AGENT_MODE?: string;
  PAPER_ONLY?: string;
  BITGET_CATEGORY?: string;
  MAX_SINGLE_POSITION_MARGIN_PCT?: string;
  MAX_LEVERAGE?: string;
  MAX_DAILY_DRAWDOWN_PCT?: string;
  DRAWDOWN_COOLDOWN_MINUTES?: string;
  SCAN_INTERVAL_MINUTES?: string;
  EMERGENCY_STOP?: string;
  OWNER_CONTROL_TOKEN?: string;
  APP_VERSION?: string;
  GIT_COMMIT_SHA?: string;
  ENVIRONMENT?: string;
  EVIDENCE_MAX_AGE_SECONDS?: string;
  BITGET_API_KEY?: string;
  BITGET_SECRET_KEY?: string;
  BITGET_PASSPHRASE?: string;
  BITGET_API_BASE_URL?: string;
  QWEN_API_KEY?: string;
  QWEN_BASE_URL?: string;
  QWEN_MODEL?: string;
}

export interface RuntimeConfig {
  tradingMode: TradingMode;
  agentMode: AgentMode;
  ownerPolicy: OwnerPolicy;
  evidenceMaxAgeSeconds: number;
  bitgetCategory: string;
  bitgetApiKey?: string;
  bitgetSecretKey?: string;
  bitgetPassphrase?: string;
  bitgetApiBaseUrl: string;
  qwenApiKey?: string;
  qwenBaseUrl: string;
  qwenModel: string;
  version?: string;
  commit?: string;
  environment?: string;
}

export interface OwnerPolicy {
  paperOnly: true;
  maxSinglePositionMarginPct: string;
  maxLeverage: string;
  maxDailyDrawdownPct: string;
  drawdownCooldownMinutes: number;
  scanIntervalMinutes: number;
  emergencyStop: boolean;
}

export interface Instrument {
  symbol: string;
  category: string;
  baseCoin: string;
  quoteCoin: string;
  marginCoin: string;
  symbolType: string;
  isRwa: string;
  status: string;
  minOrderQty: string;
  maxOrderQty: string;
  minOrderAmount: string;
  pricePrecision: number;
  quantityPrecision: number;
  quantityStep: string;
  leverageMin: string;
  leverageMax: string;
}

export interface MarketSnapshot {
  symbol: string;
  lastPrice: string;
  bidPrice: string;
  askPrice: string;
  priceChange24h: string;
  volume24h: string;
  observedAt: string;
}

export interface HistoricalBar {
  observedAt: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface AccountSnapshot {
  balance: string;
  availableBalance: string;
  availableMargin: string;
  marginUsage: string;
  positionNotional: string;
  totalPositionNotional: string;
  positionQuantity: string;
  portfolioEquity: string;
  positions: PositionSnapshot[];
  realizedPnl: string;
  unrealizedPnl: string;
  openOrders: number;
  openOrderSymbols: string[];
  observedAt: string;
}

export interface PositionSnapshot {
  symbol: string;
  positionSide: PositionSide;
  quantity: string;
  notional: string;
  marginAllocated: string;
  leverage: string;
  entryPrice: string;
  unrealizedPnl: string;
  realizedPnl: string;
  openedAt?: string;
  liquidationPrice?: string;
}

export interface Evidence {
  source: string;
  observedAt: string;
  type: string;
  symbol: string;
  payload: unknown;
}

export interface EvidenceBundle {
  market: MarketSnapshot;
  account: AccountSnapshot;
  instrument: Instrument;
  historicalBars?: HistoricalBar[];
  marketRegime?: MarketRegime;
  evidence: Evidence[];
}

export interface Lesson {
  lessonId: string;
  lessonType: string;
  source: "SELF_OUTCOME" | "EXECUTION_FAILURE" | "RISK_GATE" | "BACKTEST_REPLAY" | "EVA_EVALUATION";
  symbolScope: string;
  marketRegime: string;
  trigger: string;
  failureCode: string;
  actionTaken: Action;
  observedOutcome: string;
  lesson: string;
  applicableConditions: string[];
  confidence: number;
  timesRetrieved: number;
  timesApplied: number;
  successfulApplications: number;
  failedApplications: number;
  status: LessonStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TradeExperience {
  experienceId: string;
  symbol: string;
  positionSide: PositionSide | null;
  action: Action;
  entryDecisionId: string;
  entryPrice: string;
  entryTime: string;
  exitDecisionId: string;
  exitPrice: string;
  exitTime: string;
  selectedLeverage: string;
  marginAllocationPct: string;
  marginAllocated: string;
  positionNotional: string;
  realizedPnl: string;
  realizedPnlPct: string;
  maximumFavorableExcursion: string;
  maximumAdverseExcursion: string;
  drawdownContribution: string;
  liquidationDistance: string;
  entryThesis: string;
  exitThesis: string;
  evidenceAtEntry: string[];
  evidenceAtExit: string[];
  lessonsUsed: string[];
  marketContext: string;
  outcomeStatus: ExperienceOutcomeStatus;
  lastAction?: Action;
  fees?: string;
  funding?: string;
  realizedPnlVerified?: boolean;
}

export interface BacktestMetric {
  hypothesis: string;
  returnPct: string;
  maxDrawdownPct: string;
  trades: number;
  wins: number;
  losses: number;
}

export interface BacktestReplay {
  backtestId: string;
  trigger: string;
  sourceTradeIds: string[];
  symbols: string[];
  historicalWindow: string;
  hypotheses: string[];
  baseline: string;
  metrics: BacktestMetric[];
  selectedLesson: string;
  createdAt: string;
}

export interface DecisionContext {
  bundles: EvidenceBundle[];
  supportedUniverse: string[];
  experiences: TradeExperience[];
  openExperiences: TradeExperience[];
  lessons: Lesson[];
  observedAt: string;
  mandate: string;
  openPositions: PositionSnapshot[];
}

export interface Decision {
  decisionId: string;
  cycleId: string;
  action: Action;
  positionSide: PositionSide | null;
  symbol: string;
  marginAllocationPct: string;
  leverage: string;
  reductionPct: string | null;
  confidence: number;
  thesis: string;
  strategyThesis: string;
  supportingFactors: string[];
  riskFactors: string[];
  evidenceUsed: string[];
  lessonsUsed: string[];
  createdAt: string;
}

export interface AutonomousDecisionSet {
  decision: Decision;
  exitDecisions: Decision[];
  ignoredLessonIds: string[];
}

export interface DecisionExecutionRecord {
  decision: Decision;
  riskGateResult: RiskGateResult;
  executionRequest?: ExecutionRequest;
  executionResult?: ExecutionResult;
  reconciliationResult?: ReconciliationResult;
  positionBefore?: PositionSnapshot;
  positionAfter?: PositionSnapshot;
  accountAfter?: AccountSnapshot;
}

export interface RiskGateResult {
  status: RiskStatus;
  codes: string[];
  checkedAt: string;
}

export interface ExecutionRequest {
  cycleId: string;
  decisionId: string;
  symbol: string;
  action: Exclude<Action, "HOLD">;
  positionSide: PositionSide;
  providerSide: "buy" | "sell";
  tradeSide: "open" | "close";
  marginAllocated: string;
  leverage: string;
  positionNotional: string;
  reductionPct: string | null;
  quantity: string;
  clientOrderId: string;
}

export interface ExecutionResult {
  provider: string;
  providerOrderId?: string;
  clientOrderId: string;
  symbol: string;
  action: Exclude<Action, "HOLD">;
  positionSide: PositionSide;
  providerSide: "buy" | "sell";
  tradeSide: "open" | "close";
  marginAllocated: string;
  leverage: string;
  positionNotional: string;
  requestedQuantity: string;
  executedQuantity: string;
  status: ExecutionStatus;
  submittedAt: string;
  readBackAt: string;
  providerCode?: string;
  providerMessage?: string;
  providerReadbackCode?: string;
  providerOperation?: string;
  providerReadbackMessage?: string;
  averageFillPrice?: string;
  fees?: string;
  funding?: string;
  realizedPnl?: string;
  realizedPnlPct?: string;
  liquidationDistance?: string;
}

export interface ReconciliationResult {
  status: "MATCHED" | "MISMATCH" | "UNKNOWN";
  codes: string[];
  execution: ExecutionResult;
  positionBefore?: PositionSnapshot;
  positionAfter?: PositionSnapshot;
  realizedPnl?: string;
}

export interface LessonEvaluation {
  lessonId: string;
  assessment: LessonAssessment;
  rationale: string;
}

export interface ReflectionResult {
  reflectionId: string;
  experienceId: string;
  createdAt: string;
  summary: string;
  strategyAssessment: string;
  directionAssessment: string;
  entryAssessment: string;
  exitAssessment: string;
  leverageAssessment: string;
  marginAssessment: string;
  evidenceAssessment: string;
  executionAssessment: string;
  outcomeAssessment: string;
  outcome: string;
  assumption: string;
  ignoredEvidence: string;
  lesson: string;
  applicableConditions: string[];
  confidence: number;
  lessonEvaluations: LessonEvaluation[];
}

export interface TradingJournal {
  cycleId: string;
  agentVersion: string;
  promptVersion?: string;
  model: string;
  mode: AgentMode;
  startedAt: string;
  completedAt?: string;
  marketContext?: unknown;
  portfolio?: AccountSnapshot;
  evidence?: Evidence[];
  retrievedLessons: string[];
  decision?: Decision;
  exitDecisions?: Decision[];
  exitExecutions?: DecisionExecutionRecord[];
  exitReflections?: ReflectionResult[];
  experienceIds?: string[];
  riskGateResult?: RiskGateResult;
  executionRequest?: ExecutionRequest;
  executionResult?: ExecutionResult;
  reconciliationResult?: ReconciliationResult;
  reflection?: ReflectionResult;
  backtest?: BacktestReplay;
  createdLessons: string[];
  experienceId?: string;
  positionBefore?: PositionSnapshot;
  positionAfter?: PositionSnapshot;
  positionDiscrepancies?: string[];
  durationMs?: number;
}

export interface ActivityEvent {
  eventId: string;
  type: string;
  cycleId: string;
  createdAt: string;
  metadata?: Record<string, string>;
}

export interface DashboardSnapshot {
  version: string;
  commit: string;
  environment: string;
  agent: {
    status: AgentRuntimeStatus;
    runtimeMode: AgentMode;
    currentStage: string;
    lastScan: string | null;
    nextScan: string | null;
    model: string;
    paperMode: true;
  };
  portfolio: AccountSnapshot | null;
  performance: {
    totalPnl: string;
    winRate: string;
    dailyDrawdown: string;
    totalTrades: number;
    wins: number;
    losses: number;
    breakeven: number;
    dailyPnl: Record<string, { pnl: string; trades: number }>;
  };
  trades: TradeLogEntry[];
  latestDecision: Decision | null;
  decisions: Decision[];
  executionEvidence: {
    provider: string;
    action: Exclude<Action, "HOLD">;
    symbol: string;
    marginAllocated: string;
    leverage: string;
    positionNotional: string;
    orderReference: string;
    executionStatus: ExecutionStatus;
    reconciliationStatus: ReconciliationResult["status"];
    providerCode?: string;
    providerMessage?: string;
    providerReadbackCode?: string;
    providerReadbackMessage?: string;
    timestamp: string;
  } | null;
  scheduler: {
    completedCycles: number;
    averageDurationMs: number;
    maxDurationMs: number;
    inProgressCount: number;
    staleCount: number;
    failureCount: number;
    timeoutCount: number;
  };
  learning: {
    reflection: ReflectionResult | null;
    lessons: Lesson[];
    lessonsUsed: string[];
    backtest: BacktestReplay | null;
    recentExperiences: TradeExperience[];
  };
  riskControls: OwnerPolicy & { drawdownBlocked: boolean; drawdownCode: string; cooldownUntil: string | null; temporaryScanIntervalExpiresAt: string | null };
  activity: ActivityEvent[];
  lastPolicyUpdate: ActivityEvent | null;
}

export interface TradeLogEntry {
  tradeId: string;
  timestamp: string;
  symbol: string;
  action: Exclude<Action, "HOLD">;
  marginAllocationPct: string;
  marginAllocated: string;
  leverage: string;
  positionNotional: string;
  entry: string;
  exit: string;
  realizedPnl: string;
  status: TradeLifecycleStatus;
  thesis: string;
  orderReference: string;
  positionSide?: PositionSide | null;
  openedAt?: string;
  closedAt?: string;
}
