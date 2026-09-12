import { describe, expect, it } from "vitest";
import { buildPaperLogExport, calculatePeakDrawdown, paperLogToCsv, parsePaperLogPeriod } from "../src/storage/paper-log.js";
import type { ActivityEvent, Decision, TradeExperience, TradingJournal } from "../src/types.js";

function decision(cycleId: string, action: Decision["action"], decisionId: string, createdAt: string): Decision {
  return { decisionId, cycleId, action, positionSide: action === "OPEN_LONG" || action === "CLOSE" ? "LONG" : null, symbol: "NVDAUSDT", marginAllocationPct: action === "HOLD" ? "0" : "1", leverage: "1", reductionPct: action === "CLOSE" ? null : null, confidence: 0.5, thesis: "bounded thesis", strategyThesis: "bounded strategy thesis", supportingFactors: ["volume"], riskFactors: ["volatility"], evidenceUsed: ["ticker"], lessonsUsed: [], createdAt };
}

function journal(index: number, action: Decision["action"]): TradingJournal {
  const cycleId = `cycle-${index}`;
  const createdAt = new Date(Date.UTC(2026, 8, 12, 0, index)).toISOString();
  const current = decision(cycleId, action, `decision-${index}`, createdAt);
  return { cycleId, agentVersion: "0.2.0", model: "qwen3.8-max", mode: "AUTONOMOUS", startedAt: createdAt, completedAt: createdAt, retrievedLessons: [], decision: current, createdLessons: [], durationMs: 1000 };
}

function experience(): TradeExperience {
  return { experienceId: "experience-1", symbol: "NVDAUSDT", positionSide: "LONG", action: "OPEN_LONG", entryDecisionId: "decision-1", entryPrice: "100", entryTime: "2026-09-12T00:01:00.000Z", exitDecisionId: "decision-2", exitPrice: "99", exitTime: "2026-09-12T00:02:00.000Z", selectedLeverage: "1", marginAllocationPct: "1", marginAllocated: "10", positionNotional: "10", realizedPnl: "-0.0456", realizedPnlPct: "-0.456", maximumFavorableExcursion: "0", maximumAdverseExcursion: "-0.0456", drawdownContribution: "-0.0456", liquidationDistance: "0", entryThesis: "entry", exitThesis: "exit", evidenceAtEntry: ["ticker"], evidenceAtExit: ["ticker"], lessonsUsed: [], marketContext: "RANGE_LOW_VOL", outcomeStatus: "LOSING", realizedPnlVerified: true };
}

describe("paper log export", () => {
  it("calculates peak-to-trough drawdown after a new peak", () => {
    expect(calculatePeakDrawdown(["10000", "10500", "10100"])).toEqual({ current: "-3.80952381", maximum: "-3.80952381" });
  });

  it("keeps the worst drawdown after a partial recovery", () => {
    expect(calculatePeakDrawdown(["10000", "9000", "9500"])).toEqual({ current: "-5.00000000", maximum: "-10.00000000" });
  });

  it("reports zero drawdown for monotonic rising equity", () => {
    expect(calculatePeakDrawdown(["10000", "10500", "11000"])).toEqual({ current: "0.00000000", maximum: "0.00000000" });
  });

  it("exports full autonomous history, including HOLD, while excluding non-autonomous journals", () => {
    const journals = Array.from({ length: 30 }, (_, index) => journal(index, index === 0 ? "HOLD" : "OPEN_LONG"));
    const manual = { ...journal(31, "OPEN_LONG"), cycleId: "manual-test" , mode: "EVA_EVALUATION" as const };
    const events: ActivityEvent[] = journals.map((entry) => ({ eventId: `event-${entry.cycleId}`, type: "CYCLE_COMPLETED", cycleId: entry.cycleId, createdAt: entry.startedAt }));
    const autonomousJournals = journals.map((entry, index) => index === 1 ? { ...entry, experienceIds: ["experience-1"] } : entry);
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.2.0", commit: "test", cycles: autonomousJournals.concat(manual).map((entry) => ({ cycleId: entry.cycleId, status: "COMPLETED", startedAt: entry.startedAt, completedAt: entry.completedAt ?? null })), journals: [...autonomousJournals, manual], experiences: [experience()], events });

    expect(exported.cycles).toHaveLength(30);
    expect(exported.decisions).toHaveLength(30);
    expect(exported.summary.decisions.HOLD).toBe(1);
    expect(exported.experiences[0]?.realizedPnl).toBe("-0.0456");
    expect(JSON.stringify(exported)).not.toContain("manual-test");
  });

  it("produces a flattened CSV with decision and execution fields", () => {
    const exported = buildPaperLogExport({ generatedAt: "2026-09-12T00:03:00.000Z", period: { start: null, end: null }, environment: "test", model: "qwen3.8-max", version: "0.2.0", commit: "test", cycles: [{ cycleId: "cycle-1", status: "COMPLETED", startedAt: "2026-09-12T00:00:00.000Z", completedAt: "2026-09-12T00:01:00.000Z" }], journals: [journal(1, "HOLD")], experiences: [], events: [] });
    const csv = paperLogToCsv(exported);

    expect(csv).toContain("cycleId,cycleStatus");
    expect(csv).toContain("decision-1");
    expect(csv).toContain("HOLD");
    expect(csv).not.toContain("apiKey");
    expect(csv).not.toContain("passphrase");
  });

  it("validates export periods deterministically", () => {
    expect(parsePaperLogPeriod("2026-09-12T00:00:00Z", "2026-09-12T01:00:00Z")).toEqual({ start: "2026-09-12T00:00:00.000Z", end: "2026-09-12T01:00:00.000Z" });
    expect(() => parsePaperLogPeriod("invalid", null)).toThrow("INVALID_EXPORT_PERIOD");
    expect(() => parsePaperLogPeriod("2026-09-12T01:00:00Z", "2026-09-12T00:00:00Z")).toThrow("INVALID_EXPORT_PERIOD");
  });
});
