import type { ResearchSkill } from "../types.js";

export const BITGET_SIGNAL_MCP_ENDPOINT = "https://datahub.noxiaohao.com/mcp";
export const BITGET_SIGNAL_RECIPE_VERSION = "bitget-signal-mcp-v1";

export interface ResearchCapability {
  skill: ResearchSkill;
  workerCompatible: "YES" | "NO" | "PARTIAL";
  scope: "GLOBAL" | "SYMBOL-SPECIFIC";
  rwaSupport: "YES" | "NO" | "PARTIAL";
  mcpTools: string[];
  callsPerRequest: number;
  supportedSymbols: string[];
  knownCoverageGaps: string[];
}

/**
 * This is deliberately narrower than the official skill playbooks. It is the
 * deployed Worker capability contract derived from the read-only MCP probe.
 */
export const BITGET_SIGNAL_CAPABILITIES: readonly ResearchCapability[] = [
  {
    skill: "macro-analyst",
    workerCompatible: "NO",
    scope: "GLOBAL",
    rwaSupport: "NO",
    mcpTools: ["rates_yields", "macro_indicators", "cross_asset", "global_assets"],
    callsPerRequest: 2,
    supportedSymbols: [],
    knownCoverageGaps: ["Probe responses exceeded the Worker tool timeout and returned empty upstream indicator values."],
  },
  {
    skill: "market-intel",
    workerCompatible: "NO",
    scope: "SYMBOL-SPECIFIC",
    rwaSupport: "NO",
    mcpTools: ["derivatives_sentiment", "crypto_market", "defi_analytics", "dex_market"],
    callsPerRequest: 1,
    supportedSymbols: [],
    knownCoverageGaps: ["Official workflow is crypto/on-chain oriented; RWA perpetual symbols are not proven in the probe."],
  },
  {
    skill: "news-briefing",
    workerCompatible: "NO",
    scope: "SYMBOL-SPECIFIC",
    rwaSupport: "NO",
    mcpTools: ["news_feed", "tradfi_news", "social_trending"],
    callsPerRequest: 1,
    supportedSymbols: [],
    knownCoverageGaps: ["Probe returned empty feed items and tool latency exceeded the Worker v1 budget."],
  },
  {
    skill: "sentiment-analyst",
    workerCompatible: "NO",
    scope: "SYMBOL-SPECIFIC",
    rwaSupport: "NO",
    mcpTools: ["sentiment_index", "derivatives_sentiment"],
    callsPerRequest: 1,
    supportedSymbols: [],
    knownCoverageGaps: ["Probe returned empty sentiment/positioning values, including for BTCUSDT and CRCLUSDT."],
  },
  {
    skill: "technical-analysis",
    workerCompatible: "YES",
    scope: "SYMBOL-SPECIFIC",
    rwaSupport: "PARTIAL",
    mcpTools: ["technical_analysis"],
    callsPerRequest: 1,
    supportedSymbols: ["CRCLUSDT", "COINUSDT", "HOODUSDT", "MSTRUSDT", "NVDAUSDT"],
    knownCoverageGaps: [
      "The official skill documentation describes a local Python/pandas/numpy workflow; this v1 uses only the separately exposed MCP technical_analysis tool.",
      "KORUUSDT returned no OHLCV data in the public MCP probe.",
    ],
  },
];

export function availableResearchCapabilities(): ResearchCapability[] {
  return BITGET_SIGNAL_CAPABILITIES.filter((capability) => capability.workerCompatible === "YES").map((capability) => ({
    ...capability,
    mcpTools: [...capability.mcpTools],
    supportedSymbols: [...capability.supportedSymbols],
    knownCoverageGaps: [...capability.knownCoverageGaps],
  }));
}
