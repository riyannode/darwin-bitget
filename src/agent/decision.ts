import { z } from "zod";
import type {
  AutonomousDecisionSet,
  CycleDecisionPlan,
  Decision,
  DecisionContext,
  EntryDecision,
  MarketSnapshot,
  PositionManagementDecision,
  PositionSnapshot,
  RuntimeConfig,
} from "../types.js";
import { CANDIDATE_TASK_PROMPT, DECISION_TASK_PROMPT, TRADING_MANDATE } from "./mandate.js";
import { generateQwenJson } from "./qwen.js";

export const MAX_TOTAL_ACTIONS_PER_CYCLE = 5;

const decimalString = z.string().regex(/^\d+(?:\.\d{1,8})?$/);

const decisionFields = {
  action: z.enum(["OPEN_LONG", "OPEN_SHORT", "HOLD", "REDUCE", "CLOSE"]),
  positionSide: z.enum(["LONG", "SHORT"]).nullable(),
  symbol: z.string().min(1),
  marginAllocationPct: decimalString,
  leverage: decimalString,
  reductionPct: decimalString.nullable(),
  confidence: z.number().min(0).max(1),
  thesis: z.string().min(1).max(500),
  strategyThesis: z.string().min(1).max(500),
  supportingFactors: z.array(z.string().min(1).max(240)).max(8),
  riskFactors: z.array(z.string().min(1).max(240)).max(8),
  evidenceUsed: z.array(z.string().min(1)).max(12),
  lessonsUsed: z.array(z.string().min(1)).max(5),
};

type DecisionFields = z.infer<z.ZodObject<typeof decisionFields>>;

function validateDecisionSemantics(decision: DecisionFields, context: z.RefinementCtx): void {
  const openingSide = decision.action === "OPEN_LONG" ? "LONG" : decision.action === "OPEN_SHORT" ? "SHORT" : null;
  if (openingSide && decision.positionSide !== openingSide) context.addIssue({ code: "custom", path: ["positionSide"], message: "INVALID_POSITION_SIDE" });
  if ((decision.action === "REDUCE" || decision.action === "CLOSE") && !decision.positionSide) context.addIssue({ code: "custom", path: ["positionSide"], message: "POSITION_SIDE_REQUIRED" });
  if (decision.action === "REDUCE" && (!decision.reductionPct || Number(decision.reductionPct) <= 0 || Number(decision.reductionPct) >= 100)) context.addIssue({ code: "custom", path: ["reductionPct"], message: "INVALID_REDUCTION_PCT" });
  if (decision.action === "CLOSE" && decision.reductionPct !== null && decision.reductionPct !== "100") context.addIssue({ code: "custom", path: ["reductionPct"], message: "INVALID_REDUCTION_PCT" });
  if ((decision.action === "HOLD" || decision.action === "REDUCE" || decision.action === "CLOSE") && decision.marginAllocationPct !== "0") context.addIssue({ code: "custom", path: ["marginAllocationPct"], message: "INVALID_MARGIN_ALLOCATION" });
  if (decision.action === "HOLD" && decision.positionSide !== null && !["LONG", "SHORT"].includes(decision.positionSide)) context.addIssue({ code: "custom", path: ["positionSide"], message: "INVALID_POSITION_SIDE" });
}

export const decisionSchema = z.object({
  decisionId: z.string().min(1),
  cycleId: z.string().min(1),
  ...decisionFields,
  createdAt: z.string().datetime(),
}).superRefine(validateDecisionSemantics);

const modelPositionActionSchema = z.object(decisionFields).superRefine((decision, context) => {
  validateDecisionSemantics(decision, context);
  if (!decision.positionSide) context.addIssue({ code: "custom", path: ["positionSide"], message: "POSITION_SIDE_REQUIRED" });
  if (!["HOLD", "REDUCE", "CLOSE"].includes(decision.action)) context.addIssue({ code: "custom", path: ["action"], message: "POSITION_MANAGEMENT_ACTION_REQUIRED" });
});

const modelEntryActionSchema = z.object(decisionFields).superRefine((decision, context) => {
  validateDecisionSemantics(decision, context);
  if (decision.action !== "OPEN_LONG" && decision.action !== "OPEN_SHORT") context.addIssue({ code: "custom", path: ["action"], message: "NEW_ENTRY_ACTION_REQUIRED" });
});

