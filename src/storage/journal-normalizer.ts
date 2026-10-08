import type {
  CycleDecisionPlan,
  Decision,
  DecisionExecutionRecord,
  NormalizedCycleDecisions,
  ReconciliationResult,
  ExecutionResult,
  ExecutionRequest,
  RiskGateResult,
  TradeExperience,
  TradingJournal,
} from "../types.js";

function legacyPlan(journal: TradingJournal): CycleDecisionPlan {
  const positionActions: Decision[] = [];
  const entryActions: Decision[] = [];
  if (journal.decision) {
    if (journal.decision.action === "OPEN_LONG" || journal.decision.action === "OPEN_SHORT") entryActions.push(journal.decision);
    else positionActions.push(journal.decision);
  }
  for (const decision of journal.exitDecisions ?? []) {
    if (!positionActions.some((candidate) => candidate.decisionId === decision.decisionId)) positionActions.push(decision);
  }
  return {
    positionActions: positionActions as CycleDecisionPlan["positionActions"],
    entryActions: entryActions as CycleDecisionPlan["entryActions"],
  };
}

export function normalizeCycleDecisions(journal: TradingJournal): NormalizedCycleDecisions {
  return {
    cycleId: journal.cycleId,
    plan: journal.cyclePlan ?? legacyPlan(journal),
    records: journal.executionRecords ?? journal.exitExecutions ?? [],
    ...(journal.discovery ? { discovery: journal.discovery } : {}),
  };
}

export function journalHasPersistedPlan(journal: TradingJournal): boolean {
  return Boolean(journal.cyclePlan || journal.decision || journal.exitDecisions?.length);
}

export function cycleReadModel(journal: TradingJournal, status: "RUNNING" | "COMPLETED" | "FAILED", failureCode?: string): NormalizedCycleDecisions {
  const normalized = normalizeCycleDecisions(journal);
  const hasPersistedPlan = journalHasPersistedPlan(journal);
  const hasValidPlan = status === "COMPLETED" && hasPersistedPlan;
  return { ...normalized, status, hasPersistedPlan, hasValidPlan, ...(failureCode ? { failureCode } : {}) };
}

export function cyclePlanDecisions(journal: TradingJournal | null | undefined): Decision[] {
  if (!journal) return [];
  const normalized = normalizeCycleDecisions(journal);
  return [...normalized.plan.positionActions, ...normalized.plan.entryActions];
}

export function decisionCategory(journal: TradingJournal, decision: Decision): "POSITION_MANAGEMENT" | "NEW_ENTRY" {
  const normalized = normalizeCycleDecisions(journal);
  return normalized.plan.entryActions.some((candidate) => candidate.decisionId === decision.decisionId) ? "NEW_ENTRY" : "POSITION_MANAGEMENT";
}

export function executionRecordForDecision(journal: TradingJournal, decisionId: string): DecisionExecutionRecord | undefined {
  return normalizeCycleDecisions(journal).records.find((record) => record.decision.decisionId === decisionId);
}

export function effectiveExecutionRequest(journal: TradingJournal, decision: Decision, record?: DecisionExecutionRecord): ExecutionRequest | undefined {
  if (record?.executionRequest) return record.executionRequest;
  return journal.decision?.decisionId === decision.decisionId ? journal.executionRequest : undefined;
}

export function effectiveExecutionResult(journal: TradingJournal, decision: Decision, record?: DecisionExecutionRecord): ExecutionResult | undefined {
  if (record?.executionResult) return record.executionResult;
  return journal.decision?.decisionId === decision.decisionId ? journal.executionResult : undefined;
}

export function effectiveReconciliationResult(journal: TradingJournal, decision: Decision, record?: DecisionExecutionRecord): ReconciliationResult | undefined {
  if (record?.reconciliationResult) return record.reconciliationResult;
  return journal.decision?.decisionId === decision.decisionId ? journal.reconciliationResult : undefined;
}

export function effectiveRiskGateResult(journal: TradingJournal, decision: Decision, record?: DecisionExecutionRecord): RiskGateResult | undefined {
  if (record?.riskGateResult) return record.riskGateResult;
  return journal.decision?.decisionId === decision.decisionId ? journal.riskGateResult : undefined;
}

/**
 * Resolves the persisted risk gate evaluation that blocked a proposal, for read-only display.
 *
 * Identity is accepted only from the experience's explicit decision ID, or from an exact
 * experienceId/experienceIds journal link when that ID is absent. A journal-linked fallback must
 * leave exactly one BLOCK evaluation for the reflected action; symbol and timestamps are never
 * used to associate a decision with an experience.
 */
