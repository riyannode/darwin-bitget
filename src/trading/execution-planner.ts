import type { AccountSnapshot, Decision, DecisionExecutionRecord, EvidenceBundle } from "../types.js";
import { orderCycleActions } from "../agent/decision.js";
import type { CycleDecisionPlan } from "../types.js";

export interface CyclePlanExecutionCallbacks {
  refreshEvidence: (symbol: string) => Promise<EvidenceBundle | undefined>;
  execute: (decision: Decision, bundle: EvidenceBundle, category: "POSITION_MANAGEMENT" | "NEW_ENTRY") => Promise<DecisionExecutionRecord>;
  persist: (record: DecisionExecutionRecord, bundle: EvidenceBundle) => Promise<void>;
  refreshPortfolio: () => Promise<AccountSnapshot>;
  onAmbiguousWrite?: (record: DecisionExecutionRecord) => void;
}

export interface CyclePlanExecutionResult {
  records: DecisionExecutionRecord[];
  finalPortfolio: AccountSnapshot | undefined;
  stoppedAfterAmbiguity: boolean;
}

function category(plan: CycleDecisionPlan, decision: Decision): "POSITION_MANAGEMENT" | "NEW_ENTRY" {
  return plan.entryActions.some((entry) => entry.decisionId === decision.decisionId) ? "NEW_ENTRY" : "POSITION_MANAGEMENT";
}

function requiresStop(record: DecisionExecutionRecord): boolean {
  return Boolean(record.executionResult && (record.executionResult.status !== "filled" || record.reconciliationResult?.status !== "MATCHED"));
}

/**
 * Serialize bounded plan execution. The next action is not evaluated until the
 * previous matched write has refreshed the provider portfolio.
 */
export async function executeCyclePlan(plan: CycleDecisionPlan, callbacks: CyclePlanExecutionCallbacks): Promise<CyclePlanExecutionResult> {
  const records: DecisionExecutionRecord[] = [];
  let finalPortfolio: AccountSnapshot | undefined;
  for (const decision of orderCycleActions(plan)) {
    const bundle = await callbacks.refreshEvidence(decision.symbol);
    if (!bundle) throw new Error("EVIDENCE_READBACK_UNAVAILABLE");
    const record = await callbacks.execute(decision, bundle, category(plan, decision));
    records.push(record);
    await callbacks.persist(record, bundle);
    if (!requiresStop(record)) {
      if (record.executionResult) finalPortfolio = await callbacks.refreshPortfolio();
      continue;
    }
    callbacks.onAmbiguousWrite?.(record);
    return { records, finalPortfolio, stoppedAfterAmbiguity: true };
  }
  return { records, finalPortfolio, stoppedAfterAmbiguity: false };
}
