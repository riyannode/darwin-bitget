import { compareDecimal, isDecimal, isPositiveDecimal } from "./decimal.js";
import type { AccountSnapshot, PositionSnapshot } from "../types.js";

/**
 * Owner-approved rebaseline of legacy execution quarantines.
 *
 * Root cause of the permanent quarantine: a bounded order-history search can no longer
 * produce authoritative proof for an old ambiguous write, so the symbol stays blocked by
 * `UNRESOLVED_PRIOR_EXECUTION` forever. Repeating the search never terminates. This module
 * replaces that loop with one bounded, evidence-bound decision that does not require the old
 * order's outcome: the authoritative current provider state becomes the operational truth.
 *
 * It deliberately never classifies the old order. FILLED / REJECTED / RECONCILED stay
 * unavailable without provider proof; the archive keeps the original status verbatim.
 */

export type LegacyRebaselineBlocker =
  | "AGENT_NOT_PAUSED"
  | "PAPER_ONLY_REQUIRED"
  | "EXECUTION_IN_PROGRESS"
  | "PROVIDER_SNAPSHOT_READ_FAILED"
  | "PROVIDER_SNAPSHOT_UNSTABLE"
  | "RELEVANT_OPEN_ORDERS_PRESENT"
  | "NO_ACTIVE_LEGACY_QUARANTINE"
  | "BASELINE_POSITION_INVALID";

export interface LegacyRebaselineAssessmentInput {
  /** Agent must be persistently PAUSED with no running cycle. */
  paused: boolean;
  runtimeStatus: string;
  cycleStartedAt: string | null;
  paperOnly: boolean;
  /** Two independent provider reads of positions + account + open orders. */
  firstSnapshot: { account: AccountSnapshot; observedAt: string } | null;
  secondSnapshot: { account: AccountSnapshot; observedAt: string } | null;
  /** Symbols with a currently active execution quarantine. */
  activeQuarantineSymbols: readonly string[];
  /** Current provider positions that carry a positive quantity. */
  positions: readonly PositionSnapshot[];
}

export interface LegacyRebaselinePosition {
  symbol: string;
  positionSide: "LONG" | "SHORT";
  quantity: string;
  entryPrice: string;
  notional: string;
  marginAllocated: string;
  leverage: string;
  markPrice?: string;
}

export interface LegacyRebaselineAssessment {
  eligible: boolean;
  blockers: LegacyRebaselineBlocker[];
  baselinePositions: LegacyRebaselinePosition[];
  positionFingerprint: string[];
  snapshotEvidence: Array<{ observedAt: string; positionCount: number; openOrderCount: number }>;
  portfolioEquity: string;
  availableMargin: string;
  openOrderCount: number;
}

/**
 * Stable per-symbol+side identity string. Provider quantity and price formatting vary between
 * reads, so the fingerprint proves lifecycle presence and side stability, not a price match.
 */
export function legacyRebaselinePositionFingerprint(position: Pick<PositionSnapshot, "symbol" | "positionSide">): string {
  return `${position.symbol}:${position.positionSide}`;
}

function openPositionFingerprint(account: AccountSnapshot): string[] {
  return account.positions
    .filter((position) => Number(position.quantity) > 0)
    .map(legacyRebaselinePositionFingerprint)
    .sort();
}

function snapshotsAgree(first: AccountSnapshot, second: AccountSnapshot): boolean {
  if (JSON.stringify(openPositionFingerprint(first)) !== JSON.stringify(openPositionFingerprint(second))) return false;
  if (first.openOrders === null || second.openOrders === null) return false;
  if (first.openOrders !== second.openOrders) return false;
  for (const field of ["portfolioEquity", "availableMargin", "availableBalance"] as const) {
    if (!isDecimal(first[field]) || !isDecimal(second[field]) || compareDecimal(first[field], second[field]) !== 0) return false;
  }
  return true;
}

function toBaselinePosition(position: PositionSnapshot): LegacyRebaselinePosition | null {
  if (!isPositiveDecimal(position.quantity) || !isDecimal(position.notional)) return null;
  return {
    symbol: position.symbol,
    positionSide: position.positionSide,
    quantity: position.quantity,
    entryPrice: position.entryPrice,
    notional: position.notional,
    marginAllocated: position.marginAllocated,
    leverage: position.leverage,
    ...(position.markPrice ? { markPrice: position.markPrice } : {}),
  };
}

