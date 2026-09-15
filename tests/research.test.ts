import { describe, expect, it, vi } from "vitest";
vi.mock("agents", () => ({ Agent: class {}, routeAgentRequest: vi.fn() }));
import { TraderAgent } from "../src/agent/agent.js";
import { availableResearchCapabilities } from "../src/research/capabilities.js";
import { ResearchExecutor, normalizeResearchEvidence } from "../src/research/executor.js";
import { MAX_MCP_TOOL_CALLS_PER_CYCLE, MAX_RESEARCH_REQUESTS_PER_CYCLE, RESEARCH_CONCURRENCY, buildResearchRouterPrompt, researchPlanSchema, validateResearchPlan, type ResearchRouterInput } from "../src/research/router.js";
import type { ResearchRequest } from "../src/types.js";

const input: ResearchRouterInput = {
  availableResearchSkills: availableResearchCapabilities(),
  openPositionSymbols: ["COINUSDT"],
  entryCandidateSymbols: ["CRCLUSDT", "KORUUSDT"],
  marketEvidence: [{ symbol: "COINUSDT", lastPrice: "190", priceChange24h: "0.1", volume24h: "1000", marketRegime: "RANGE_HIGH_VOL" }],
  researchBudget: { maxResearchRequests: MAX_RESEARCH_REQUESTS_PER_CYCLE, maxMcpToolCalls: MAX_MCP_TOOL_CALLS_PER_CYCLE, concurrency: RESEARCH_CONCURRENCY },
};

function request(symbol: string | null = "COINUSDT"): ResearchRequest {
  return { skill: "technical-analysis", symbol, purpose: "Check bounded technical context" };
}

describe("Bitget Signal research router", () => {
  it("accepts an empty research plan", () => {
    expect(researchPlanSchema.parse({ requests: [] })).toEqual({ requests: [] });
  });

  it("accepts one supported symbol-specific request and exposes only deployed skills", () => {
    const plan = researchPlanSchema.parse({ requests: [request()] });
    expect(validateResearchPlan(plan, input).accepted).toEqual([request()]);
    const prompt = buildResearchRouterPrompt(input);
    expect(prompt).toContain('"technical-analysis"');
    expect(prompt).not.toContain('"macro-analyst"');
    expect(prompt).toContain('"maxMcpToolCalls":4');
  });

  it("rejects unsupported skills and symbols without throwing", () => {
    const unsupportedSkill = researchPlanSchema.parse({ requests: [{ skill: "news-briefing", symbol: "COINUSDT", purpose: "news" }] });
    expect(validateResearchPlan(unsupportedSkill, input).rejected[0]?.reason).toBe("UNSUPPORTED_RESEARCH_SKILL");
    const unsupportedSymbol = researchPlanSchema.parse({ requests: [request("KORUUSDT")] });
    expect(validateResearchPlan(unsupportedSymbol, input).rejected[0]?.reason).toBe("SYMBOL_UNSUPPORTED_BY_CAPABILITY");
  });

  it("accepts global macro only when the capability matrix declares it", () => {
    const globalInput: ResearchRouterInput = { ...input, availableResearchSkills: [{ skill: "macro-analyst", workerCompatible: "YES", scope: "GLOBAL", rwaSupport: "NO", mcpTools: ["rates_yields"], callsPerRequest: 1, supportedSymbols: [], knownCoverageGaps: [] }] };
    const plan = researchPlanSchema.parse({ requests: [{ skill: "macro-analyst", symbol: null, purpose: "Macro context" }] });
    expect(validateResearchPlan(plan, globalInput).accepted).toHaveLength(1);
  });

  it("enforces the research request cap", () => {
    expect(() => researchPlanSchema.parse({ requests: Array.from({ length: MAX_RESEARCH_REQUESTS_PER_CYCLE + 1 }, () => request()) })).toThrow();
  });

  it("enforces MCP tool cost, not only request count", () => {
    const expensiveInput: ResearchRouterInput = {
      ...input,
      availableResearchSkills: [{ ...availableResearchCapabilities()[0]!, callsPerRequest: 2 }],
      researchBudget: { ...input.researchBudget, maxMcpToolCalls: 3 },
    };
    const plan = researchPlanSchema.parse({ requests: [request(), request("CRCLUSDT")] });
    const result = validateResearchPlan(plan, expensiveInput);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("MAX_MCP_TOOL_CALLS_PER_CYCLE");
  });

  it("restricts full-capacity research to currently open symbols", () => {
    const saturatedInput: ResearchRouterInput = { ...input, entryCandidateSymbols: [] };
    const plan = researchPlanSchema.parse({ requests: [request("COINUSDT"), request("CRCLUSDT")] });
    const result = validateResearchPlan(plan, saturatedInput);
    expect(result.accepted).toEqual([request("COINUSDT")]);
    expect(result.rejected[0]?.reason).toBe("SYMBOL_NOT_OPEN_OR_CANDIDATE");
  });

  it("does not invoke the research router or MCP executor when Signal is disabled", async () => {
    let routerCalls = 0;
    let executorCalls = 0;
    const collectResearchEvidence = (TraderAgent.prototype as unknown as {
      collectResearchEvidence: (this: unknown, config: { bitgetSignalEnabled?: boolean }, bundles: readonly [], openPositionSymbols: readonly string[], entryCandidateSymbols: readonly string[]) => Promise<unknown[]>;
    }).collectResearchEvidence;
    const fakeAgent = {
      researchRouter: { plan: async () => { routerCalls += 1; return { requests: [] }; } },
      researchExecutor: { execute: async () => { executorCalls += 1; return []; } },
    };
    const result = await collectResearchEvidence.call(fakeAgent, { bitgetSignalEnabled: false }, [], [], []);
    expect(result).toEqual([]);
    expect(routerCalls).toBe(0);
    expect(executorCalls).toBe(0);
  });
});