export const cycleDecisionPlanSchema = z.object({
  positionActions: z.array(modelPositionActionSchema).max(MAX_TOTAL_ACTIONS_PER_CYCLE),
  entryActions: z.array(modelEntryActionSchema).max(MAX_TOTAL_ACTIONS_PER_CYCLE),
}).superRefine((plan, context) => {
  if (plan.positionActions.length + plan.entryActions.length > MAX_TOTAL_ACTIONS_PER_CYCLE) context.addIssue({ code: "custom", path: [], message: "MAX_TOTAL_ACTIONS_PER_CYCLE" });
});

export type DecisionInput = z.infer<typeof decisionSchema>;

const candidateSchema = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(5).refine((symbols) => new Set(symbols).size === symbols.length, "DUPLICATE_CANDIDATE"),
  rationale: z.array(z.string().min(1).max(240)).max(8),
});

const MAX_CANDIDATE_POOL = 25;

function metric(value: string, absolute = false): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return absolute ? Math.abs(parsed) : Math.max(parsed, 0);
}

export function rankMarketCandidates(scan: readonly MarketSnapshot[], limit = MAX_CANDIDATE_POOL): MarketSnapshot[] {
  const boundedLimit = Math.min(MAX_CANDIDATE_POOL, Math.max(1, Math.floor(limit)));
  const maxVolume = Math.max(0, ...scan.map((snapshot) => metric(snapshot.volume24h)));
  const maxPriceChange = Math.max(0, ...scan.map((snapshot) => metric(snapshot.priceChange24h, true)));
  return scan.map((snapshot) => {
    const volume = metric(snapshot.volume24h);
    const priceChange = metric(snapshot.priceChange24h, true);
    const activityScore = (maxVolume ? volume / maxVolume : 0) + (maxPriceChange ? priceChange / maxPriceChange : 0);
    return { snapshot, volume, priceChange, activityScore };
  }).sort((left, right) => {
    if (right.activityScore !== left.activityScore) return right.activityScore - left.activityScore;
    if (right.volume !== left.volume) return right.volume - left.volume;
    if (right.priceChange !== left.priceChange) return right.priceChange - left.priceChange;
    return left.snapshot.symbol < right.snapshot.symbol ? -1 : left.snapshot.symbol > right.snapshot.symbol ? 1 : 0;
  }).slice(0, boundedLimit).map((entry) => entry.snapshot);
}

export function buildDecisionPrompt(context: DecisionContext, cycleId: string): string {
  const account = context.bundles[0]?.account;
  const portfolio = account ? {
    portfolioEquity: account.portfolioEquity,
    availableMargin: account.availableMargin,
    marginUsage: account.marginUsage,
    totalPositionNotional: account.totalPositionNotional,
    realizedPnl: account.realizedPnl,
    unrealizedPnl: account.unrealizedPnl,
    positions: account.positions,
    openOrders: account.openOrders,
    openOrderSymbols: account.openOrderSymbols,
  } : null;
  const deepEvidence = context.bundles.map((bundle) => ({
    symbol: bundle.instrument.symbol,
    market: {
      lastPrice: bundle.market.lastPrice,
      bidPrice: bundle.market.bidPrice,
      askPrice: bundle.market.askPrice,
      priceChange24h: bundle.market.priceChange24h,
      volume24h: bundle.market.volume24h,
      observedAt: bundle.market.observedAt,
    },
    instrument: {
      symbol: bundle.instrument.symbol,
      minOrderQty: bundle.instrument.minOrderQty,
      maxOrderQty: bundle.instrument.maxOrderQty,
      minOrderAmount: bundle.instrument.minOrderAmount,
      pricePrecision: bundle.instrument.pricePrecision,
      quantityPrecision: bundle.instrument.quantityPrecision,
      quantityStep: bundle.instrument.quantityStep,
      leverageMin: bundle.instrument.leverageMin,
      leverageMax: bundle.instrument.leverageMax,
    },
    marketRegime: bundle.marketRegime ?? "UNKNOWN",
    historicalBars: bundle.historicalBars?.slice(-6) ?? [],
  }));
  const bundleBySymbol = new Map(deepEvidence.map((bundle) => [bundle.symbol, bundle]));
  return JSON.stringify({
    cycleId,
    currentTimestamp: context.observedAt,
    portfolio,
    supportedUniverse: context.supportedUniverse,
    openPositionSymbols: context.openPositionSymbols,
    entryCandidateSymbols: context.entryCandidateSymbols,
    openPositionEvidence: context.openPositionSymbols.map((symbol) => bundleBySymbol.get(symbol)).filter(Boolean),
    entryCandidateEvidence: context.entryCandidateSymbols.map((symbol) => bundleBySymbol.get(symbol)).filter(Boolean),
    deepEvidenceSymbols: context.bundles.map((bundle) => bundle.instrument.symbol),
    deepEvidence,
    openExperiences: context.openExperiences.slice(-10),
    experiences: context.experiences.filter((experience) => experience.outcomeStatus !== "EXECUTION_FAILURE").slice(-10),
    operationalEvidence: context.experiences.filter((experience) => experience.outcomeStatus === "EXECUTION_FAILURE").slice(-10).map((experience) => ({ experienceId: experience.experienceId, symbol: experience.symbol, classification: "EXECUTION_FAILURE", strategyOutcome: "UNASSESSED" })),
    lessons: context.lessons.filter((lesson) => lesson.source !== "EXECUTION_FAILURE"),
    constraints: {
      positionActions: ["HOLD", "REDUCE", "CLOSE"],
      entryActions: ["OPEN_LONG", "OPEN_SHORT"],
      maxTotalActionsPerCycle: MAX_TOTAL_ACTIONS_PER_CYCLE,
      paperOnly: true,
      noChainOfThought: true,
      managementRule: "Every open provider position appears exactly once in positionActions. HOLD requires its current position side and does not write.",
      entryRule: "entryActions are optional and must use current deep evidence for supportedUniverse candidates.",
      executionAuthority: "Deterministic TypeScript validates and orders financial writes; the model is not financial authority.",
    },
  });
}