/**
 * Decide whether the legacy quarantine may be rebaselined, and produce the operational
 * baseline from the two agreeing provider snapshots. Fails closed on every ambiguity.
 */
export function assessLegacyQuarantineRebaseline(input: LegacyRebaselineAssessmentInput): LegacyRebaselineAssessment {
  const blockers: LegacyRebaselineBlocker[] = [];
  if (!input.paused || input.runtimeStatus !== "PAUSED" || input.cycleStartedAt) blockers.push("AGENT_NOT_PAUSED");
  if (!input.paperOnly) blockers.push("PAPER_ONLY_REQUIRED");
  if (!input.firstSnapshot || !input.secondSnapshot) {
    blockers.push("PROVIDER_SNAPSHOT_READ_FAILED");
    return {
      eligible: false,
      blockers,
      baselinePositions: [],
      positionFingerprint: [],
      snapshotEvidence: [],
      portfolioEquity: "0",
      availableMargin: "0",
      openOrderCount: 0,
    };
  }
  const first = input.firstSnapshot.account;
  const second = input.secondSnapshot.account;
  if (first.openOrders === null || first.openOrdersReadFailure || second.openOrders === null || second.openOrdersReadFailure) {
    blockers.push("PROVIDER_SNAPSHOT_READ_FAILED");
  }
  if (!snapshotsAgree(first, second)) blockers.push("PROVIDER_SNAPSHOT_UNSTABLE");
  const quarantineSymbols = new Set(input.activeQuarantineSymbols);
  const relevantOpenOrderSymbols = [...new Set([...first.openOrderSymbols, ...second.openOrderSymbols])]
    .filter((symbol) => quarantineSymbols.has(symbol))
    .sort();
  if (relevantOpenOrderSymbols.length > 0) blockers.push("RELEVANT_OPEN_ORDERS_PRESENT");
  if (quarantineSymbols.size === 0) blockers.push("NO_ACTIVE_LEGACY_QUARANTINE");

  const baselinePositions: LegacyRebaselinePosition[] = [];
  for (const position of input.positions) {
    const baseline = toBaselinePosition(position);
    if (!baseline) {
      blockers.push("BASELINE_POSITION_INVALID");
      continue;
    }
    baselinePositions.push(baseline);
  }
  const snapshotEvidence = [
    { observedAt: input.firstSnapshot.observedAt, positionCount: openPositionFingerprint(first).length, openOrderCount: Number(first.openOrders) },
    { observedAt: input.secondSnapshot.observedAt, positionCount: openPositionFingerprint(second).length, openOrderCount: Number(second.openOrders) },
  ];
  return {
    eligible: blockers.length === 0,
    blockers,
    baselinePositions: baselinePositions.sort((left, right) => legacyRebaselinePositionFingerprint(left).localeCompare(legacyRebaselinePositionFingerprint(right))),
    positionFingerprint: openPositionFingerprint(first),
    snapshotEvidence,
    portfolioEquity: first.portfolioEquity,
    availableMargin: first.availableMargin,
    openOrderCount: Number(first.openOrders ?? 0),
  };
}

/**
 * Symbols that may be managed again after a rebaseline.
 *
 * The baseline only retires the quarantine record itself. A symbol that still holds a live
 * provider position remains governed by the normal position-management path, and a symbol
 * with a pending provider order stays blocked by the duplicate-order gate. No risk limit is
 * relaxed here: margin, leverage, drawdown, quantity and instrument gates are untouched.
 */
export function legacyRebaselineManagedSymbols(
  positions: readonly Pick<PositionSnapshot, "symbol" | "positionSide" | "quantity">[],
  quarantinedSymbols: readonly string[],
): { providerPositionSymbols: string[]; eligibleAgainSymbols: string[] } {
  const providerPositionSymbols = [...new Set(positions.filter((position) => Number(position.quantity) > 0).map((position) => position.symbol))].sort();
  const providerPositionSet = new Set(providerPositionSymbols);
  const eligibleAgainSymbols = [...new Set(quarantinedSymbols)]
    .filter((symbol) => !providerPositionSet.has(symbol))
    .sort();
  return { providerPositionSymbols, eligibleAgainSymbols };
}