describe("bounded research execution", () => {
  it("normalizes malformed payloads without exposing raw payloads", () => {
    const raw = { giant: "x".repeat(100_000), verdict: "bullish", nested: { signal: "neutral" } };
    const evidence = normalizeResearchEvidence("technical-analysis", "COINUSDT", raw, "2026-09-15T00:00:00.000Z");
    expect(evidence.status).toBe("AVAILABLE");
    expect(evidence.facts.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(evidence)).not.toContain("x".repeat(1_000));
    expect(new TextEncoder().encode(JSON.stringify(evidence)).byteLength).toBeLessThanOrEqual(6 * 1024);
    const oversized = normalizeResearchEvidence("technical-analysis", "COINUSDT", { content: [{ type: "text", text: "x".repeat(70_000) }] }, "2026-09-15T00:00:00.000Z");
    expect(oversized.status).toBe("UNAVAILABLE");
  });

  it("bounds concurrency, degrades errors, and caches successful results", async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const executor = new ResearchExecutor({
      connect: async () => ({
        callTool: async () => {
          calls += 1;
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return { content: [{ type: "text", text: JSON.stringify({ symbol: "COIN/USDT", verdict: "bullish", error: "" }) }] };
        },
      }),
    });
    const requests = [request(), request("CRCLUSDT"), request("MSTRUSDT")];
    const first = await executor.execute(requests, new Date("2026-09-15T00:00:00.000Z"));
    const second = await executor.execute(requests, new Date("2026-09-15T00:05:00.000Z"));
    expect(first.every((item) => item.status === "AVAILABLE")).toBe(true);
    expect(second.every((item) => item.status === "AVAILABLE")).toBe(true);
    expect(peak).toBeLessThanOrEqual(RESEARCH_CONCURRENCY);
    expect(calls).toBe(3);
    expect(executor.cacheSize()).toBe(3);
  });

  it("does not negative-cache transport failures", async () => {
    let calls = 0;
    let recovered = false;
    const executor = new ResearchExecutor({
      connect: async () => ({
        callTool: async () => {
          calls += 1;
          if (!recovered) throw new Error("MCP_500");
          return { content: [{ type: "text", text: JSON.stringify({ verdict: "recovered" }) }] };
        },
      }),
    });
    const first = await executor.execute([request()], new Date("2026-09-15T00:00:00.000Z"));
    recovered = true;
    const recoveredResult = await executor.execute([request()], new Date("2026-09-15T00:00:01.000Z"));
    const cachedAvailable = await executor.execute([request()], new Date("2026-09-15T00:05:00.000Z"));
    expect(first[0]?.status).toBe("UNAVAILABLE");
    expect(recoveredResult[0]?.status).toBe("AVAILABLE");
    expect(cachedAvailable[0]?.status).toBe("AVAILABLE");
    expect(calls).toBe(2);
  });

  it("continues when the MCP connection is unavailable", async () => {
    const executor = new ResearchExecutor({ connect: async () => { throw new Error("CONNECT_TIMEOUT"); } });
    const result = await executor.execute([request()]);
    expect(result[0]?.status).toBe("UNAVAILABLE");
  });
});
