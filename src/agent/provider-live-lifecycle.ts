import type { ExperienceOutcomeStatus, PositionSide, PositionSnapshot, TradeExperience } from "../types.js";

/**
 * Attribution rules for a verified provider-live management execution on a position with no
 * local OPEN experience. The provider is the financial source of truth for the exit, but the
 * *origin* of the position is a separate fact that must never be guessed: a deterministically
 * attributable DARWIN lifecycle is repaired, and only a position with no identity at all is
 * recorded as provider-external.
 *
 * The evidence itself (provider_orders + provider_fills with origin DARWIN, joined through the
 * issuing clientOid to idempotency.decision_id) is owned by the caller, so the cycle discrepancy
 * audit and this persistence path can never disagree about who owns a position.
 */

/** The repository's schema-safe convention for a value that is genuinely unknown. */
export const UNAVAILABLE_ATTRIBUTE = "UNAVAILABLE" as const;

/** Stable per symbol+side so repeat management of one position stays idempotent. */
export function providerManagementExperienceId(symbol: string, positionSide: PositionSide | null): string {
  return `provider-live:${symbol}:${positionSide ?? "NONE"}`;
}

/**
 * A synthetic provider-external management record must never satisfy the requirement for a
 * DARWIN-owned local lifecycle. Only an experience that deterministically carries DARWIN
 * provenance counts as one, so provider-external positions stay blocked for exposure increases
 * across every subsequent cycle.
 */
export function isDarwinOwnedExperience(experience: TradeExperience): boolean {
  if (experience.outcomeStatus !== "OPEN") return false;
  if (experience.origin === "PROVIDER_EXTERNAL" || experience.origin === "UNATTRIBUTED") return false;
  return experience.origin === "DARWIN" || experience.entryDecisionId !== "";
}

/**
 * Entry time is only ever the provider's authoritative opening timestamp. A management or exit
 * timestamp is never the entry time; an unknown entry time stays UNAVAILABLE.
 */
export function providerEntryTime(position: Pick<PositionSnapshot, "openedAt"> | undefined): string {
  const openedAt = position?.openedAt;
  return openedAt && Number.isFinite(Date.parse(openedAt)) ? openedAt : UNAVAILABLE_ATTRIBUTE;
}

/** Provider-reported position facts are used verbatim; anything absent stays UNAVAILABLE. */
export function providerFact(value: string | undefined): string {
  return value && value.trim() ? value : UNAVAILABLE_ATTRIBUTE;
}

/**
 * A REDUCE leaves the position open; a CLOSE ends it. Neither is classifiable as a win or loss
 * here because the provider ledger has not yet produced the closed lifecycle that owns that
 * classification, and DARWIN must not classify an outcome from an entry it cannot prove.
 */
export function managementOutcomeStatus(action: "CLOSE" | "REDUCE"): ExperienceOutcomeStatus {
  return action === "CLOSE" ? "CLOSED_UNCLASSIFIED" : "OPEN";
}