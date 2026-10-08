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
 *   - entry proposals are matched by entryDecisionId and management actions by exitDecisionId;
 *   - every persisted evaluation for that decision identity must agree exactly;
 *   - missing or conflicting identity/evaluation data yields no attribution.
 *
 * `experience` stores the previous entry separately from the latest action. For BLOCKED CLOSE
 * and REDUCE experiences, `lastAction` identifies the relevant `exitDecisionId`.
 */
export function blockedRiskGateResult(
  experience: Pick<TradeExperience, "outcomeStatus" | "action" | "lastAction" | "entryDecisionId" | "exitDecisionId">,
  journals: readonly TradingJournal[],
): RiskGateResult | undefined {
  if (experience.outcomeStatus !== "BLOCKED") return undefined;
  const lastAction = experience.lastAction ?? experience.action;
  const managementAction = lastAction === "CLOSE" || lastAction === "REDUCE";
  const decisionId = managementAction ? experience.exitDecisionId : experience.entryDecisionId;
  if (typeof decisionId !== "string" || decisionId.trim().length === 0) return undefined;

  type PersistedEvaluation = {
    journalCycleId: string;
    decisionCycleId: string;
    decisionId: string;
    action: string;
    symbol: string;
    status: string;
    codes: string[];
    checkedAt: string;
  };
  const evaluations = new Map<string, RiskGateResult>();
  let ambiguous = false;
  const add = (journal: TradingJournal, candidate: Decision | undefined, rawResult: unknown): void => {
    if (!candidate || candidate.decisionId !== decisionId || rawResult === undefined || rawResult === null) return;
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
    const evaluation: PersistedEvaluation = {
      journalCycleId: journal.cycleId,
      decisionCycleId: candidate.cycleId,
      decisionId: candidate.decisionId,
      action: candidate.action,
      symbol: candidate.symbol,
      status: result.status,
      codes: result.codes,
      checkedAt: result.checkedAt,
    };
    const signature = JSON.stringify(evaluation);
    evaluations.set(signature, result as RiskGateResult);
  };

  for (const journal of journals) {
    for (const candidate of cyclePlanDecisions(journal)) {
      if (candidate.decisionId === decisionId) {
        add(journal, candidate, executionRecordForDecision(journal, decisionId)?.riskGateResult);
      }
    }
    if (journal.decision?.decisionId === decisionId) add(journal, journal.decision, journal.riskGateResult);
    for (const record of [...(journal.executionRecords ?? []), ...(journal.exitExecutions ?? [])]) {
      if (record.decision.decisionId === decisionId) add(journal, record.decision, record.riskGateResult);
    }
  }

  if (ambiguous || evaluations.size !== 1) return undefined;
  const only = evaluations.values().next().value;
  if (!only || only.status !== "BLOCK" || only.codes.length === 0) return undefined;
  return only;
}
