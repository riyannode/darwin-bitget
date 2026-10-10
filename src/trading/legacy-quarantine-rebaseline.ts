import { isPositiveDecimal } from "./decimal.js";
import type { AccountSnapshot } from "../types.js";

/**
 * Owner-approved release of legacy execution quarantines.
 *
 * Root cause: a bounded order-history search cannot produce authoritative proof for an old
 * ambiguous write, so `UNRESOLVED_PRIOR_EXECUTION` blocks the symbol forever. Repeating the
 * search never terminates. This module decides which quarantines the owner may retire; the
 * agent performs the single transactional write that archives and clears them.
 *
 * Nothing here classifies the historical order. It is never marked FILLED, REJECTED or
 * RECONCILED — it is archived with its original identity and reason intact.
 */

/**
 * Inside this window a quarantine is still recoverable by bounded history search, so it is a
 * genuinely ambiguous recent write and stays fail-closed. Only an older quarantine is legacy.
 */
export const LEGACY_QUARANTINE_RECOVERABLE_WINDOW_MS = 2 * 60 * 60 * 1_000;

export type LegacyRebaselineBlocker =
  | "AGENT_NOT_PAUSED"
  | "PAPER_ONLY_REQUIRED"
  | "NO_APPROVED_LEGACY_QUARANTINE"
  | "PROVIDER_SNAPSHOT_READ_FAILED"
  | "PROVIDER_SNAPSHOT_UNSTABLE"
  | "RELEVANT_OPEN_ORDERS_PRESENT";

export interface LegacyQuarantineIdentity {
  symbol: string;
  cycleId: string;
  decisionId: string;
  clientOrderId: string;
}

export type ApprovedLegacyRejectionReason =
  | "IDENTITY_NOT_ACTIVE"
  | "DUPLICATE_REQUEST"
  | "STILL_RECOVERABLE_WITHIN_WINDOW";

export interface ApprovedLegacyRejection {
  identity: LegacyQuarantineIdentity;
  reason: ApprovedLegacyRejectionReason;
}

/** An active quarantine admitted for retirement, carrying its persisted original reason. */
export interface ApprovedLegacyQuarantine extends LegacyQuarantineIdentity {
  createdAt: string;
  reason: string;
}

export interface LegacyRebaselineAssessment {
  eligible: boolean;
  blockers: LegacyRebaselineBlocker[];
  /** Symbols currently held by the provider, which stay governed by normal position management. */
  providerPositionSymbols: string[];
}

/**
 * Length-prefixed so no separator inside a field can collide two identities, and printable ASCII
 * so the source file stays text.
 */
export function legacyQuarantineIdentityKey(identity: LegacyQuarantineIdentity): string {
  return [identity.symbol, identity.cycleId, identity.decisionId, identity.clientOrderId]
    .map((field) => `${field.length}:${field}`)
    .join("|");
}

/**
 * Narrow the owner's requested identities down to the ones that are actually legacy.
 *
 * The owner approves exact identities, never "everything currently quarantined". An empty or
 * absent request list is a rejection, never a bulk release.
 */
export function selectOwnerApprovedLegacyQuarantines(input: {
  requested: readonly LegacyQuarantineIdentity[];
  activeQuarantines: readonly ApprovedLegacyQuarantine[];
  nowMs: number;
}): { selected: ApprovedLegacyQuarantine[]; rejected: ApprovedLegacyRejection[] } {
  const activeByKey = new Map(input.activeQuarantines.map((entry) => [legacyQuarantineIdentityKey(entry), entry]));
  const selected: ApprovedLegacyQuarantine[] = [];
  const rejected: ApprovedLegacyRejection[] = [];
  const claimed = new Set<string>();

  for (const identity of input.requested) {
    const key = legacyQuarantineIdentityKey(identity);
    const active = activeByKey.get(key);
    if (!active) {
      rejected.push({ identity, reason: "IDENTITY_NOT_ACTIVE" });
      continue;
    }
    if (claimed.has(key)) {
      rejected.push({ identity, reason: "DUPLICATE_REQUEST" });
      continue;
    }
    const createdAtMs = Date.parse(active.createdAt);
    // An unparseable age is treated as still recoverable, so a recent ambiguous write is never
    // released on a record the system cannot date.
    if (!Number.isFinite(createdAtMs) || input.nowMs - createdAtMs <= LEGACY_QUARANTINE_RECOVERABLE_WINDOW_MS) {
      rejected.push({ identity, reason: "STILL_RECOVERABLE_WITHIN_WINDOW" });
      continue;
    }
    claimed.add(key);
    selected.push(active);
  }
  return { selected, rejected };
}

/**
 * Open-position fingerprint. Quantity and side are included because only a fill changes them, so
 * two consecutive reads must agree exactly. Mark price and equity are deliberately excluded: they
 * tick with the market between two reads and would reject a stable account.
 */
function openPositionFingerprint(account: AccountSnapshot): string[] {
  return account.positions
    .filter((position) => isPositiveDecimal(position.quantity))
    .map((position) => `${position.symbol}:${position.positionSide}:${position.quantity}`)
    .sort();
}

/**
 * Decide whether the approved legacy quarantine set may be retired.
 *
 * Requires a paused idle agent, PAPER demo mode, two agreeing provider reads, and no pending
 * provider order on a released symbol. Fails closed on every ambiguity.
 */
export function assessLegacyQuarantineRebaseline(input: {
  paused: boolean;
  runtimeStatus: string;
  cycleStartedAt: string | null;
  paperOnly: boolean;
  firstSnapshot: AccountSnapshot | null;
  secondSnapshot: AccountSnapshot | null;
  approvedQuarantineSymbols: readonly string[];
}): LegacyRebaselineAssessment {
  const blockers: LegacyRebaselineBlocker[] = [];
  if (!input.paused || input.runtimeStatus !== "PAUSED" || input.cycleStartedAt) blockers.push("AGENT_NOT_PAUSED");
  if (!input.paperOnly) blockers.push("PAPER_ONLY_REQUIRED");
  if (input.approvedQuarantineSymbols.length === 0) blockers.push("NO_APPROVED_LEGACY_QUARANTINE");

  const first = input.firstSnapshot;
  const second = input.secondSnapshot;
  if (!first || !second) {
    blockers.push("PROVIDER_SNAPSHOT_READ_FAILED");
    return { eligible: false, blockers, providerPositionSymbols: [] };
  }
  // An unreadable open-order list cannot prove the absence of a pending order, so it fails closed.
  if (first.openOrders === null || first.openOrdersReadFailure || second.openOrders === null || second.openOrdersReadFailure) {
    blockers.push("PROVIDER_SNAPSHOT_READ_FAILED");
  }
  const firstFingerprint = openPositionFingerprint(first);
  const secondFingerprint = openPositionFingerprint(second);
  if (firstFingerprint.length !== secondFingerprint.length || firstFingerprint.some((entry, index) => entry !== secondFingerprint[index])) {
    blockers.push("PROVIDER_SNAPSHOT_UNSTABLE");
  }
  const approvedSymbols = new Set(input.approvedQuarantineSymbols);
  if ([...new Set([...first.openOrderSymbols, ...second.openOrderSymbols])].some((symbol) => approvedSymbols.has(symbol))) {
    blockers.push("RELEVANT_OPEN_ORDERS_PRESENT");
  }
  const providerPositionSymbols = [...new Set(first.positions.filter((position) => isPositiveDecimal(position.quantity)).map((position) => position.symbol))].sort();
  return { eligible: blockers.length === 0, blockers, providerPositionSymbols };
}
