import type { ExperienceOutcomeStatus, PositionSide, PositionSnapshot, TradeExperience } from "../types.js";

/**
 * Attribution rules for a provider-live position's lifecycle.
 *
 * Two facts are kept strictly separate:
 *  - the provider's financial truth for a position, which is always authoritative, and
 *  - the *origin* of that position, which must never be guessed.
 *
 * The evidence itself (provider_orders + provider_fills with origin DARWIN, joined through the
 * issuing clientOid to idempotency.decision_id) is owned by the caller, so the cycle repair, the
 * discrepancy audit, and the persistence path can never disagree about who owns a position.
 */

/** The repository's schema-safe convention for a value that is genuinely unknown. */
export const UNAVAILABLE_ATTRIBUTE = "UNAVAILABLE" as const;

/** Audit reason recorded when a missing local lifecycle is reconstructed from provider identity. */
export const REPAIR_REASON = "MISSING_LOCAL_OPEN_PROVIDER_IDENTITY_MATCHED";

/** Deterministic opening identity resolved from provider evidence. */
export interface ProviderLiveIdentity {
  providerOrderId: string;
  decisionId: string;
}

/** Stable per symbol+side so repeat management of one position stays idempotent. */
export function providerManagementExperienceId(symbol: string, positionSide: PositionSide | null): string {
  return `provider-live:${symbol}:${positionSide ?? "NONE"}`;
}

/**
 * A reconstructed DARWIN lifecycle is keyed by its real entry decision, so repeated repair across
 * cycles and worker restarts converges on one identity instead of accumulating rows.
 */
export function darwinLifecycleExperienceId(decisionId: string): string {
  return `darwin-lifecycle-repair:${decisionId}`;
}

/** Deterministic audit-event id, so repeated repair of the same lifecycle stays idempotent. */
export function darwinLifecycleRepairEventId(decisionId: string): string {
  return `darwin-lifecycle-repair:${decisionId}`;
}

/**
 * A synthetic provider-external management record must never satisfy the requirement for a
 * DARWIN-owned local lifecycle, and neither may any record whose provenance is explicitly not
 * DARWIN's. Only deterministic DARWIN provenance counts as a local lifecycle.
 */
export function isDarwinOwnedExperience(experience: TradeExperience): boolean {
  if (experience.outcomeStatus !== "OPEN") return false;
  if (experience.origin === "PROVIDER_EXTERNAL" || experience.origin === "UNATTRIBUTED") return false;
  return experience.origin === "DARWIN" || experience.entryDecisionId !== "";
}

/**
 * A record may only own a provider lifecycle when its provenance matches that lifecycle's
 * deterministic identity. Symbol, side, and approximate time are not identity.
 */
export function matchesProviderIdentity(experience: TradeExperience, identity: ProviderLiveIdentity): boolean {
  const hasDecisionId = Boolean(experience.entryDecisionId);
  const hasProviderOrderId = Boolean(experience.providerOrderId);
  if (!hasDecisionId && !hasProviderOrderId) return false;
  if (hasDecisionId && experience.entryDecisionId !== identity.decisionId) return false;
  if (hasProviderOrderId && experience.providerOrderId !== identity.providerOrderId) return false;
  return experience.entryDecisionId === identity.decisionId || experience.providerOrderId === identity.providerOrderId;
}

/** A partial identity match with another populated field disagreeing is a hard ownership conflict. */
export function conflictsProviderIdentity(experience: TradeExperience, identity: ProviderLiveIdentity): boolean {
  const decisionMatches = Boolean(experience.entryDecisionId) && experience.entryDecisionId === identity.decisionId;
  const orderMatches = Boolean(experience.providerOrderId) && experience.providerOrderId === identity.providerOrderId;
  const decisionConflicts = Boolean(experience.entryDecisionId) && experience.entryDecisionId !== identity.decisionId;
  const orderConflicts = Boolean(experience.providerOrderId) && experience.providerOrderId !== identity.providerOrderId;
  return (decisionMatches && orderConflicts) || (orderMatches && decisionConflicts);
}

/**
 * Resolve the local experience that owns a live provider position.
 *
 * When deterministic identity exists, only a provenance match resolves the lifecycle. When no
 * identity exists, nothing resolves it: a stale DARWIN record that merely shares symbol+side must
 * never be allowed to claim a provider position it did not open.
 */
export function resolveLifecycleExperience(
  experiences: readonly TradeExperience[],
  position: Pick<PositionSnapshot, "symbol" | "positionSide">,
  identity: ProviderLiveIdentity | null | undefined,
): TradeExperience | undefined {
  if (!identity) return undefined;
  return experiences.find((experience) => isDarwinOwnedExperience(experience)
    && experience.symbol === position.symbol
    && experience.positionSide === position.positionSide
    && matchesProviderIdentity(experience, identity));
}

