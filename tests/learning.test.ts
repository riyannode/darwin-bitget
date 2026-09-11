import { describe, expect, it } from "vitest";
import { retrieveLessons } from "../src/learning/lesson-retrieval.js";
import { reflect } from "../src/learning/reflection.js";
import type { Decision, Lesson } from "../src/types.js";

const baseDecision: Decision = {
  decisionId: "decision-1",
  cycleId: "cycle-1",
  action: "OPEN_LONG",
  symbol: "RAAPLUSDT",
  positionSide: "LONG",
  marginAllocationPct: "10",
  leverage: "2",
  reductionPct: null,
  confidence: 0.6,
  thesis: "market evidence supports a bounded entry",
  strategyThesis: "market structure supports a bounded entry hypothesis",
  supportingFactors: ["ticker"],
  riskFactors: ["uncertainty"],
  evidenceUsed: ["TICKER"],
  lessonsUsed: [],
  createdAt: "2026-09-12T00:00:00.000Z",
};

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    lessonId: "lesson-1",
    lessonType: "OUTCOME",
    source: "SELF_OUTCOME",
    symbolScope: "RAAPLUSDT",
    marketRegime: "UNKNOWN",
    trigger: "COMPLETED_CYCLE",
    failureCode: "",
    actionTaken: "OPEN_LONG",
    observedOutcome: "OPEN",
    lesson: "Compare the thesis with later evidence.",
    applicableConditions: ["UNKNOWN"],
    confidence: 0.5,
    timesRetrieved: 0,
    timesApplied: 0,
    successfulApplications: 0,
    failedApplications: 0,
    status: "ACTIVE",
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("lesson memory", () => {
  it("retrieves the relevant lesson without changing risk limits", () => {
    const result = retrieveLessons(
      [lesson(), lesson({ lessonId: "lesson-2", symbolScope: "RNVDAUSDT" })],
      { symbol: "RAAPLUSDT", marketRegime: "UNKNOWN", action: "OPEN_LONG" },
    );

    expect(result.map((entry) => entry.lessonId)).toEqual(["lesson-1", "lesson-2"]);
  });

  it("creates a candidate lesson and an observable experience", () => {
    const result = reflect({
      decision: baseDecision,
      outcome: "OPEN",
      failureCode: "",
      symbol: baseDecision.symbol,
      marketRegime: "UNKNOWN",
      experienceStatus: "OPEN",
    });

    expect(result.lesson.status).toBe("CANDIDATE");
    expect(result.experience.outcomeStatus).toBe("OPEN");
    expect(result.experience.entryDecisionId).toBe(baseDecision.decisionId);
  });

  it("closes the original experience instead of creating a second trade", () => {
    const opened = reflect({
      decision: baseDecision,
      outcome: "OPEN",
      failureCode: "",
      symbol: baseDecision.symbol,
      marketRegime: "TRENDING_UP",
      experienceStatus: "OPEN",
      now: new Date("2026-09-12T00:00:00.000Z"),
    });
    const closedDecision: Decision = { ...baseDecision, decisionId: "decision-2", action: "CLOSE", marginAllocationPct: "0", leverage: "2", thesis: "the thesis is invalidated", strategyThesis: "the thesis is invalidated" };
    const closed = reflect({
      decision: closedDecision,
      outcome: "CLOSED",
      failureCode: "",
      symbol: baseDecision.symbol,
      marketRegime: "TRENDING_DOWN",
      experienceStatus: "LOSING",
      entryPrice: opened.experience.entryPrice,
      exitPrice: "98",
      realizedPnl: "-4",
      realizedPnlPct: "-2",
      realizedPnlVerified: true,
      existingExperience: opened.experience,
      now: new Date("2026-09-12T00:15:00.000Z"),
    });

    expect(closed.experience.experienceId).toBe(opened.experience.experienceId);
    expect(closed.experience.entryDecisionId).toBe(baseDecision.decisionId);
    expect(closed.experience.exitDecisionId).toBe("decision-2");
    expect(closed.experience.outcomeStatus).toBe("LOSING");
    expect(closed.experience.realizedPnlVerified).toBe(true);
  });
});
