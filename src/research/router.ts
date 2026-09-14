import { z } from "zod";
import type { RuntimeConfig, ResearchPlan, ResearchRequest } from "../types.js";
import { generateQwenJson } from "../agent/qwen.js";
import { BITGET_SIGNAL_RECIPE_VERSION, type ResearchCapability } from "./capabilities.js";

export const MAX_RESEARCH_REQUESTS_PER_CYCLE = 3;
export const MAX_MCP_TOOL_CALLS_PER_CYCLE = 4;
export const RESEARCH_CONCURRENCY = 2;
export const RESEARCH_ROUTER_TIMEOUT_MS = 10_000;
export const RESEARCH_TOOL_TIMEOUT_MS = 8_000;
export const RESEARCH_PHASE_TIMEOUT_MS = 15_000;
export const RESEARCH_CACHE_TTL_MS = 10 * 60_000;
export const MAX_NORMALIZED_RESEARCH_BYTES_PER_ITEM = 6 * 1024;
export const MAX_NORMALIZED_RESEARCH_BYTES_PER_CYCLE = 16 * 1024;
export const RESEARCH_ROUTER_PROMPT_VERSION = "darwin-research-router-v1";

const researchSkill = z.enum(["macro-analyst", "market-intel", "news-briefing", "sentiment-analyst", "technical-analysis"]);
const researchRequestSchema = z.object({
  skill: researchSkill,
  symbol: z.string().min(1).max(40).nullable(),
  purpose: z.string().min(1).max(240),
});

export const researchPlanSchema = z.object({
  requests: z.array(researchRequestSchema).max(MAX_RESEARCH_REQUESTS_PER_CYCLE),
});

export interface ResearchRouterInput {
  availableResearchSkills: ResearchCapability[];
  openPositionSymbols: string[];
  entryCandidateSymbols: string[];
  marketEvidence: Array<{
    symbol: string;
    lastPrice: string;
    priceChange24h: string;
    volume24h: string;
    marketRegime: string;
  }>;
  researchBudget: {
    maxResearchRequests: number;
    maxMcpToolCalls: number;
    concurrency: number;
  };
}

export interface ResearchPlanValidation {
  accepted: ResearchRequest[];
  rejected: Array<{ request: ResearchRequest; reason: string }>;
}

type ResearchPlanGenerator = (
  config: RuntimeConfig,
  schema: typeof researchPlanSchema,
  system: string,
  prompt: string,
  options: { maxOutputTokens: number; timeoutMs: number },
) => Promise<ResearchPlan>;

const defaultGenerator: ResearchPlanGenerator = (config, schema, system, prompt, options) => generateQwenJson(config, schema, system, prompt, options);

export function buildResearchRouterPrompt(input: ResearchRouterInput): string {
  return JSON.stringify({
    availableResearchSkills: input.availableResearchSkills.map((capability) => ({
      skill: capability.skill,
      scope: capability.scope,
      workerCompatible: capability.workerCompatible,
      rwaSupport: capability.rwaSupport,
      mcpTools: capability.mcpTools,
      callsPerRequest: capability.callsPerRequest,
      supportedSymbols: capability.supportedSymbols,
      knownCoverageGaps: capability.knownCoverageGaps,
    })),
    openPositionSymbols: input.openPositionSymbols,
    entryCandidateSymbols: input.entryCandidateSymbols,
    marketEvidence: input.marketEvidence,
    researchBudget: input.researchBudget,
    contract: {
      version: RESEARCH_ROUTER_PROMPT_VERSION,
      recipeVersion: BITGET_SIGNAL_RECIPE_VERSION,
      chooseNeedsOnly: true,
      noTrades: true,
      noLeverage: true,
      noAllocation: true,
      noOrderQuantity: true,
      noProviderOperations: true,
      noArbitraryTools: true,
      noArbitraryUrls: true,
      emptyPlanAllowed: true,
      symbolRule: "Symbol-specific requests may target only an open provider position or current entry candidate. Global scope is represented by symbol=null and is only legal for a capability whose scope is GLOBAL.",
    },
  });
}

export class ResearchRouter {
  public constructor(private readonly generate: ResearchPlanGenerator = defaultGenerator) {}

  public async plan(config: RuntimeConfig, input: ResearchRouterInput): Promise<ResearchPlan> {
    return this.generate(
      config,
      researchPlanSchema,
      "You are a bounded research router. Choose optional evidence requests only. Research is perception, never financial authority. Return requests=[] when no research is useful. Do not invent skills, tools, URLs, symbols, trade actions, sizing, leverage, allocation, or provider operations.",
      buildResearchRouterPrompt(input),
      { maxOutputTokens: 700, timeoutMs: RESEARCH_ROUTER_TIMEOUT_MS },
    );
  }
}

export function validateResearchPlan(plan: ResearchPlan, input: ResearchRouterInput): ResearchPlanValidation {
  const accepted: ResearchRequest[] = [];
  const rejected: Array<{ request: ResearchRequest; reason: string }> = [];
  const allowedSymbols = new Set([...input.openPositionSymbols, ...input.entryCandidateSymbols]);
  const capabilities = new Map(input.availableResearchSkills.map((capability) => [capability.skill, capability]));

  for (const request of plan.requests) {
    if (accepted.length >= MAX_RESEARCH_REQUESTS_PER_CYCLE) {
      rejected.push({ request, reason: "MAX_RESEARCH_REQUESTS_PER_CYCLE" });
      continue;
    }
    const capability = capabilities.get(request.skill);
    if (!capability || capability.workerCompatible !== "YES") {
      rejected.push({ request, reason: "UNSUPPORTED_RESEARCH_SKILL" });
      continue;
    }
    if (request.symbol === null && capability.scope !== "GLOBAL") {
      rejected.push({ request, reason: "SYMBOL_REQUIRED" });
      continue;
    }
    if (request.symbol !== null && !allowedSymbols.has(request.symbol)) {
      rejected.push({ request, reason: "SYMBOL_NOT_OPEN_OR_CANDIDATE" });
      continue;
    }
    if (request.symbol !== null && capability.supportedSymbols.length > 0 && !capability.supportedSymbols.includes(request.symbol)) {
      rejected.push({ request, reason: "SYMBOL_UNSUPPORTED_BY_CAPABILITY" });
      continue;
    }
    accepted.push({ ...request, purpose: request.purpose.trim().slice(0, 240) });
  }
  return { accepted, rejected };
}
