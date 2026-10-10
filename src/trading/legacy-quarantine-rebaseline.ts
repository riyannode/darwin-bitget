import { compareDecimal, isDecimal, isPositiveDecimal, multiplyDecimal, subtractDecimal } from "./decimal.js";
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

/**
 * Past this age a quarantine is unrecoverable by bounded history search: the provider no longer
 * returns the old order, so no amount of retrying can reach `FOUND_EXACT`. This is the exact
 * condition that makes a quarantine permanent, and it is what separates a legacy quarantine
 * from a fresh ambiguous write that must stay fail-closed.
 */
export const LEGACY_QUARANTINE_RECOVERABLE_WINDOW_MS = 2 * 60 * 60 * 1_000;

/**
 * Equity and available margin drift between two reads is driven by mark price, not by an
 * execution, so demanding exact equality would reject a stable account on any live market.
 * Position quantity and side are not market-driven: they change only on a fill, so they are
 * still compared exactly. This band is wide enough to absorb tick-level mark movement between
 * two reads and far too narrow to hide a real exposure change, which moves equity by the
 * traded notional rather than by a rounding tick.
 */
export const ACCOUNT_DRIFT_TOLERANCE_PCT = "0.1";

export type LegacyRebaselineBlocker =
  | "AGENT_NOT_PAUSED"
  | "PAPER_ONLY_REQUIRED"
  | "EXECUTION_IN_PROGRESS"
  | "PROVIDER_SNAPSHOT_READ_FAILED"
  | "PROVIDER_SNAPSHOT_UNSTABLE"
  | "PROVIDER_SNAPSHOT_QUANTITY_DRIFT"
  | "PROVIDER_SNAPSHOT_ACCOUNT_DRIFT"
  | "RELEVANT_OPEN_ORDERS_PRESENT"
  | "NO_APPROVED_LEGACY_QUARANTINE"
  | "APPROVED_IDENTITY_NOT_ACTIVE"
  | "APPROVED_IDENTITY_STILL_RECOVERABLE"
  | "APPROVED_IDENTITY_NOT_LEGACY"
  | "APPROVED_IDENTITY_CONFLICT"
  | "BASELINE_POSITION_INVALID";

export interface LegacyQuarantineIdentity {
  symbol: string;
  cycleId: string;
  decisionId: string;
  clientOrderId: string;
}

export type ApprovedLegacyRejectionReason =
  | "IDENTITY_NOT_ACTIVE"
  | "STILL_RECOVERABLE_WITHIN_WINDOW"
  | "CREATED_AT_UNPARSEABLE"
  | "DUPLICATE_REQUEST"
  | "JOURNAL_SOURCE_MISSING"
  | "JOURNAL_SYMBOL_CONFLICT";

export interface ApprovedLegacyRejection {
  identity: LegacyQuarantineIdentity;
  reason: ApprovedLegacyRejectionReason;
}

/** An active quarantine admitted for rebaseline, carrying its persisted original reason. */
export interface ApprovedLegacyQuarantine extends LegacyQuarantineIdentity {
  createdAt: string;
  reason: string;
}

