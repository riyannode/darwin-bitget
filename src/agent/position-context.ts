import type { Decision, PositionContext, PositionReasoning, PositionSide, TradeExperience, TradingJournal } from "../types.js";
import { cyclePlanDecisions, effectiveExecutionResult, effectiveReconciliationResult, normalizeCycleDecisions } from "../storage/journal-normalizer.js";
import { verifiedLifecycleFacts } from "../trading/performance.js";

export function decisionReasoning(decision: Decision): PositionReasoning {
  return {
    action: decision.action,
    thesis: decision.thesis,
    strategyThesis: decision.strategyThesis,
    supportingFactors: decision.supportingFactors,
    riskFactors: decision.riskFactors,
    evidenceUsed: decision.evidenceUsed,
    lessonsUsed: decision.lessonsUsed,
    confidence: decision.confidence,
    cycleId: decision.cycleId,
    decisionId: decision.decisionId,
    createdAt: decision.createdAt,
    ...(decision.additionalMarginPct !== undefined ? { additionalMarginPct: decision.additionalMarginPct } : {}),
    ...(decision.targetPositionSide !== undefined ? { targetPositionSide: decision.targetPositionSide } : {}),
  };
}

export function entryReasoning(decision: Decision, experience?: TradeExperience): PositionReasoning {
  const reasoning = decisionReasoning(decision);
  return experience ? { ...reasoning, ...(experience.entryThesis ? { thesis: experience.entryThesis } : {}), entryPrice: experience.entryPrice, entryTime: experience.entryTime, experienceId: experience.experienceId } : reasoning;
}

export function upsertPositionContext(
  current: PositionContext | null,
  decision: Decision,
  observedAt: string,
  experience?: TradeExperience,
  parentDecision?: Decision,
): PositionContext | null {
  const isEntry = decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT";
  const positionSide = (isEntry ? decision.positionSide : parentDecision?.positionSide ?? decision.positionSide) as PositionSide | null;
  if (!positionSide) return current;
  const management = parentDecision ?? decision;
  if (isEntry) {
    return {
      symbol: decision.symbol,
      positionSide,
      ...(experience ? { experienceId: experience.experienceId } : {}),
      entryDecisionId: decision.decisionId,
      entryReasoning: entryReasoning(decision, experience),
      managementEvents: parentDecision?.action === "REVERSE" ? [decisionReasoning(parentDecision)] : [],
      ...(parentDecision?.action === "REVERSE" ? { latestManagement: decisionReasoning(parentDecision) } : {}),
      updatedAt: observedAt,
    };
  }
  const latestManagement = decisionReasoning(management);
  const managementEvents = [...(current?.managementEvents ?? []), latestManagement].slice(-20);
  return {
    ...(current ?? { symbol: decision.symbol, positionSide }),
    symbol: decision.symbol,
    positionSide,
    managementEvents,
    latestManagement,
    updatedAt: observedAt,
  };
}

export function contextForPosition(contexts: readonly PositionContext[], symbol: string, positionSide: PositionSide): PositionContext | null {
  return contexts.find((context) => context.symbol === symbol && context.positionSide === positionSide) ?? null;
}

export function bootstrapPositionContexts(journals: readonly TradingJournal[], experiences: readonly TradeExperience[], initializedAt: string): PositionContext[] {
  const facts = verifiedLifecycleFacts(journals);
  const contexts = new Map<string, PositionContext>();
  const orderedJournals = [...journals].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  for (const journal of orderedJournals) {
    if (journal.mode !== "AUTONOMOUS") continue;
    const normalized = normalizeCycleDecisions(journal);
    const decisions = [...cyclePlanDecisions(journal), ...normalized.records.map((record) => record.decision)].filter((decision, index, list) => list.findIndex((candidate) => candidate.decisionId === decision.decisionId) === index);
    for (const decision of decisions) {
      const record = normalized.records.find((candidate) => candidate.decision.decisionId === decision.decisionId);
      const execution = effectiveExecutionResult(journal, decision, record);
      const reconciliation = effectiveReconciliationResult(journal, decision, record);
      if ((decision.action !== "OPEN_LONG" && decision.action !== "OPEN_SHORT") || execution?.status !== "filled" || reconciliation?.status !== "MATCHED" || !facts.verifiedOpenIds.has(decision.decisionId)) continue;
      const experience = experiences.find((candidate) => candidate.entryDecisionId === decision.decisionId);
      const contextDecision = !decision.positionSide && experience?.positionSide ? { ...decision, positionSide: experience.positionSide } : decision;
      const key = `${contextDecision.symbol}:${contextDecision.positionSide}`;
      const next = upsertPositionContext(contexts.get(key) ?? null, contextDecision, contextDecision.createdAt || initializedAt, experience);
      if (next) contexts.set(key, next);
    }
  }
  for (const journal of orderedJournals) {
    if (journal.mode !== "AUTONOMOUS") continue;
    for (const decision of cyclePlanDecisions(journal)) {
      if (decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT" || !decision.positionSide) continue;
      const key = `${decision.symbol}:${decision.positionSide}`;
      if (contexts.has(key)) {
        const next = upsertPositionContext(contexts.get(key) ?? null, decision, decision.createdAt || initializedAt);
        if (next) contexts.set(key, next);
      }
    }
  }
  return [...contexts.values()];
}