export async function selectCandidates(
  config: RuntimeConfig,
  supportedUniverse: readonly string[],
  scan: readonly MarketSnapshot[],
): Promise<string[]> {
  const candidateScan = scan.map((snapshot) => [snapshot.symbol, snapshot.lastPrice, snapshot.priceChange24h, snapshot.volume24h]);
  const candidatePool = scan.map((snapshot) => snapshot.symbol);
  const result = await generateQwenJson(config, candidateSchema, `${TRADING_MANDATE}\n${CANDIDATE_TASK_PROMPT}`, JSON.stringify({ candidatePool, scan: candidateScan }), { maxOutputTokens: 700, timeoutMs: 30_000 });
  const candidates = result.symbols;
  if (candidates.some((symbol) => !supportedUniverse.includes(symbol) || !candidatePool.includes(symbol))) throw new Error("SYMBOL_NOT_ALLOWED");
  return candidates;
}

export function normalizeLessonReferences(ids: readonly string[], knownLessonIds: ReadonlySet<string>): { accepted: string[]; ignored: string[] } {
  const accepted: string[] = [];
  const ignored: string[] = [];
  for (const id of ids) {
    if (knownLessonIds.has(id)) accepted.push(id);
    else ignored.push(id);
  }
  return { accepted, ignored };
}

function positionKey(symbol: string, positionSide: string | null): string {
  return `${symbol}:${positionSide ?? "NONE"}`;
}

function liveOpenPositions(positions: readonly PositionSnapshot[]): PositionSnapshot[] {
  return positions.filter((position) => Number(position.quantity) > 0);
}

export function assertOpenPositionCountWithinPlanLimit(openPositions: readonly PositionSnapshot[]): void {
  if (liveOpenPositions(openPositions).length > MAX_TOTAL_ACTIONS_PER_CYCLE) throw new Error("OPEN_POSITION_COUNT_EXCEEDS_PLAN_LIMIT");
}

