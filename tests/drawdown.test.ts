import { describe, expect, it } from "vitest";
import { evaluateDrawdown } from "../src/trading/drawdown.js";
import type { OwnerPolicy } from "../src/types.js";

const policy: OwnerPolicy = {
  paperOnly: true,
  maxSinglePositionMarginPct: "30",
  maxLeverage: "5",
  maxDailyDrawdownPct: "10",
  drawdownCooldownMinutes: 60,
  scanIntervalMinutes: 15,
  emergencyStop: false,
};

describe("daily drawdown policy", () => {
  it("sets a daily baseline and allows normal observation", () => {
    const result = evaluateDrawdown(policy, undefined, "1000", new Date("2026-09-12T00:00:00.000Z"));
    expect(result.blocked).toBe(false);
    expect(result.state.baselineEquity).toBe("1000");
  });

  it("blocks writes and starts cooldown at the daily threshold", () => {
    const result = evaluateDrawdown(
      policy,
      { date: "2026-09-12", baselineEquity: "1000", lastEquity: "1000" },
      "900",
      new Date("2026-09-12T01:00:00.000Z"),
    );
    expect(result.blocked).toBe(true);
    expect(result.code).toBe("DAILY_DRAWDOWN");
    expect(result.state.cooldownUntil).toBe("2026-09-12T02:00:00.000Z");
  });

  it("keeps trading blocked during cooldown while learning may continue", () => {
    const result = evaluateDrawdown(
      policy,
      {
        date: "2026-09-12",
        baselineEquity: "1000",
        lastEquity: "900",
        cooldownUntil: "2026-09-12T02:00:00.000Z",
      },
      "900",
      new Date("2026-09-12T01:30:00.000Z"),
    );
    expect(result.blocked).toBe(true);
    expect(result.code).toBe("DRAWDOWN_COOLDOWN");
  });
});
