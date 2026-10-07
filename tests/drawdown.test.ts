import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
  it.each([
    ["1000", "901", "10", false],
    ["1000", "900", "10", true],
    ["1000", "899", "10", true],
    ["1000", "999", "10", false],
    ["1000", "995", "10", false],
    ["1000", "950", "5", true],
    ["1000", "949.99", "5", true],
    ["1000", "945.01", "5.5", false],
    ["1000", "945", "5.5", true],
  ] as const)("compares exact drawdown boundaries for baseline %s, equity %s, and limit %s%%", (baselineEquity, currentEquity, maxDailyDrawdownPct, blocked) => {
    const result = evaluateDrawdown(
      { ...policy, maxDailyDrawdownPct },
      { date: "2026-09-12", baselineEquity, lastEquity: baselineEquity },
      currentEquity,
      new Date("2026-09-12T01:00:00.000Z"),
    );
    expect(result.blocked).toBe(blocked);
  });

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

  it("presents the cooldown expiry as a recheck point rather than a guaranteed resume time", () => {
    const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
    expect(dashboard).toContain("RUNTIME ${agent.status} · DAILY DRAWDOWN GUARD ACTIVE · RISK-INCREASING WRITES PAUSED · NEXT RECHECK ${when(snapshot.riskControls.cooldownUntil)}");
    expect(dashboard).not.toContain("RESUMES ${when(snapshot.riskControls.cooldownUntil)}");
    expect(dashboard).not.toMatch(/WRITES PAUSED\s*·\s*RESUMES/);
  });

  it("keeps the cooldown timestamp a recheck point because a breach reopens a cooldown after expiry", () => {
    const breached = evaluateDrawdown(
      policy,
      { date: "2026-09-12", baselineEquity: "1000", lastEquity: "900", cooldownUntil: "2026-09-12T02:00:00.000Z" },
      "900",
      new Date("2026-09-12T02:00:00.000Z"),
    );
    expect(breached.blocked).toBe(true);
    expect(breached.code).toBe("DAILY_DRAWDOWN");
    expect(breached.state.cooldownUntil).toBe("2026-09-12T03:00:00.000Z");
  });
});
