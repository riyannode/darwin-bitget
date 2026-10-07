import { describe, expect, it } from "vitest";
import { isDarwinOwnedExperience, managementOutcomeStatus, matchesProviderIdentity, providerEntryTime, providerFact, providerManagementExperienceId, resolveLifecycleExperience } from "../src/agent/provider-live-lifecycle.js";
import type { TradeExperience } from "../src/types.js";

// The lifecycle attribution rules are the single place that decides whether a persisted
// experience may stand in for a DARWIN-owned local lifecycle. Each rule is pinned here directly
// so a weakening of any single guard is observable.

function experience(overrides: Partial<TradeExperience> = {}): TradeExperience {
  return {
    experienceId: "e1", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
    entryDecisionId: "decision-entry", entryPrice: "190.81", entryTime: "2026-10-05T14:25:48.407Z",
    exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
    marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
    maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0",
    liquidationDistance: "0", entryThesis: "t", exitThesis: "", evidenceAtEntry: [], evidenceAtExit: [],
    lessonsUsed: [], marketContext: "VOLATILITY_EXPANSION", outcomeStatus: "OPEN", ...overrides,
  } as TradeExperience;
}

describe("provider-live lifecycle attribution rules", () => {
  it("requires every available lifecycle identity field to agree", () => {
    const identity = { decisionId: "decision-entry", providerOrderId: "provider-order" };
    const decisionOnly = experience({ entryDecisionId: identity.decisionId });
    const orderOnly = experience({ entryDecisionId: "", providerOrderId: identity.providerOrderId });
    const decisionMatchOrderConflict = experience({ entryDecisionId: identity.decisionId, providerOrderId: "other-provider-order" });
    const orderMatchDecisionConflict = experience({ entryDecisionId: "other-decision", providerOrderId: identity.providerOrderId });

    expect(matchesProviderIdentity(decisionOnly, identity)).toBe(true);
    expect(matchesProviderIdentity(orderOnly, identity)).toBe(true);
    expect(matchesProviderIdentity(decisionMatchOrderConflict, identity)).toBe(false);
    expect(matchesProviderIdentity(orderMatchDecisionConflict, identity)).toBe(false);
    expect(resolveLifecycleExperience([decisionMatchOrderConflict], { symbol: "COINUSDT", positionSide: "LONG" }, identity)).toBeUndefined();
    expect(resolveLifecycleExperience([orderMatchDecisionConflict], { symbol: "COINUSDT", positionSide: "LONG" }, identity)).toBeUndefined();
  });

  it("counts only an OPEN experience as a local lifecycle", () => {
    expect(isDarwinOwnedExperience(experience())).toBe(true);
    for (const outcomeStatus of ["CLOSED_UNCLASSIFIED", "PROFITABLE", "LOSING", "BREAK_EVEN", "BLOCKED", "EXECUTION_FAILURE", "EXECUTION_UNRESOLVED"] as const) {
      expect(isDarwinOwnedExperience(experience({ outcomeStatus }))).toBe(false);
    }
  });

  it("never counts a provider-external record as a DARWIN local lifecycle, whatever else it carries", () => {
    // Even if an external record somehow carried a decision id, explicit external provenance wins.
    expect(isDarwinOwnedExperience(experience({ origin: "PROVIDER_EXTERNAL", entryDecisionId: "decision-entry" }))).toBe(false);
    expect(isDarwinOwnedExperience(experience({ origin: "PROVIDER_EXTERNAL", entryDecisionId: "" }))).toBe(false);
    expect(isDarwinOwnedExperience(experience({ origin: "UNATTRIBUTED", entryDecisionId: "decision-entry" }))).toBe(false);
    expect(isDarwinOwnedExperience(experience({ origin: "UNATTRIBUTED" }))).toBe(false);
  });

  it("counts a repaired DARWIN lifecycle that has no persisted entry decision as owned", () => {
    expect(isDarwinOwnedExperience(experience({ origin: "DARWIN", entryDecisionId: "" }))).toBe(true);
  });

  it("keeps the entry time to the provider opening timestamp or explicitly unavailable", () => {
    expect(providerEntryTime({ openedAt: "2026-10-05T14:25:48.407Z" })).toBe("2026-10-05T14:25:48.407Z");
    expect(providerEntryTime(undefined)).toBe("UNAVAILABLE");
    expect(providerEntryTime({})).toBe("UNAVAILABLE");
    expect(providerEntryTime({ openedAt: "" })).toBe("UNAVAILABLE");
    // A non-timestamp value is not an entry time.
    expect(providerEntryTime({ openedAt: "not-a-timestamp" })).toBe("UNAVAILABLE");
  });

  it("keeps a missing provider fact unavailable rather than inventing it", () => {
    expect(providerFact("190.81")).toBe("190.81");
    expect(providerFact(undefined)).toBe("UNAVAILABLE");
    expect(providerFact("")).toBe("UNAVAILABLE");
    expect(providerFact("   ")).toBe("UNAVAILABLE");
  });

  it("keys a management record per symbol and side, and leaves REDUCE open while CLOSE ends the lifecycle", () => {
    expect(providerManagementExperienceId("COINUSDT", "LONG")).toBe("provider-live:COINUSDT:LONG");
    expect(providerManagementExperienceId("COINUSDT", "SHORT")).toBe("provider-live:COINUSDT:SHORT");
    expect(providerManagementExperienceId("COINUSDT", null)).toBe("provider-live:COINUSDT:NONE");
    expect(managementOutcomeStatus("REDUCE")).toBe("OPEN");
    expect(managementOutcomeStatus("CLOSE")).toBe("CLOSED_UNCLASSIFIED");
  });
});