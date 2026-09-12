import { z } from "zod";
import type { AutonomousDecisionSet, Decision, DecisionContext, MarketSnapshot, RuntimeConfig } from "../types.js";
import { CANDIDATE_TASK_PROMPT, DECISION_TASK_PROMPT, TRADING_MANDATE } from "./mandate.js";
import { generateQwenJson } from "./qwen.js";

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

function validateDecisionSemantics(decision: z.infer<z.ZodObject<typeof decisionFields>>, context: z.RefinementCtx): void {
  const openingSide = decision.action === "OPEN_LONG" ? "LONG" : decision.action === "OPEN_SHORT" ? "SHORT" : null;
  if (openingSide && decision.positionSide !== openingSide) context.addIssue({ code: "custom", path: ["positionSide"], message: "INVALID_POSITION_SIDE" });
  if ((decision.action === "REDUCE" || decision.action === "CLOSE") && !decision.positionSide) context.addIssue({ code: "custom", path: ["positionSide"], message: "POSITION_SIDE_REQUIRED" });
  if (decision.action === "REDUCE" && (!decision.reductionPct || Number(decision.reductionPct) <= 0 || Number(decision.reductionPct) >= 100)) context.addIssue({ code: "custom", path: ["reductionPct"], message: "INVALID_REDUCTION_PCT" });
  if (decision.action === "CLOSE" && decision.reductionPct !== null && decision.reductionPct !== "100") context.addIssue({ code: "custom", path: ["reductionPct"], message: "INVALID_REDUCTION_PCT" });
  if ((decision.action === "HOLD" || decision.action === "REDUCE" || decision.action === "CLOSE") && decision.marginAllocationPct !== "0") context.addIssue({ code: "custom", path: ["marginAllocationPct"], message: "INVALID_MARGIN_ALLOCATION" });
  if (decision.action === "HOLD" && decision.positionSide !== null) context.addIssue({ code: "custom", path: ["positionSide"], message: "INVALID_POSITION_SIDE" });
}

export const decisionSchema = z.object({
  decisionId: z.string().min(1),
  cycleId: z.string().min(1),
  ...decisionFields,
  createdAt: z.string().datetime(),
}).superRefine(validateDecisionSemantics);

const qwenExitDecisionSchema = z.object(decisionFields).superRefine((decision, context) => {
  validateDecisionSemantics(decision, context);
  if (decision.action !== "REDUCE" && decision.action !== "CLOSE") context.addIssue({ code: "custom", path: ["action"], message: "EXIT_ACTION_REQUIRED" });
});

export const autonomousDecisionSetSchema = z.object({
  ...decisionFields,
  exitDecisions: z.array(qwenExitDecisionSchema).max(25).default([]),
}).superRefine(validateDecisionSemantics);

export type DecisionInput = z.infer<typeof decisionSchema>;

const candidateSchema = z.object({
  symbols: z.array(z.string().min(1)).min(3).max(5).refine((symbols) => new Set(symbols).size === symbols.length, "DUPLICATE_CANDIDATE"),
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
  return JSON.stringify({
    cycleId,
    currentTimestamp: context.observedAt,
    portfolio,
    deepEvidenceSymbols: context.bundles.map((bundle) => bundle.instrument.symbol),
    deepEvidence,
    openExperiences: context.openExperiences.slice(-10),
    experiences: context.experiences.slice(-10),
    lessons: context.lessons,
    constraints: {
      actions: ["OPEN_LONG", "OPEN_SHORT", "HOLD", "REDUCE", "CLOSE"],
      paperOnly: true,
      noChainOfThought: true,
      openingRule: "OPEN_LONG uses LONG and OPEN_SHORT uses SHORT.",
      reductionRule: "REDUCE uses a percentage between 0 and 100.",
      closeRule: "CLOSE uses a position side and reductionPct null.",
      exitRule: "exitDecisions may contain multiple REDUCE or CLOSE actions for existing positions. The primary action may contain at most one new opening action.",
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

export async function decide(config: RuntimeConfig, context: DecisionContext, cycleId: string): Promise<AutonomousDecisionSet> {
  const generated = await generateQwenJson(config, autonomousDecisionSetSchema, `${context.mandate}\n${DECISION_TASK_PROMPT}\nReturn one primary action and optional exitDecisions. exitDecisions may only contain REDUCE or CLOSE for existing positions. Keep every rationale concise. Do not generate IDs or timestamps. Do not expose chain-of-thought.`, buildDecisionPrompt(context, cycleId), { maxOutputTokens: 1200, timeoutMs: 60_000 });
  const createdAt = new Date().toISOString();
  const decision = decisionSchema.parse({ ...generated, decisionId: crypto.randomUUID(), cycleId, createdAt });
  const exitDecisions = generated.exitDecisions.map((exitDecision) => decisionSchema.parse({ ...exitDecision, decisionId: crypto.randomUUID(), cycleId, createdAt }));
  const exitKeys = new Set<string>();
  for (const exitDecision of exitDecisions) {
    const key = `${exitDecision.symbol}:${exitDecision.positionSide}`;
    if (exitKeys.has(key)) throw new Error("DUPLICATE_EXIT");
    exitKeys.add(key);
  }
  const knownLessons = new Set(context.lessons.map((lesson) => lesson.lessonId));
  if (decision.lessonsUsed.some((lessonId) => !knownLessons.has(lessonId))) throw new Error("LESSON_REFERENCE_INVALID");
  if (exitDecisions.some((exitDecision) => exitDecision.lessonsUsed.some((lessonId) => !knownLessons.has(lessonId)))) throw new Error("LESSON_REFERENCE_INVALID");
  return { decision, exitDecisions };
}
