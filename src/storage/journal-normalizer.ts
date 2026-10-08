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
 * Attribution is deliberately conservative and never inferred from trade fields:
 *   - only a gate that actually reported BLOCK contributes codes;
 *   - a candidate decision must be one the BLOCKED experience is attributed to;
 *   - if journals disagree about that decision, nothing is returned rather than guessing.
 *
 * `experience` may carry an `entryDecisionId` (entry proposals) or an `exitDecisionId` (blocked
 * management actions); both are matched against the recorded decision identity.
 */
export function blockedRiskGateResult(
  experience: Pick<TradeExperience, "outcomeStatus" | "entryDecisionId" | "exitDecisionId">,
  journals: readonly TradingJournal[],
): RiskGateResult | undefined {
  if (experience.outcomeStatus !== "BLOCKED") return undefined;
  const decisionIds = [...new Set([experience.entryDecisionId, experience.exitDecisionId].filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (decisionIds.length === 0) return undefined;
  const matches = new Map<string, string>();
  const results = new Map<string, RiskGateResult>();
  let ambiguous = false;
  for (const journal of journals) {
    for (const decision of cyclePlanDecisions(journal)) {
      if (!decisionIds.includes(decision.decisionId)) continue;
      const result = effectiveRiskGateResult(journal, decision, executionRecordForDecision(journal, decision.decisionId));
      if (!result || result.status !== "BLOCK" || result.codes.length === 0) continue;
      const signature = [...result.codes].join(",");
      const existing = matches.get(decision.decisionId);
      if (existing !== undefined && existing !== signature) ambiguous = true;
      matches.set(decision.decisionId, signature);
      results.set(decision.decisionId, result);
    }
  }
  if (ambiguous || results.size !== 1) return undefined;
  const [only] = results.values();
  return only;
}
