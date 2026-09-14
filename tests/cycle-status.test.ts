import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("agents", () => ({ Agent: class {}, routeAgentRequest: vi.fn() }));
import { z } from "zod";
import { failureDiagnostic } from "../src/agent/agent.js";
import { cycleReadModel } from "../src/storage/journal-normalizer.js";
import type { Decision, TradingJournal } from "../src/types.js";

const baseJournal = {
  cycleId: "cycle-failed",
  agentVersion: "0.2.0",
  promptVersion: "darwin-mandate-v6",
  model: "qwen3.8-max",
  mode: "AUTONOMOUS",
  startedAt: "2026-09-14T12:00:00.000Z",
  retrievedLessons: [],
  createdLessons: [],
} as unknown as TradingJournal;

const hold = {
  decisionId: "hold-1",
  cycleId: "cycle-completed",
  action: "HOLD",
  positionSide: "LONG",
  symbol: "CRCLUSDT",
  marginAllocationPct: "0",
  leverage: "3",
  reductionPct: null,
  confidence: 0.8,
  thesis: "Hold the existing long.",
  strategyThesis: "The current evidence supports continuation.",
  supportingFactors: ["Support holds."],
  riskFactors: ["Range risk."],
  evidenceUsed: ["Provider evidence."],
  lessonsUsed: [],
  createdAt: "2026-09-14T12:05:00.000Z",
} as unknown as Decision;

describe("cycle status read model", () => {
  it("does not turn a failed pre-decision cycle into a valid zero-action plan", () => {
    const failed = cycleReadModel(baseJournal, "FAILED", "ZOD_VALIDATION_FAILED");
    expect(failed.status).toBe("FAILED");
    expect(failed.hasValidPlan).toBe(false);
    expect(failed.plan.positionActions).toHaveLength(0);
    expect(failed.plan.entryActions).toHaveLength(0);

    const completed = cycleReadModel({ ...baseJournal, cycleId: "cycle-completed", cyclePlan: { positionActions: [hold], entryActions: [] } } as TradingJournal, "COMPLETED");
    expect(completed.status).toBe("COMPLETED");
    expect(completed.hasValidPlan).toBe(true);
    expect(completed.plan.positionActions).toHaveLength(1);
    expect(completed.plan.positionActions[0]?.action).toBe("HOLD");
  });

  it("renders failed cycles separately and preserves the last valid plan contract", () => {
    const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
    expect(dashboard).toContain("CYCLE FAILED BEFORE DECISION");
    expect(dashboard).toContain("Decision plan not produced.");
    expect(dashboard).toContain("const actionCount = cycle.hasValidPlan ? cycle.plan.positionActions.length + cycle.plan.entryActions.length : \"UNAVAILABLE\"");
    expect(dashboard).toContain("const validCycle = snapshot.cyclePlans.find((cycle) => cycle.status === \"COMPLETED\" && cycle.hasValidPlan)");
    expect(dashboard).toContain("No valid cycle plan recorded yet.");
  });
});

describe("safe failure diagnostics", () => {
  it("keeps multiline Zod issues structured and bounded", () => {
    const schema = z.object({ positionActions: z.array(z.object({ marginAllocationPct: z.literal("0") })) });
    const result = schema.safeParse({ positionActions: [{ marginAllocationPct: "10" }] });
    if (result.success) throw new Error("expected schema failure");
    const diagnostic = failureDiagnostic(result.error);
    expect(diagnostic).toMatchObject({
      category: "ZOD_VALIDATION_FAILED",
      code: "ZOD_VALIDATION_FAILED",
      issueCount: "1",
      firstIssuePath: "positionActions.0.marginAllocationPct",
    });
    expect(diagnostic.firstIssueMessage).not.toContain("[ { \"code\"");
    expect(Object.values(diagnostic).every((value) => value.length <= 240)).toBe(true);
  });

  it("does not persist raw prompt or secret material in ordinary errors", () => {
    const diagnostic = failureDiagnostic(new Error("QWEN_REQUEST_FAILED: system message prompt Bearer super-secret-token"));
    expect(diagnostic).toEqual({ category: "RUNTIME_ERROR", code: "QWEN_REQUEST_FAILED", message: "Runtime error" });
    expect(JSON.stringify(diagnostic)).not.toContain("super-secret-token");
    expect(JSON.stringify(diagnostic)).not.toContain("system message prompt");
  });

  it("bounds Zod diagnostics and keeps only the first three issues", () => {
    const error = new z.ZodError([
      { code: "custom", path: ["a"], message: "first" },
      { code: "custom", path: ["b"], message: "second" },
      { code: "custom", path: ["c"], message: "third" },
      { code: "custom", path: ["d"], message: "fourth" },
    ]);
    const diagnostic = failureDiagnostic(error);
    expect(diagnostic.issueCount).toBe("4");
    expect(diagnostic.issue4Path).toBeUndefined();
    expect(diagnostic.issue3Path).toBe("c");
    expect(JSON.stringify(diagnostic).length).toBeLessThan(1200);
  });
});
