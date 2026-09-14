import type {
  CycleDecisionPlan,
  Decision,
  DecisionExecutionRecord,
  NormalizedCycleDecisions,
  ReconciliationResult,
  ExecutionResult,
  ExecutionRequest,
  RiskGateResult,
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
