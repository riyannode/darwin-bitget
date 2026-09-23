export type Action = "OPEN_LONG" | "OPEN_SHORT" | "HOLD" | "INCREASE" | "REDUCE" | "CLOSE" | "REVERSE";
export type FinancialWriteAction = Exclude<Action, "HOLD" | "REVERSE">;
export type PositionSide = "LONG" | "SHORT";
export type MaximumFavorableExcursionBasis = "SINCE_ENTRY" | "SINCE_FIRST_DETERMINISTIC_OBSERVATION";
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
export type ExperienceOutcomeStatus = "PROFITABLE" | "LOSING" | "BREAK_EVEN" | "CLOSED_UNCLASSIFIED" | "BLOCKED" | "EXECUTION_FAILURE" | "EXECUTION_UNRESOLVED" | "OPEN";
export type AgentRuntimeStatus = "ONLINE" | "SCANNING" | "ANALYZING" | "DECIDING" | "RISK_CHECK" | "EXECUTING" | "RECONCILING" | "REFLECTING" | "BACKTESTING" | "COOLDOWN" | "PAUSED" | "ERROR";
export type MarketRegime = "TRENDING_UP" | "TRENDING_DOWN" | "RANGE_LOW_VOL" | "RANGE_HIGH_VOL" | "VOLATILITY_EXPANSION" | "EVENT_DRIVEN" | "UNKNOWN";
export type LessonAssessment = "HELPFUL" | "NEUTRAL" | "HARMFUL";
export type TradeLifecycleStatus = "OPEN" | "PARTIALLY_REDUCED" | "CLOSED" | "BLOCKED" | "EXECUTION_FAILURE" | "UNRESOLVED";
export type ResearchSkill = "macro-analyst" | "market-intel" | "news-briefing" | "sentiment-analyst" | "technical-analysis";
export type ResearchStatus = "AVAILABLE" | "UNAVAILABLE" | "UNSUPPORTED" | "STALE";

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
  BITGET_API_BASE_URL?: string;
  BITGET_GATEWAY_URL?: string;
  BITGET_GATEWAY_SERVICE_SECRET?: string;
  QWEN_API_KEY?: string;
  QWEN_BASE_URL?: string;
  QWEN_MODEL?: string;
  BITGET_SIGNAL_ENABLED?: string;
  EVA_API_URL?: string;
  EVA_GATEWAY_URL?: string;
  EVA_AGENT_ID?: string;
  EVA_AGENT_API_KEY?: string;
}

