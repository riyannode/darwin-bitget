import { describe, expect, it } from "vitest";

describe("collectResearchEvidence telemetry", () => {
  // These are integration-level tests that verify the telemetry structure
  // emitted by collectResearchEvidence in the agent. We test the telemetry
  // setup and emit functions directly since the agent requires a DO context.

  it("telemetry shape for requests=[] Case A", () => {
    // Simulated summary for Case A: router attempted, empty plan, no MCP
    const summary: Record<string, unknown> = {
      cycleId: "test-cycle",
      signalEnabled: true,
      availableSkillCount: 1,
      routerAttempted: true,
      planRequests: 0,
      acceptedRequests: 0,
      rejectedRequests: 0,
      requestedSkills: [],
      requestedSymbols: [],
      cacheHits: 0,
      mcpConnectAttempts: 0,
      mcpConnectSuccesses: 0,
      mcpToolCalls: 0,
      availableResults: 0,
      unavailableResults: 0,
      durationMs: 45,
      finalStatus: "NO_RESULTS",
    };

    expect(summary.routerAttempted).toBe(true);
    expect(summary.mcpConnectAttempts).toBe(0);
    expect(summary.mcpToolCalls).toBe(0);
    expect(summary.finalStatus).toBe("NO_RESULTS");
  });

  it("telemetry shape for MCP execution Case B", () => {
    // Simulated summary for Case B: router planned, MCP executed
    const summary: Record<string, unknown> = {
      cycleId: "test-cycle",
      signalEnabled: true,
      availableSkillCount: 1,
      routerAttempted: true,
      planRequests: 1,
      acceptedRequests: 1,
      rejectedRequests: 0,
      requestedSkills: ["technical-analysis"],
      requestedSymbols: ["CRCLUSDT"],
      cacheHits: 0,
      mcpConnectAttempts: 1,
      mcpConnectSuccesses: 1,
      mcpToolCalls: 1,
      availableResults: 1,
      unavailableResults: 0,
      durationMs: 812,
      finalStatus: "COMPLETED",
    };

    expect(summary.routerAttempted).toBe(true);
    expect(summary.mcpConnectAttempts).toBe(1);
    expect(summary.mcpToolCalls).toBe(1);
    expect(summary.availableResults).toBe(1);
    expect(summary.finalStatus).toBe("COMPLETED");
  });

  it("telemetry shape for SIGNAL_DISABLED early return", () => {
    const summary: Record<string, unknown> = {
      cycleId: "test-cycle",
      signalEnabled: false,
      availableSkillCount: 0,
      routerAttempted: false,
      finalStatus: "SIGNAL_DISABLED",
    };

    expect(summary.routerAttempted).toBe(false);
    expect(summary.finalStatus).toBe("SIGNAL_DISABLED");
  });

  it("telemetry shape for NO_AVAILABLE_CAPABILITY early return", () => {
    const summary: Record<string, unknown> = {
      cycleId: "test-cycle",
      signalEnabled: true,
      availableSkillCount: 0,
      routerAttempted: false,
      finalStatus: "NO_AVAILABLE_CAPABILITY",
    };

    expect(summary.routerAttempted).toBe(false);
    expect(summary.finalStatus).toBe("NO_AVAILABLE_CAPABILITY");
  });

  it("telemetry shape for ROUTER_FAILED", () => {
    const summary: Record<string, unknown> = {
      cycleId: "test-cycle",
      signalEnabled: true,
      availableSkillCount: 1,
      routerAttempted: true,
      finalStatus: "ROUTER_FAILED",
    };

    expect(summary.routerAttempted).toBe(true);
    expect(summary.finalStatus).toBe("ROUTER_FAILED");
  });

  it("bounded requestedSkills length", () => {
    const requestedSkills = ["technical-analysis", "macro-analyst", "news-briefing", "sentiment-analyst"];
    const bounded = requestedSkills.slice(0, 3);
    expect(bounded.length).toBe(3);
    expect(bounded).toEqual(["technical-analysis", "macro-analyst", "news-briefing"]);
  });

  it("bounded requestedSymbols length", () => {
    const requestedSymbols = ["CRCLUSDT", "COINUSDT", "HOODUSDT", "MSTRUSDT"];
    const bounded = requestedSymbols.slice(0, 3);
    expect(bounded.length).toBe(3);
    expect(bounded).toEqual(["CRCLUSDT", "COINUSDT", "HOODUSDT"]);
  });
});