export function validateCycleDecisionPlan(plan: CycleDecisionPlan, context: DecisionContext): void {
  const currentPositions = liveOpenPositions(context.openPositions);
  assertOpenPositionCountWithinPlanLimit(currentPositions);
  if (plan.positionActions.length + plan.entryActions.length > MAX_TOTAL_ACTIONS_PER_CYCLE) throw new Error("MAX_TOTAL_ACTIONS_PER_CYCLE");
  const currentKeys = new Set(currentPositions.map((position) => positionKey(position.symbol, position.positionSide)));
  const currentSymbols = new Set(currentPositions.map((position) => position.symbol));
  const managementKeys = new Set<string>();
  for (const action of plan.positionActions) {
    if (!action.positionSide) throw new Error("POSITION_SIDE_REQUIRED");
    const key = positionKey(action.symbol, action.positionSide);
    if (managementKeys.has(key)) throw new Error("DUPLICATE_MANAGEMENT_ACTION");
    if (!currentKeys.has(key)) throw new Error("POSITION_NOT_OPEN");
    managementKeys.add(key);
  }
  if (managementKeys.size !== currentKeys.size || [...currentKeys].some((key) => !managementKeys.has(key))) throw new Error("MISSING_POSITION_MANAGEMENT");
  const entrySymbols = new Set<string>();
  const deepSymbols = new Set(context.entryCandidateSymbols.filter((symbol) => context.bundles.some((bundle) => bundle.instrument.symbol === symbol)));
  for (const action of plan.entryActions) {
    const expectedSide = action.action === "OPEN_LONG" ? "LONG" : "SHORT";
    if (action.positionSide !== expectedSide) throw new Error("INVALID_POSITION_SIDE");
    if (!context.supportedUniverse.includes(action.symbol)) throw new Error("SYMBOL_NOT_ALLOWED");
    if (!deepSymbols.has(action.symbol)) throw new Error("ENTRY_EVIDENCE_REQUIRED");
    if (currentSymbols.has(action.symbol)) throw new Error("ENTRY_SYMBOL_ALREADY_OPEN");
    if (entrySymbols.has(action.symbol)) throw new Error("DUPLICATE_ENTRY_ACTION");
    entrySymbols.add(action.symbol);
  }
}

function materializeDecision(fields: DecisionFields, cycleId: string, createdAt: string): Decision {
  return decisionSchema.parse({ ...fields, decisionId: crypto.randomUUID(), cycleId, createdAt });
}

export function orderCycleActions(plan: CycleDecisionPlan): Decision[] {
  const rank = (action: Decision["action"]): number => action === "CLOSE" ? 0 : action === "REDUCE" ? 1 : action === "OPEN_LONG" || action === "OPEN_SHORT" ? 2 : 3;
  return [...plan.positionActions, ...plan.entryActions].sort((left, right) => rank(left.action) - rank(right.action)
    || left.symbol.localeCompare(right.symbol)
    || (left.positionSide ?? "").localeCompare(right.positionSide ?? "")
    || left.decisionId.localeCompare(right.decisionId));
}

export function boundExitDecisions(exitDecisions: readonly Decision[], openPositions: readonly PositionSnapshot[]): Decision[] {
  const openPositionKeys = new Set(liveOpenPositions(openPositions).map((position) => positionKey(position.symbol, position.positionSide)));
  return exitDecisions.filter((exitDecision) => openPositionKeys.has(positionKey(exitDecision.symbol, exitDecision.positionSide)));
}

export async function decide(config: RuntimeConfig, context: DecisionContext, cycleId: string): Promise<AutonomousDecisionSet> {
  const generated = await generateQwenJson(config, cycleDecisionPlanSchema, `${context.mandate}\n${DECISION_TASK_PROMPT}\nReturn positionActions and entryActions only. Do not generate IDs or timestamps. Do not expose chain-of-thought.`, buildDecisionPrompt(context, cycleId), { maxOutputTokens: 1800, timeoutMs: 60_000 });
  const createdAt = new Date().toISOString();
  const knownLessons = new Set(context.lessons.map((lesson) => lesson.lessonId));
  const ignoredLessonIds: string[] = [];
  const materialize = (fields: DecisionFields): Decision => {
    const lessons = normalizeLessonReferences(fields.lessonsUsed, knownLessons);
    ignoredLessonIds.push(...lessons.ignored);
    return materializeDecision({ ...fields, lessonsUsed: lessons.accepted }, cycleId, createdAt);
  };
  const plan: CycleDecisionPlan = {
    positionActions: generated.positionActions.map((action) => materialize(action) as PositionManagementDecision),
    entryActions: generated.entryActions.map((action) => materialize(action) as EntryDecision),
  };
  validateCycleDecisionPlan(plan, context);
  return { plan, ignoredLessonIds: [...new Set(ignoredLessonIds)] };
}
