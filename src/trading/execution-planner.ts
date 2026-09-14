import type { AccountSnapshot, Decision, DecisionExecutionRecord, EvidenceBundle } from "../types.js";
import { financialWriteCount, MAX_FINANCIAL_WRITES_PER_CYCLE, orderCycleActions } from "../agent/decision.js";
import type { CycleDecisionPlan } from "../types.js";

export interface CyclePlanExecutionCallbacks {
  refreshEvidence: (symbol: string) => Promise<EvidenceBundle | undefined>;
  execute: (decision: Decision, bundle: EvidenceBundle, category: "POSITION_MANAGEMENT" | "NEW_ENTRY", parentDecision?: Decision) => Promise<DecisionExecutionRecord>;
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

function reverseLeg(decision: Decision, action: "CLOSE" | "OPEN_LONG" | "OPEN_SHORT"): Decision {
  if (action === "CLOSE") return { ...decision, decisionId: `${decision.decisionId}:close`, action, positionSide: decision.positionSide, marginAllocationPct: "0", additionalMarginPct: null, reductionPct: "100", targetPositionSide: null };
  return { ...decision, decisionId: `${decision.decisionId}:open`, action, positionSide: decision.targetPositionSide ?? null, additionalMarginPct: null, reductionPct: null, targetPositionSide: null };
}

function withParent(record: DecisionExecutionRecord, parent?: Decision): DecisionExecutionRecord {
  return parent ? { ...record, parentDecisionId: parent.decisionId, parentAction: "REVERSE", parentDecision: parent } : record;
}

function symbolStillOpen(account: AccountSnapshot, decision: Decision): boolean {
  return account.positions.some((position) => position.symbol === decision.symbol && Number(position.quantity) > 0);
}

/**
 * Serialize bounded plan execution. The next action is not evaluated until the
 * previous matched write has refreshed the provider portfolio.
 */
export async function executeCyclePlan(plan: CycleDecisionPlan, callbacks: CyclePlanExecutionCallbacks): Promise<CyclePlanExecutionResult> {
  const plannedFinancialWrites = [...plan.positionActions, ...plan.entryActions].reduce((total, action) => total + financialWriteCount(action.action), 0);
  if (plannedFinancialWrites > MAX_FINANCIAL_WRITES_PER_CYCLE) throw new Error("MAX_FINANCIAL_WRITES_PER_CYCLE");
  const records: DecisionExecutionRecord[] = [];
  let finalPortfolio: AccountSnapshot | undefined;
  let financialWrites = 0;
  const persistRecord = async (record: DecisionExecutionRecord, bundle: EvidenceBundle): Promise<DecisionExecutionRecord> => {
    const persisted = record;
    records.push(persisted);
    await callbacks.persist(persisted, bundle);
    if (persisted.executionResult) financialWrites += 1;
    return persisted;
  };
  const executeOne = async (decision: Decision, actionCategory: "POSITION_MANAGEMENT" | "NEW_ENTRY", parent?: Decision): Promise<{ record: DecisionExecutionRecord; bundle: EvidenceBundle }> => {
    if (financialWriteCount(decision.action) > 0 && financialWrites >= MAX_FINANCIAL_WRITES_PER_CYCLE) throw new Error("MAX_FINANCIAL_WRITES_PER_CYCLE");
    const bundle = await callbacks.refreshEvidence(decision.symbol);
    if (!bundle) throw new Error("EVIDENCE_READBACK_UNAVAILABLE");
    const record = withParent(await callbacks.execute(decision, bundle, actionCategory, parent), parent);
    await persistRecord(record, bundle);
    return { record, bundle };
  };
  const pendingReversals: Decision[] = [];
  for (const decision of orderCycleActions(plan)) {
    if (decision.action === "REVERSE") {
      const close = await executeOne(reverseLeg(decision, "CLOSE"), "POSITION_MANAGEMENT", decision);
      if (requiresStop(close.record) || !close.record.executionResult || close.record.executionResult.status !== "filled" || close.record.reconciliationResult?.status !== "MATCHED") {
        callbacks.onAmbiguousWrite?.(close.record);
        return { records, finalPortfolio, stoppedAfterAmbiguity: true };
      }
      finalPortfolio = await callbacks.refreshPortfolio();
      if (symbolStillOpen(finalPortfolio, decision)) {
        callbacks.onAmbiguousWrite?.(close.record);
        return { records, finalPortfolio, stoppedAfterAmbiguity: true };
      }
      pendingReversals.push(decision);
      continue;
    }
    const { record } = await executeOne(decision, category(plan, decision));
    if (requiresStop(record)) {
      callbacks.onAmbiguousWrite?.(record);
      return { records, finalPortfolio, stoppedAfterAmbiguity: true };
    }
    if (record.executionResult) finalPortfolio = await callbacks.refreshPortfolio();
  }
  for (const decision of pendingReversals) {
    const open = await executeOne(reverseLeg(decision, decision.targetPositionSide === "LONG" ? "OPEN_LONG" : "OPEN_SHORT"), "NEW_ENTRY", decision);
    if (requiresStop(open.record)) {
      callbacks.onAmbiguousWrite?.(open.record);
      return { records, finalPortfolio, stoppedAfterAmbiguity: true };
    }
    if (open.record.executionResult) finalPortfolio = await callbacks.refreshPortfolio();
  }
  return { records, finalPortfolio, stoppedAfterAmbiguity: false };
}
