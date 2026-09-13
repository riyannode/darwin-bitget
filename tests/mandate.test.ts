import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DECISION_TASK_PROMPT, MANDATE_VERSION, PROMPT_VERSIONS, TRADING_MANDATE } from "../src/agent/mandate.js";

describe("judge-facing mandate contract", () => {
  it("uses the v4 mandate and requires an evidence-backed explanation", () => {
    expect(PROMPT_VERSIONS.mandate).toBe("darwin-mandate-v4");
    expect(MANDATE_VERSION).toBe("darwin-mandate-v4");
    expect(TRADING_MANDATE).toContain("decision rationale");
    expect(TRADING_MANDATE).toContain("supporting evidence");
    expect(TRADING_MANDATE).toContain("risk and invalidation");
    expect(TRADING_MANDATE).toContain("deterministic risk controls");
    expect(DECISION_TASK_PROMPT).toContain("evidenceUsed");
    expect(DECISION_TASK_PROMPT).toContain("supportingFactors");
    expect(DECISION_TASK_PROMPT).toContain("riskFactors");
  });

  it("renders evidence used beside the other decision explanations", () => {
    const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
    expect(dashboard).toContain('detail("EVIDENCE USED", list(decision.evidenceUsed), true)');
  });
});