export function blockedRiskGateResult(
  experience: Pick<TradeExperience, "experienceId" | "outcomeStatus" | "action" | "lastAction" | "entryDecisionId" | "exitDecisionId">,
  journals: readonly TradingJournal[],
  evidenceComplete = true,
): RiskGateResult | undefined {
  if (experience.outcomeStatus !== "BLOCKED" || !evidenceComplete) return undefined;
  const currentAction = experience.lastAction ?? experience.action;
  const managementAction = currentAction === "CLOSE" || currentAction === "REDUCE";
  const entryAction = currentAction === "OPEN_LONG" || currentAction === "OPEN_SHORT";
  const suppliedId = managementAction ? experience.exitDecisionId : entryAction ? experience.entryDecisionId : undefined;
  const targetDecisionId = typeof suppliedId === "string" && suppliedId.trim().length > 0 ? suppliedId : undefined;
  const linkedMode = targetDecisionId === undefined;
  if (linkedMode && (typeof experience.experienceId !== "string" || experience.experienceId.trim().length === 0)) return undefined;

  const relevantJournals = linkedMode
    ? journals.filter((journal) => journal.experienceId === experience.experienceId
      || (Array.isArray(journal.experienceIds) && journal.experienceIds.some((linkedId) => linkedId === experience.experienceId)))
    : journals;
  if (relevantJournals.length === 0) return undefined;

  const recordsFor = (journal: TradingJournal): DecisionExecutionRecord[] => [
    ...(journal.executionRecords ?? []),
    ...(journal.exitExecutions ?? []),
  ];
  const candidateDecisionIds = new Set<string>();
  for (const journal of relevantJournals) {
    for (const record of recordsFor(journal)) {
      if (record.riskGateResult && record.decision.action === currentAction
        && (targetDecisionId ? record.decision.decisionId === targetDecisionId : true)) {
        candidateDecisionIds.add(record.decision.decisionId);
      }
    }
    if (journal.decision?.decisionId && journal.riskGateResult && journal.decision.action === currentAction
      && (targetDecisionId ? journal.decision.decisionId === targetDecisionId : true)) {
      candidateDecisionIds.add(journal.decision.decisionId);
    }
  }
  if (candidateDecisionIds.size === 0) return undefined;

  type EvaluationGroup = {
    decisionId: string;
    action: string;
    evaluations: Map<string, RiskGateResult>;
  };
  const groups = new Map<string, EvaluationGroup>();
  const identitiesByDecision = new Map<string, Set<string>>();
  let ambiguous = false;
  const add = (journal: TradingJournal, candidate: Decision, rawResult: unknown): void => {
    if (!candidateDecisionIds.has(candidate.decisionId) || rawResult === undefined || rawResult === null) return;
    if (typeof journal.cycleId !== "string" || journal.cycleId.trim().length === 0 || candidate.cycleId !== journal.cycleId) {
      ambiguous = true;
      return;
    }
    if (typeof rawResult !== "object") { ambiguous = true; return; }
    const result = rawResult as Partial<RiskGateResult>;
    if ((result.status !== "BLOCK" && result.status !== "PASS")
      || !Array.isArray(result.codes)
      || !result.codes.every((code) => typeof code === "string")
      || typeof result.checkedAt !== "string"
      || result.checkedAt.length === 0) {
      ambiguous = true;
      return;
    }
    const identity = JSON.stringify({
      journalCycleId: journal.cycleId,
      decisionCycleId: candidate.cycleId,
      decisionId: candidate.decisionId,
      action: candidate.action,
      symbol: candidate.symbol,
    });
    const identitySet = identitiesByDecision.get(candidate.decisionId) ?? new Set<string>();
    identitySet.add(identity);
    identitiesByDecision.set(candidate.decisionId, identitySet);
    const evaluation = JSON.stringify({ status: result.status, codes: result.codes, checkedAt: result.checkedAt });
    const group = groups.get(identity) ?? { decisionId: candidate.decisionId, action: candidate.action, evaluations: new Map<string, RiskGateResult>() };
    group.evaluations.set(evaluation, result as RiskGateResult);
    groups.set(identity, group);
  };

  for (const journal of relevantJournals) {
    for (const record of recordsFor(journal)) {
      if (candidateDecisionIds.has(record.decision.decisionId)) add(journal, record.decision, record.riskGateResult);
    }
    if (journal.decision && candidateDecisionIds.has(journal.decision.decisionId)) {
      add(journal, journal.decision, journal.riskGateResult);
    }
  }

  if (ambiguous || [...identitiesByDecision.values()].some((identities) => identities.size !== 1)
    || [...groups.values()].some((group) => group.evaluations.size !== 1)) return undefined;

  const candidates = [...groups.values()].filter((group) => group.action === currentAction
    && (linkedMode || group.decisionId === targetDecisionId));
  if (candidates.length !== 1) return undefined;
  const only = candidates[0]?.evaluations.values().next().value;
  return only?.status === "BLOCK" && only.codes.length > 0 ? only : undefined;
}
