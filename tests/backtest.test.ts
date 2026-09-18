import { describe, expect, it, vi } from "vitest";
import { createBacktestLesson, runCooldownBacktest, runCooldownBacktestSafely } from "../src/learning/backtest.js";
import { BACKTEST_TASK_PROMPT, PROMPT_VERSIONS } from "../src/agent/mandate.js";
import type { HistoricalBar, RuntimeConfig, TradeExperience } from "../src/types.js";

vi.mock("../src/agent/qwen.js", () => ({ generateQwenJson: vi.fn() }));

import { generateQwenJson } from "../src/agent/qwen.js";

const generate = vi.mocked(generateQwenJson);

const config = { qwenApiKey: "test-key" } as RuntimeConfig;
const bars: HistoricalBar[] = [
  { observedAt: "2026-09-15T00:00:00.000Z", open: "100", high: "101", low: "99", close: "100", volume: "10" },
  { observedAt: "2026-09-15T01:00:00.000Z", open: "100", high: "102", low: "100", close: "101", volume: "11" },
  { observedAt: "2026-09-15T02:00:00.000Z", open: "101", high: "103", low: "100", close: "102", volume: "12" },
];
const experiences: TradeExperience[] = [];
const baseOutput = (selectedLesson = "concise lesson") => ({ hypotheses: ["test hypothesis"], traces: [{ hypothesis: "test hypothesis", actions: ["HOLD", "HOLD", "HOLD"] }], selectedLesson });

describe("cooldown backtest schema", () => {
  it("persists a valid replay and accepts a selectedLesson of exactly 500 characters", async () => {
    generate.mockResolvedValueOnce(baseOutput("x".repeat(500)) as never);
    const replay = await runCooldownBacktest(config, { symbol: "COINUSDT", bars, experiences, trigger: "DAILY_DRAWDOWN", now: new Date("2026-09-15T03:00:00.000Z") });
    expect(replay?.selectedLesson).toHaveLength(500);
    expect(replay?.metrics).toHaveLength(2);
    expect(createBacktestLesson(replay!).lesson).toHaveLength(500);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("rejects selectedLesson values longer than 500 characters without truncation", async () => {
    generate.mockResolvedValueOnce(baseOutput("x".repeat(501)) as never);
    await expect(runCooldownBacktest(config, { symbol: "COINUSDT", bars, experiences, trigger: "DAILY_DRAWDOWN" })).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("turns a malformed backtest into one bounded failure and no replay", async () => {
    generate.mockResolvedValueOnce(baseOutput("x".repeat(501)) as never);
    const failures: Record<string, string>[] = [];
    const replay = await runCooldownBacktestSafely(config, { symbol: "COINUSDT", bars, experiences, trigger: "DAILY_DRAWDOWN" }, (metadata) => failures.push(metadata));
    expect(replay).toBeUndefined();
    expect(failures).toEqual([{ category: "COOLDOWN_BACKTEST", code: "ZOD_VALIDATION_FAILED", firstIssuePath: "selectedLesson", firstIssueCode: "too_big" }]);
    expect(JSON.stringify(failures)).not.toContain("x".repeat(501));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("keeps the schema and prompt contract explicit", () => {
    expect(PROMPT_VERSIONS.backtest).toBe("darwin-backtest-v2");
    expect(BACKTEST_TASK_PROMPT).toContain("Hypotheses <=240 characters each");
    expect(BACKTEST_TASK_PROMPT).toContain("Trace hypothesis <=240 characters");
    expect(BACKTEST_TASK_PROMPT).toContain("selectedLesson <=500 characters");
    expect(BACKTEST_TASK_PROMPT).toContain("selectedLesson must be concise and directly actionable");
    expect(BACKTEST_TASK_PROMPT).toContain("JSON only");
    expect(BACKTEST_TASK_PROMPT).toContain("No chain-of-thought");
  });
});