export interface RuntimeConfig {
  tradingMode: TradingMode;
  agentMode: AgentMode;
  ownerPolicy: OwnerPolicy;
  evidenceMaxAgeSeconds: number;
  bitgetCategory: string;
  bitgetApiBaseUrl: string;
  bitgetGatewayUrl?: string;
  bitgetGatewayServiceSecret?: string;
  qwenApiKey?: string;
  qwenBaseUrl: string;
  qwenModel: string;
  bitgetSignalEnabled?: boolean;
  evaApiUrl?: string;
  evaGatewayUrl?: string;
  evaAgentId?: string;
  evaAgentApiKey?: string;
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
  accountMarginUsed?: string;
  initialMargin?: string;
  positionMargin?: string;
  positionNotional: string;
  totalPositionNotional: string;
  positionQuantity: string;
  portfolioEquity: string;
  positions: PositionSnapshot[];
  realizedPnl: string;
  positionRealizedPnl?: string;
  realizedPnlSource?: "ACCOUNT" | "POSITIONS";
  unrealizedPnl: string;
  unrealizedPnlSource?: "ACCOUNT" | "POSITIONS";
  funding?: string;
  fees?: string;
  cashDividend?: string;
  openOrders: number | null;
  openOrderSymbols: string[];
  openOrdersReadFailure?: {
    operation: string;
    code?: string;
    message?: string;
  };
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
  markPrice?: string;
  unrealizedPnl: string;
  unrealizedPnlPct?: string;
  realizedPnl: string;
  realizedPnlSource?: "CURRENT_POSITION" | "ACCOUNT";
  openedAt?: string;
  updatedAt?: string;
  liquidationPrice?: string;
  funding?: string;
  fees?: string;
  cashDividend?: string;
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

export interface PositionManagementState {
  symbol: string;
  positionSide: PositionSide;
  entryPrice: string;
  currentPrice: string;
  currentReturnPct: number;
  maximumFavorableReturnPct: number;
  maximumFavorableReturnBasis: MaximumFavorableExcursionBasis;
  profitGivebackPct: number;
  timeInTradeMinutes: number;
  priorManagementActions: Action[];
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
  /** Highest positive percentage return observed during this open trade lifecycle. */
  maximumFavorableExcursion: string;
  /** Whether the percentage-return peak is entry-based or legacy first-observation-based. */
  maximumFavorableExcursionBasis?: MaximumFavorableExcursionBasis;
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
  financialSource?: "LOCAL" | "PROVIDER_LEDGER";
  origin?: "DARWIN" | "PROVIDER_EXTERNAL" | "UNATTRIBUTED";
  providerPositionHistoryId?: string;
  closedQuantity?: string;
  cumRealisedPnl?: string;
  netProfit?: string;
  openFeeTotal?: string;
  closeFeeTotal?: string;
  totalFunding?: string;
  cashDividend?: string;
  /** Prior local estimate retained as evidence when provider ledger replaces it. */
  legacyLocalRealizedPnl?: string;
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
  openPositionSymbols: string[];
  entryCandidateSymbols: string[];
  experiences: TradeExperience[];
  openExperiences: TradeExperience[];
  lessons: Lesson[];
  observedAt: string;
  mandate: string;
  openPositions: PositionSnapshot[];
  positionManagementState?: PositionManagementState[];
  researchEvidence?: ResearchEvidence[];
  executionCapacityHints?: ExecutionCapacityHint[];
}

export interface ResearchRequest {
  skill: ResearchSkill;
  symbol: string | null;
  purpose: string;
}

export interface ResearchPlan {
  requests: ResearchRequest[];
}

export interface ResearchCycleSummary {
  cycleId: string;
  signalEnabled: boolean;
  availableSkillCount: number;
  routerAttempted: boolean;
  routerPlanRequestCount: number;
  acceptedRequestCount: number;
  rejectedRequestCount: number;
  requestedSkills: string[];
  requestedSymbols: string[];
  cacheHits: number;
  mcpConnectAttempts: number;
  mcpConnectSuccesses: number;
  mcpToolCalls: number;
  availableResults: number;
  unavailableResults: number;
  researchDurationMs: number;
  finalStatus: string;
}

export interface ResearchEvidence {
  skill: ResearchSkill;
  scope: string;
  observedAt: string;
  status: ResearchStatus;
  facts: string[];
  limitations: string[];
}

export interface ExecutionCapacityHint {
  symbol: string;
  minOrderQty: string;
  maxOrderQty: string;
  minOrderAmount: string;
  quantityStep: string;
  lastPrice: string;
  maxExecutableNotional: string;
  maxMarginAllocationPctByLeverage: Record<string, string>;
}

export interface Decision {
  decisionId: string;
  cycleId: string;
  action: Action;
  positionSide: PositionSide | null;
  symbol: string;
  marginAllocationPct: string;
  additionalMarginPct?: string | null | undefined;
  leverage: string;
  reductionPct: string | null;
  targetPositionSide?: PositionSide | null | undefined;
  confidence: number;
  thesis: string;
  strategyThesis: string;
  supportingFactors: string[];
  riskFactors: string[];
  evidenceUsed: string[];
  lessonsUsed: string[];
  createdAt: string;
}

export type PositionManagementAction = "HOLD" | "INCREASE" | "REDUCE" | "CLOSE" | "REVERSE";
export type EntryAction = "OPEN_LONG" | "OPEN_SHORT";

export interface PositionManagementDecision extends Decision {
  action: PositionManagementAction;
  positionSide: PositionSide;
}

export interface EntryDecision extends Decision {
  action: EntryAction;
  positionSide: PositionSide;
}

export interface CycleDecisionPlan {
  positionActions: PositionManagementDecision[];
  entryActions: EntryDecision[];
}

export interface CycleDiscovery {
  scannedUniverseCount: number;
  selectedEntryCandidateSymbols: string[];
  managedExistingPositionSymbols: string[];
  financialWritesPerformed: number;
}

export interface NormalizedCycleDecisions {
  cycleId: string;
  plan: CycleDecisionPlan;
  records: DecisionExecutionRecord[];
  discovery?: CycleDiscovery;
  status?: "RUNNING" | "COMPLETED" | "FAILED";
  failureCode?: string;
  failurePath?: string;
  failureIssue?: string;
  hasPersistedPlan?: boolean;
  hasValidPlan?: boolean;
}

export interface LatestValidCyclePlan {
  cycleId: string;
  plan: CycleDecisionPlan;
  discovery?: CycleDiscovery;
  startedAt: string;
  completedAt: string;
}

export interface AutonomousDecisionSet {
  plan: CycleDecisionPlan;
  ignoredLessonIds: string[];
}

export interface DecisionExecutionRecord {
  decision: Decision;
  parentDecisionId?: string;
  parentAction?: "REVERSE";
  parentDecision?: Decision;
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
  action: FinancialWriteAction;
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
  action: FinancialWriteAction;
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
  providerFailureClass?: string;
  providerCode?: string;
  providerMessage?: string;
  providerReadbackFailureClass?: string;
  providerReadbackCode?: string;
  providerOperation?: string;
  providerReadbackMessage?: string;
  averageFillPrice?: string;
  fees?: string;
  funding?: string;
  realizedPnl?: string;
  realizedPnlSource?: "FILL" | "POSITION_HISTORY_NET_PROFIT" | "POSITION_HISTORY_PNL";
  realizedPnlIncludesCosts?: boolean;
  realizedPnlPct?: string;
  cashDividend?: string;
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
  positionManagementState?: PositionManagementState[];
  promptVersions?: {
    mandate: string;
    decision: string;
  };
  model: string;
  mode: AgentMode;
  startedAt: string;
  completedAt?: string;
  marketContext?: unknown;
  portfolio?: AccountSnapshot;
  evidence?: Evidence[];
  retrievedLessons: string[];
  cyclePlan?: CycleDecisionPlan;
  executionRecords?: DecisionExecutionRecord[];
  discovery?: CycleDiscovery;
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
  portfolioFreshness: {
    source: "PROVIDER_LIVE" | "JOURNAL_FALLBACK" | "UNAVAILABLE";
    observedAt: string;
    stale: boolean;
    errorCode?: string;
  };
  performance: {
    totalPnl: string;
    winRate: string;
    dailyDrawdown: string;
    totalTrades: number | null;
    openTrades: number | null;
    closedTrades: number | null;
    wins: number | null;
    losses: number | null;
    breakeven: number | null;
    closedEpisodeRealizedPnl: string;
    openEpisodePartialRealizedPnl: string;
    verifiedRealizedPnl: string;
    competitionBaselineEquity: string | null;
    latestEquity: string | null;
    performanceBaselineAt: string | null;
    dailyPnl: Record<string, { pnl: string; trades: number; dailyReturnPct?: string }>;
  };
  performanceAccounting: PerformanceAccountingReadModel;
  trades: TradeLogEntry[];
  latestDecision: Decision | null;
  decisions: Decision[];
  latestCyclePlan: CycleDecisionPlan | null;
  latestCycleStatus: {
    cycleId: string;
    status: "RUNNING" | "COMPLETED" | "FAILED";
    startedAt: string;
    completedAt: string | null;
    hasPersistedPlan: boolean;
    hasValidPlan: boolean;
    failureCode?: string;
    failurePath?: string;
    failureIssue?: string;
  } | null;
  cyclePlans: Array<NormalizedCycleDecisions & { startedAt: string; completedAt: string | null }>;
  latestDiscovery: CycleDiscovery | null;
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
    nextScanAt: string | null;
    nextScanStale: boolean;
    configuredIntervalMinutes: number;
    matchingScheduleCount: number;
    schedulerHealthy: boolean;
    schedulerErrorCode?: string;
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

export interface PerformanceAccountingReadModel {
  baselineEquity: string | null;
  baselineObservedAt: string | null;
  baselineSource: string;
  initializationReason: string;
  competitionStartVerified: boolean;
  currentEquity: string | null;
  currentEquityObservedAt: string | null;
  equityDeltaSinceBaseline: string;
  netExternalInflows: string;
  externalFlowStatus: "VERIFIED" | "UNVERIFIED_ZERO_FLOW_INVARIANT";
  netPnlSinceBaseline: string;
  closedEpisodeRealizedPnl: string;
  openEpisodePartialRealizedPnl: string;
  verifiedRealizedPnl: string;
  unrealizedPnl: string;
  unrealizedPnlSource: "ACCOUNT" | "POSITIONS" | "UNAVAILABLE";
  wins: number;
  losses: number;
  breakeven: number;
  classifiedClosedTrades: number;
  winRatePct: string;
  peakEquity: string | null;
  peakEquityObservedAt: string | null;
  currentDrawdownPct: string;
  maxDrawdownPct: string;
  source: "PROVIDER_LIVE" | "PERSISTED_LEDGER" | "UNAVAILABLE";
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
  entryReasoning?: PositionReasoning;
  exitReasoning?: PositionReasoning;
  managementEvents?: PositionReasoning[];
}

export interface PositionReasoning {
  action: Action;
  thesis: string;
  strategyThesis: string;
  supportingFactors: string[];
  riskFactors: string[];
  evidenceUsed: string[];
  lessonsUsed: string[];
  confidence: number;
  cycleId: string;
  decisionId: string;
  createdAt: string;
  entryPrice?: string;
  entryTime?: string;
  experienceId?: string;
  additionalMarginPct?: string | null;
  targetPositionSide?: PositionSide | null;
}

export interface PositionContext {
  symbol: string;
  positionSide: PositionSide;
  experienceId?: string;
  entryDecisionId?: string;
  entryReasoning?: PositionReasoning;
  latestManagement?: PositionReasoning;
  managementEvents: PositionReasoning[];
  lifecycleStatus?: "OPEN" | "CLOSED";
  closedAt?: string;
  closedProviderPositionHistoryId?: string;
  updatedAt: string;
}