/** Provider-reported facts are used verbatim; anything absent stays UNAVAILABLE. */
export function providerFact(value: string | undefined): string {
  return value && value.trim() ? value : UNAVAILABLE_ATTRIBUTE;
}

/**
 * Entry time is only ever the provider's authoritative opening timestamp. A management or exit
 * timestamp is never the entry time; an unknown entry time stays UNAVAILABLE.
 */
export function providerEntryTime(position: Pick<PositionSnapshot, "openedAt"> | undefined): string {
  const openedAt = position?.openedAt;
  return openedAt && Number.isFinite(Date.parse(openedAt)) ? openedAt : UNAVAILABLE_ATTRIBUTE;
}

/** Lifecycle metrics need a real numeric entry price; an unavailable one is not derivable. */
export function hasDerivableEntryPrice(value: string | undefined): boolean {
  if (!value) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

/**
 * Reconstruct the missing OPEN lifecycle for a deterministically attributed DARWIN position from
 * authoritative provider evidence only. Nothing here is invented: every field is taken verbatim
 * from provider evidence, recovered from persisted DARWIN evidence, or explicitly UNAVAILABLE.
 */
export function repairedDarwinOpenExperience(input: {
  identity: ProviderLiveIdentity;
  position: PositionSnapshot;
  entryThesis: string;
  realizedPnl: string;
  realizedPnlPct: string;
}): TradeExperience {
  const { identity, position, entryThesis } = input;
  const entryTime = providerEntryTime(position);
  const entryPrice = providerFact(position.entryPrice);
  // Entry price/time establish the denominator and window, not the historical peak or trough.
  return {
    experienceId: darwinLifecycleExperienceId(identity.decisionId),
    symbol: position.symbol,
    positionSide: position.positionSide,
    action: position.positionSide === "SHORT" ? "OPEN_SHORT" : "OPEN_LONG",
    entryDecisionId: identity.decisionId,
    entryPrice,
    entryTime,
    exitDecisionId: "",
    exitPrice: "0",
    exitTime: "",
    selectedLeverage: providerFact(position.leverage),
    marginAllocationPct: UNAVAILABLE_ATTRIBUTE,
    marginAllocated: providerFact(position.marginAllocated),
    positionNotional: providerFact(position.notional),
    realizedPnl: input.realizedPnl,
    realizedPnlPct: input.realizedPnlPct,
    maximumFavorableExcursion: UNAVAILABLE_ATTRIBUTE,
    maximumAdverseExcursion: UNAVAILABLE_ATTRIBUTE,
    drawdownContribution: UNAVAILABLE_ATTRIBUTE,
    liquidationDistance: UNAVAILABLE_ATTRIBUTE,
    entryThesis: providerFact(entryThesis),
    exitThesis: "",
    evidenceAtEntry: [],
    evidenceAtExit: [],
    lessonsUsed: [],
    marketContext: "UNKNOWN",
    outcomeStatus: "OPEN",
    providerOrderId: identity.providerOrderId,
    financialSource: "LOCAL",
    origin: "DARWIN",
  };
}

/**
 * A REDUCE leaves a remaining live position behind, and a CLOSE leaves none. The persisted OPEN
 * lifecycle must describe the remaining provider position, never the reduced execution slice, so
 * authoritative post-execution readback is required whenever the lifecycle stays open.
 */
export function remainingOpenState(
  action: "CLOSE" | "REDUCE",
  positionAfter: Pick<PositionSnapshot, "marginAllocated" | "notional" | "leverage"> | undefined,
): { marginAllocated: string; positionNotional: string; selectedLeverage: string } {
  if (action === "CLOSE" || !positionAfter) {
    return { marginAllocated: UNAVAILABLE_ATTRIBUTE, positionNotional: UNAVAILABLE_ATTRIBUTE, selectedLeverage: UNAVAILABLE_ATTRIBUTE };
  }
  return {
    marginAllocated: providerFact(positionAfter.marginAllocated),
    positionNotional: providerFact(positionAfter.notional),
    selectedLeverage: providerFact(positionAfter.leverage),
  };
}

/**
 * A REDUCE leaves the position open; a CLOSE ends it. Neither is classifiable as a win or loss
 * here because the provider ledger has not yet produced the closed lifecycle that owns that
 * classification, and DARWIN must not classify an outcome from an entry it cannot prove.
 */
export function managementOutcomeStatus(action: "CLOSE" | "REDUCE"): ExperienceOutcomeStatus {
  return action === "CLOSE" ? "CLOSED_UNCLASSIFIED" : "OPEN";
}