export interface LegacyRebaselineAssessmentInput {
  /** Agent must be persistently PAUSED with no running cycle. */
  paused: boolean;
  runtimeStatus: string;
  cycleStartedAt: string | null;
  paperOnly: boolean;
  /** Two independent provider reads of positions + account + open orders. */
  firstSnapshot: { account: AccountSnapshot; observedAt: string } | null;
  secondSnapshot: { account: AccountSnapshot; observedAt: string } | null;
  /** Owner-approved legacy identities, after selection. */
  approvedQuarantineSymbols: readonly string[];
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
 * Stable per-symbol+side identity string. Side is part of the identity because a LONG and a
 * SHORT of the same symbol are different exposures and a side flip is a real state change.
 */
export function legacyRebaselinePositionFingerprint(position: Pick<PositionSnapshot, "symbol" | "positionSide">): string {
  return `${position.symbol}:${position.positionSide}`;
}

export function legacyQuarantineIdentityKey(identity: LegacyQuarantineIdentity): string {
  // Length-prefixed so no separator can ever appear inside a field and collide two identities
  // (for example symbol "A|1" + cycle "2" must not equal symbol "A" + cycle "1|2"). Kept as
  // printable ASCII so the file stays source text and git diffs it normally.
  return [identity.symbol, identity.cycleId, identity.decisionId, identity.clientOrderId]
    .map((field) => `${field.length}:${field}`)
    .join("|");
}

function openPositions(account: AccountSnapshot): PositionSnapshot[] {
  return account.positions.filter((position) => Number(position.quantity) > 0);
}

function openPositionFingerprint(account: AccountSnapshot): string[] {
  return openPositions(account).map(legacyRebaselinePositionFingerprint).sort();
}

/**
 * Compare two quantity strings exactly. Position quantity changes only when a fill occurs, so
 * two consecutive reads must agree bit-for-bit; any difference means the account moved between
 * reads and the rebaseline must not proceed against a moving target.
 */
function quantitiesMatch(left: string, right: string): boolean {
  if (!isDecimal(left) || !isDecimal(right)) return false;
  return compareDecimal(left, right) === 0;
}

function withinDriftTolerance(left: string, right: string, tolerancePct: string): boolean {
  try {
    const difference = subtractDecimal(left, right);
    const magnitude = compareDecimal(difference, "0") < 0 ? subtractDecimal("0", difference) : difference;
    // Reference is the larger observed account value, so the band is always measured against the
    // baseline account rather than the post-drift one. 0.1% of 50000 is exactly 50.
    const reference = compareDecimal(left, right) >= 0 ? left : right;
    // `tolerancePct` is a percentage, so the bound is reference * pct / 100. Multiplying both
    // sides by 100 and comparing keeps the arithmetic exact without a divide helper:
    // magnitude * 100 <= reference * pct.
    return compareDecimal(multiplyDecimal(magnitude, "100"), multiplyDecimal(reference, tolerancePct)) <= 0;
  } catch {
    return false;
  }
}

interface SnapshotComparison {
  positionSetStable: boolean;
  quantityStable: boolean;
  accountStable: boolean;
}

/**
 * Prove both snapshots describe the same account.
 *
 * Quantity and side are compared exactly because only a fill changes them. Equity and
 * available margin are compared against a narrow mark-price drift band so a live market cannot
 * manufacture a false "unstable" verdict, while a real exposure change still fails.
 */
function compareSnapshots(first: AccountSnapshot, second: AccountSnapshot): SnapshotComparison {
  const firstFingerprints = openPositionFingerprint(first);
  const secondFingerprints = openPositionFingerprint(second);
  const positionSetStable = firstFingerprints.length === secondFingerprints.length
    && firstFingerprints.every((fingerprint, index) => fingerprint === secondFingerprints[index]);

  let quantityStable = positionSetStable;
  if (quantityStable) {
    const secondByKey = new Map(openPositions(second).map((position) => [legacyRebaselinePositionFingerprint(position), position.quantity]));
    quantityStable = openPositions(first).every((position) => {
      const other = secondByKey.get(legacyRebaselinePositionFingerprint(position));
      return other !== undefined && quantitiesMatch(position.quantity, other);
    });
  }

  let accountStable = false;
  if (first.openOrders !== null && second.openOrders !== null && first.openOrders === second.openOrders) {
    accountStable = isDecimal(first.portfolioEquity) && isDecimal(second.portfolioEquity)
      && isDecimal(first.availableMargin) && isDecimal(second.availableMargin)
      && isDecimal(first.availableBalance) && isDecimal(second.availableBalance)
      && withinDriftTolerance(first.portfolioEquity, second.portfolioEquity, ACCOUNT_DRIFT_TOLERANCE_PCT)
      && withinDriftTolerance(first.availableMargin, second.availableMargin, ACCOUNT_DRIFT_TOLERANCE_PCT)
      && withinDriftTolerance(first.availableBalance, second.availableBalance, ACCOUNT_DRIFT_TOLERANCE_PCT);
  }
  return { positionSetStable, quantityStable, accountStable };
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
 * Narrow the owner's requested identities down to the ones that are actually legacy.
 *
 * A rebaseline may only retire a quarantine that bounded history search can no longer resolve.
 * A quarantine still inside the recoverable window is a genuinely ambiguous recent write and
 * must stay fail-closed, so it is rejected here rather than silently archived. Every rejection
 * is reported with an explicit reason and nothing is freed implicitly.
 */
export function selectOwnerApprovedLegacyQuarantines(input: {
  requested: readonly LegacyQuarantineIdentity[];
  activeQuarantines: readonly ApprovedLegacyQuarantine[];
  nowMs: number;
  journalSymbolFor?: (identity: LegacyQuarantineIdentity) => string | null | undefined;
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
    if (!Number.isFinite(createdAtMs)) {
      rejected.push({ identity, reason: "CREATED_AT_UNPARSEABLE" });
      continue;
    }
    // A quarantine created after this point is still inside the provider's recoverable history
    // window, so bounded search can still resolve it. Freeing it here would release a recent
    // UNKNOWN order without evidence.
    if (input.nowMs - createdAtMs <= LEGACY_QUARANTINE_RECOVERABLE_WINDOW_MS) {
      rejected.push({ identity, reason: "STILL_RECOVERABLE_WITHIN_WINDOW" });
      continue;
    }
    // The quarantine must be backed by its source journal, and that journal's decision symbol
    // must be the quarantined symbol. A missing journal, or a resolver that cannot report one,
    // means the quarantine's origin cannot be proven, so it is rejected fail-closed: without this
    // an unresolvable journal would silently pass and free the quarantine.
    if (!input.journalSymbolFor) {
      rejected.push({ identity, reason: "JOURNAL_SOURCE_MISSING" });
      continue;
    }
    // Wrap the resolver: a storage or journal read that throws must fail closed with an explicit
    // reason rather than escaping as an unhandled error.
    let journalSymbol: string | null | undefined;
    try {
      journalSymbol = input.journalSymbolFor(identity);
    } catch {
      rejected.push({ identity, reason: "JOURNAL_SOURCE_MISSING" });
      continue;
    }
    if (journalSymbol === undefined || journalSymbol === null || journalSymbol.trim() === "") {
      rejected.push({ identity, reason: "JOURNAL_SOURCE_MISSING" });
      continue;
    }
    if (journalSymbol !== identity.symbol) {
      rejected.push({ identity, reason: "JOURNAL_SYMBOL_CONFLICT" });
      continue;
    }
    claimed.add(key);
    selected.push(active);
  }
  return { selected, rejected };
}

/**
 * Decide whether the approved legacy quarantine set may be rebaselined, and produce the
 * operational baseline from the two agreeing provider snapshots. Fails closed on every ambiguity.
 */
export function assessLegacyQuarantineRebaseline(input: LegacyRebaselineAssessmentInput): LegacyRebaselineAssessment {
  const blockers: LegacyRebaselineBlocker[] = [];
  if (!input.paused || input.runtimeStatus !== "PAUSED" || input.cycleStartedAt) blockers.push("AGENT_NOT_PAUSED");
  if (!input.paperOnly) blockers.push("PAPER_ONLY_REQUIRED");
  if (input.approvedQuarantineSymbols.length === 0) blockers.push("NO_APPROVED_LEGACY_QUARANTINE");
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
  const comparison = compareSnapshots(first, second);
  if (!comparison.positionSetStable) blockers.push("PROVIDER_SNAPSHOT_UNSTABLE");
  else if (!comparison.quantityStable) blockers.push("PROVIDER_SNAPSHOT_QUANTITY_DRIFT");
  if (!comparison.accountStable) blockers.push("PROVIDER_SNAPSHOT_ACCOUNT_DRIFT");
  const approvedSymbols = new Set(input.approvedQuarantineSymbols);
  const relevantOpenOrderSymbols = [...new Set([...first.openOrderSymbols, ...second.openOrderSymbols])]
    .filter((symbol) => approvedSymbols.has(symbol))
    .sort();
  if (relevantOpenOrderSymbols.length > 0) blockers.push("RELEVANT_OPEN_ORDERS_PRESENT");

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
 * The baseline only retires the approved quarantine record itself. A symbol that still holds a
 * live provider position remains governed by the normal position-management path, and a symbol
 * with a pending provider order stays blocked by the duplicate-order gate. No risk limit is
 * relaxed here: margin, leverage, drawdown, quantity and instrument gates are untouched.
 */
export function legacyRebaselineManagedSymbols(
  positions: readonly Pick<PositionSnapshot, "symbol" | "positionSide" | "quantity">[],
  approvedQuarantineSymbols: readonly string[],
): { providerPositionSymbols: string[]; eligibleAgainSymbols: string[] } {
  const providerPositionSymbols = [...new Set(positions.filter((position) => Number(position.quantity) > 0).map((position) => position.symbol))].sort();
  const providerPositionSet = new Set(providerPositionSymbols);
  const eligibleAgainSymbols = [...new Set(approvedQuarantineSymbols)]
    .filter((symbol) => !providerPositionSet.has(symbol))
    .sort();
  return { providerPositionSymbols, eligibleAgainSymbols };
}