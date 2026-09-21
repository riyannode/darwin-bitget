import { describe, expect, it } from "vitest";
import { buildPositionManagementState, reconstructMaximumFavorableReturnPct } from "../src/trading/position-management.js";
import type { TradeExperience } from "../src/types.js";

const entryTime = "2026-09-12T10:00:00.000Z";

function experience(overrides: Partial<TradeExperience> = {}): TradeExperience {
  return {
    experienceId: "experience-1",
    symbol: "TESTUSDT",
    positionSide: "LONG",
    action: "OPEN_LONG",
    entryDecisionId: "entry-1",
    entryPrice: "100",
    entryTime,
    exitDecisionId: "",
    exitPrice: "0",
    exitTime: "",
    selectedLeverage: "2",
    marginAllocationPct: "10",
    marginAllocated: "100",
    positionNotional: "200",
    realizedPnl: "0",
    realizedPnlPct: "0",
    maximumFavorableExcursion: "0",
    maximumAdverseExcursion: "0",
    drawdownContribution: "0",
    liquidationDistance: "0",
    entryThesis: "thesis",
    exitThesis: "",
    evidenceAtEntry: ["TICKER"],
    evidenceAtExit: [],
    lessonsUsed: [],
    marketContext: "UNKNOWN",
    outcomeStatus: "OPEN",
    ...overrides,
  };
}

function position(positionSide: "LONG" | "SHORT" = "LONG") {
  return { symbol: "TESTUSDT", positionSide } as const;
}

describe("position management lifecycle state", () => {
  it("tracks LONG return, peak, and giveback", () => {
    const opened = buildPositionManagementState(position(), experience(), "110", "2026-09-12T10:05:00.000Z");
    const later = buildPositionManagementState(position(), opened.experience, "106", "2026-09-12T10:15:00.000Z");

    expect(later.state).toMatchObject({ currentReturnPct: 6, maximumFavorableReturnPct: 10, profitGivebackPct: 40, timeInTradeMinutes: 15 });
  });

  it("tracks SHORT return, peak, and giveback", () => {
    const short = experience({ positionSide: "SHORT" });
    const opened = buildPositionManagementState(position("SHORT"), short, "90", "2026-09-12T10:05:00.000Z");
    const later = buildPositionManagementState(position("SHORT"), opened.experience, "94", "2026-09-12T10:15:00.000Z");

    expect(later.state).toMatchObject({ currentReturnPct: 6, maximumFavorableReturnPct: 10, profitGivebackPct: 40 });
  });

  it("marks a legacy OPEN experience as first-observation-scoped", () => {
    const result = buildPositionManagementState(position(), experience({ maximumFavorableExcursion: "0" }), "110", "2026-09-12T10:05:00.000Z");

    expect(result.state).toMatchObject({ maximumFavorableReturnPct: 10, maximumFavorableReturnBasis: "SINCE_FIRST_DETERMINISTIC_OBSERVATION" });
    expect(result.experience).toMatchObject({ maximumFavorableExcursion: "10", maximumFavorableExcursionBasis: "SINCE_FIRST_DETERMINISTIC_OBSERVATION" });
  });

  it("reconstructs a legacy peak only from persisted provider-backed observations", () => {
    const peak = reconstructMaximumFavorableReturnPct(position(), experience({ maximumFavorableExcursion: "0" }), [{
      cycleId: "cycle-1",
      agentVersion: "1",
      model: "qwen",
      mode: "AUTONOMOUS",
      startedAt: "2026-09-12T10:10:00.000Z",
      completedAt: "2026-09-12T10:10:01.000Z",
      portfolio: { positions: [{ symbol: "TESTUSDT", positionSide: "LONG", quantity: "1" }], observedAt: "2026-09-12T10:10:00.500Z" } as never,
      marketContext: { deep: [{ market: { symbol: "TESTUSDT", lastPrice: "108", observedAt: "2026-09-12T10:10:00.000Z" } }] },
      retrievedLessons: [],
      createdLessons: [],
    }]);

    expect(peak).toBe(8);
  });

  it("never decreases the favorable peak", () => {
    let current = experience();
    for (const price of ["110", "108", "105"]) current = buildPositionManagementState(position(), current, price, "2026-09-12T10:05:00.000Z").experience;

    expect(current.maximumFavorableExcursion).toBe("10");
  });

  it("reports full giveback after crossing through entry", () => {
    const peak = buildPositionManagementState(position(), experience(), "110", "2026-09-12T10:05:00.000Z");
    const current = buildPositionManagementState(position(), peak.experience, "99", "2026-09-12T10:15:00.000Z");

    expect(current.state).toMatchObject({ currentReturnPct: -1, maximumFavorableReturnPct: 10, profitGivebackPct: 100 });
  });

  it("resets the peak for a new trade experience", () => {
    const oldTrade = experience({ maximumFavorableExcursion: "10", outcomeStatus: "PROFITABLE", exitTime: "2026-09-12T10:20:00.000Z" });
    const newTrade = experience({ experienceId: "experience-2", maximumFavorableExcursion: "0", entryTime: "2026-09-12T11:00:00.000Z" });

    const result = buildPositionManagementState(position(), newTrade, "101", "2026-09-12T11:05:00.000Z");

    expect(oldTrade.maximumFavorableExcursion).toBe("10");
    expect(result.state.maximumFavorableReturnPct).toBe(1);
    expect(result.experience.maximumFavorableExcursion).toBe("1");
  });

  it("limits prior management history to the last five actions", () => {
    const result = buildPositionManagementState(position(), experience(), "100", "2026-09-12T10:05:00.000Z", {
      managementEvents: [
        { action: "OPEN_LONG" },
        { action: "HOLD" },
        { action: "REDUCE" },
        { action: "HOLD" },
        { action: "CLOSE" },
        { action: "HOLD" },
      ] as never,
    });

    expect(result.state.priorManagementActions).toEqual(["HOLD", "REDUCE", "HOLD", "CLOSE", "HOLD"]);
  });

  it("does not mutate a CLOSED experience during lifecycle refresh", () => {
    const closed = experience({ outcomeStatus: "PROFITABLE", exitTime: "2026-09-12T10:04:00.000Z" });
    const result = buildPositionManagementState(position(), closed, "110", "2026-09-12T10:05:00.000Z");

    expect(result.experience).toBe(closed);
    expect(result.experience.maximumFavorableExcursion).toBe("0");
    expect(result.experience.maximumFavorableExcursionBasis).toBeUndefined();
  });
});
