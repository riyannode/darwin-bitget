import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ResearchEvidence, ResearchRequest } from "../types.js";
import { BITGET_SIGNAL_MCP_ENDPOINT, BITGET_SIGNAL_RECIPE_VERSION } from "./capabilities.js";
import {
  MAX_MCP_TOOL_CALLS_PER_CYCLE,
  MAX_RESEARCH_REQUESTS_PER_CYCLE,
  MAX_NORMALIZED_RESEARCH_BYTES_PER_CYCLE,
  MAX_NORMALIZED_RESEARCH_BYTES_PER_ITEM,
  RESEARCH_CACHE_TTL_MS,
  RESEARCH_CONCURRENCY,
  RESEARCH_PHASE_TIMEOUT_MS,
  RESEARCH_TOOL_TIMEOUT_MS,
} from "./router.js";

export interface McpResearchClient {
  callTool(name: string, argumentsValue: Record<string, unknown>): Promise<unknown>;
  close?(): Promise<void>;
}

export interface McpResearchClientFactory {
  connect(): Promise<McpResearchClient>;
}

interface CachedEvidence {
  cachedAt: number;
  evidence: ResearchEvidence;
}

const MAX_RESEARCH_CACHE_ENTRIES = 32;
const MAX_RAW_MCP_TEXT_BYTES = 64 * 1024;

function timeoutFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(RESEARCH_TOOL_TIMEOUT_MS);
  const signals = [timeoutSignal, init.signal].filter((signal): signal is AbortSignal => Boolean(signal));
  const requestInit = { ...init };
  delete requestInit.signal;
  return fetch(input, signals.length > 0 ? { ...requestInit, signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } as RequestInit : requestInit as RequestInit);
}

export const defaultMcpResearchClientFactory: McpResearchClientFactory = {
  async connect(): Promise<McpResearchClient> {
    const client = new Client({ name: "darwin-bitget-signal", version: "0.1.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(BITGET_SIGNAL_MCP_ENDPOINT), {
      fetch: timeoutFetch,
      reconnectionOptions: { maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
    });
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    return {
      callTool: (name, argumentsValue) => client.callTool({ name, arguments: argumentsValue }),
      close: () => transport.close().catch(() => undefined),
    };
  },
};

function boundedText(value: unknown, limit = 240): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function boundedRawText(value: string): { text: string; oversized: boolean } {
  if (new TextEncoder().encode(value).byteLength <= MAX_RAW_MCP_TEXT_BYTES) return { text: value, oversized: false };
  return { text: value.slice(0, MAX_RAW_MCP_TEXT_BYTES), oversized: true };
}

function resultText(raw: unknown): { text: string; oversized: boolean; structuredContent?: unknown } {
  if (typeof raw === "string") return boundedRawText(raw);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    if (typeof value.structuredContent === "object" && value.structuredContent !== null) return { text: "", oversized: false, structuredContent: value.structuredContent };
    if (Array.isArray(value.content)) {
      let text = "";
      for (const item of value.content) {
        if (!item || typeof item !== "object" || (item as Record<string, unknown>).type !== "text") continue;
        const next = `${text}${text ? "\n" : ""}${String((item as Record<string, unknown>).text ?? "")}`;
        const bounded = boundedRawText(next);
        text = bounded.text;
        if (bounded.oversized) return { text, oversized: true };
      }
      return { text, oversized: false };
    }
  }
  return { text: "", oversized: false, structuredContent: raw };
}

function collectFacts(value: unknown, path: string, facts: string[], limitations: string[], depth = 0): void {
  if (facts.length >= 5 || value === null || value === undefined || depth > 4) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = boundedText(value, 180);
    if (!text) return;
    if (path.toLowerCase().includes("error")) {
      limitations.push(text);
      return;
    }
    facts.push(`${path}=${text}`);
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 5).forEach((item, index) => collectFacts(item, `${path}[${index}]`, facts, limitations, depth + 1));
    return;
  }
  if (typeof value === "object") {
    Object.entries(value as Record<string, unknown>).slice(0, 20).forEach(([key, item]) => collectFacts(item, path ? `${path}.${key}` : key, facts, limitations, depth + 1));
  }
}

function evidenceBytes(evidence: ResearchEvidence): number {
  return new TextEncoder().encode(JSON.stringify(evidence)).byteLength;
}

function technicalFacts(value: unknown, facts: string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const add = (label: string, candidate: unknown): void => {
    if (candidate === undefined || candidate === null || facts.length >= 5) return;
    const candidateText = typeof candidate === "object" ? JSON.stringify(candidate) : String(candidate);
    const text = boundedText(candidateText, 220);
    if (text) facts.push(`${label}=${text}`);
  };
  add("technical.verdict", record.verdict);
  const rsi = record.rsi && typeof record.rsi === "object" ? record.rsi as Record<string, unknown> : undefined;
  if (rsi) add("technical.rsi", `value=${String(rsi.rsi ?? "")}, signal=${String(rsi.signal ?? "")}`);
  const macd = record.macd && typeof record.macd === "object" ? record.macd as Record<string, unknown> : undefined;
  if (macd) add("technical.macd", `histogram=${String(macd.histogram ?? "")}, cross=${String(macd.cross ?? "")}`);
  add("technical.supportResistance", record.support_resistance);
  add("technical.bullSignals", record.bull_signals);
  add("technical.bearSignals", record.bear_signals);
  return facts.length > 0;
}

export function normalizeResearchEvidence(skill: ResearchRequest["skill"], scope: string, raw: unknown, observedAt: string): ResearchEvidence {
  const base: ResearchEvidence = { skill, scope, observedAt, status: "AVAILABLE", facts: [], limitations: [] };
  const rawRecord = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const result = resultText(raw);
  let parsed: unknown = result.structuredContent ?? raw;
  if (result.oversized) {
    base.status = "UNAVAILABLE";
    base.limitations.push("MCP payload exceeded the raw normalization byte limit.");
  } else if (result.text) {
    try { parsed = JSON.parse(result.text); } catch { parsed = result.text; }
  }
  if (rawRecord?.isError === true) {
    base.status = "UNAVAILABLE";
    base.limitations.push("MCP tool returned an error result.");
  } else if (base.status === "AVAILABLE") {
    if (skill === "technical-analysis" && !technicalFacts(parsed, base.facts)) collectFacts(parsed, "research", base.facts, base.limitations);
    else if (skill !== "technical-analysis") collectFacts(parsed, "research", base.facts, base.limitations);
    if (base.limitations.length > 0 && base.facts.length === 0) base.status = "UNAVAILABLE";
    if (base.facts.length === 0 && base.status === "AVAILABLE") {
      base.status = "UNAVAILABLE";
      base.limitations.push("MCP tool returned no bounded facts.");
    }
  }
  return boundEvidence({ ...base, facts: base.facts.slice(0, 5), limitations: base.limitations.slice(0, 3) });
}

export function unavailableResearchEvidence(request: ResearchRequest, status: ResearchEvidence["status"], limitation: string, observedAt: string): ResearchEvidence {
  return boundEvidence({ skill: request.skill, scope: request.symbol ?? "GLOBAL", observedAt, status, facts: [], limitations: [boundedText(limitation)] });
}

function boundEvidence(evidence: ResearchEvidence): ResearchEvidence {
  const facts = [...evidence.facts].map((fact) => boundedText(fact, 240)).filter(Boolean).slice(0, 5);
  const limitations = [...evidence.limitations].map((limitation) => boundedText(limitation, 240)).filter(Boolean).slice(0, 3);
  let bounded: ResearchEvidence = { ...evidence, facts, limitations };
  while (evidenceBytes(bounded) > MAX_NORMALIZED_RESEARCH_BYTES_PER_ITEM && bounded.facts.length > 0) bounded = { ...bounded, facts: bounded.facts.slice(0, -1) };
  while (evidenceBytes(bounded) > MAX_NORMALIZED_RESEARCH_BYTES_PER_ITEM && bounded.limitations.length > 0) bounded = { ...bounded, limitations: bounded.limitations.slice(0, -1) };
  if (evidenceBytes(bounded) > MAX_NORMALIZED_RESEARCH_BYTES_PER_ITEM) bounded = { ...bounded, facts: [], limitations: ["Normalized research exceeded the item byte limit."] };
  return bounded;
}

function enforceCycleBudget(evidence: ResearchEvidence[]): ResearchEvidence[] {
  const output: ResearchEvidence[] = [];
  let used = 0;
  for (const item of evidence) {
    const bounded = boundEvidence(item);
    if (used + evidenceBytes(bounded) <= MAX_NORMALIZED_RESEARCH_BYTES_PER_CYCLE) {
      output.push(bounded);
      used += evidenceBytes(bounded);
    } else {
      const unavailable = unavailableResearchEvidence({ skill: bounded.skill, symbol: bounded.scope === "GLOBAL" ? null : bounded.scope, purpose: "" }, "UNAVAILABLE", "Cycle research evidence budget exceeded.", bounded.observedAt);
      if (used + evidenceBytes(unavailable) <= MAX_NORMALIZED_RESEARCH_BYTES_PER_CYCLE) {
        output.push(unavailable);
        used += evidenceBytes(unavailable);
      }
    }
  }
  return output;
}

function recipe(request: ResearchRequest): { tool: string; argumentsValue: Record<string, unknown> } {
  if (request.skill === "technical-analysis" && request.symbol) {
    return { tool: "technical_analysis", argumentsValue: { action: "full_analysis", symbol: `${request.symbol.replace(/USDT$/, "")}/USDT`, timeframe: "4h" } };
  }
  throw new Error("UNSUPPORTED_RESEARCH_RECIPE");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(code)), timeoutMs)),
  ]);
}

export type ResearchExecutionTelemetryEvent =
  | { type: "CACHE_HIT"; skill: string; symbol: string }
  | { type: "MCP_CONNECT_ATTEMPT" }
  | { type: "MCP_CONNECT_SUCCESS" }
  | { type: "MCP_CONNECT_FAILED"; code: string }
  | { type: "MCP_TOOL_ATTEMPT"; skill: string; symbol: string; tool: string }
  | { type: "MCP_TOOL_RESULT"; skill: string; symbol: string; status: string }
  | { type: "MCP_TOOL_FAILED"; skill: string; symbol: string; code: string };

export type ResearchExecutionTelemetryCallback = (event: ResearchExecutionTelemetryEvent) => void;

export interface ResearchExecutorOptions {
  telemetry?: ResearchExecutionTelemetryCallback;
  cache?: Map<string, CachedEvidence>;
}

export class ResearchExecutor {
  private readonly cache: Map<string, CachedEvidence>;
  private readonly options: ResearchExecutorOptions;

  public constructor(
    private readonly factory: McpResearchClientFactory = defaultMcpResearchClientFactory,
    options: ResearchExecutorOptions = {},
  ) {
    this.cache = options.cache ?? new Map<string, CachedEvidence>();
    this.options = options;
  }

  public cacheSize(): number { return this.cache.size; }

  private pruneCache(nowMs: number): void {
    for (const [key, cached] of this.cache) {
      if (nowMs - cached.cachedAt > RESEARCH_CACHE_TTL_MS) this.cache.delete(key);
    }
    while (this.cache.size >= MAX_RESEARCH_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private cacheEvidence(key: string, evidence: ResearchEvidence, cachedAt: number): void {
    if (evidence.status !== "AVAILABLE" && evidence.status !== "STALE") return;
    this.pruneCache(cachedAt);
    this.cache.set(key, { cachedAt, evidence });
  }

  public async execute(requests: readonly ResearchRequest[], now = new Date()): Promise<ResearchEvidence[]> {
    const phaseStartedAt = Date.now();
    this.pruneCache(now.getTime());
    const boundedRequests = requests.slice(0, Math.min(MAX_RESEARCH_REQUESTS_PER_CYCLE, MAX_MCP_TOOL_CALLS_PER_CYCLE));
    const results: Array<ResearchEvidence | undefined> = Array.from({ length: boundedRequests.length });
    const pending: Array<{ index: number; request: ResearchRequest; key: string }> = [];
    for (const [index, request] of boundedRequests.entries()) {
      const key = `${request.skill}:${request.symbol ?? "GLOBAL"}:${BITGET_SIGNAL_RECIPE_VERSION}`;
      const cached = this.cache.get(key);
      if (cached && now.getTime() - cached.cachedAt <= RESEARCH_CACHE_TTL_MS) {
        results[index] = cached.evidence;
        this.safeEmit({ type: "CACHE_HIT", skill: request.skill, symbol: request.symbol ?? "GLOBAL" });
      }
      else pending.push({ index, request, key });
    }
    if (pending.length === 0) return enforceCycleBudget(results.filter((item): item is ResearchEvidence => Boolean(item)));

    let client: McpResearchClient | undefined;
    try {
      const remainingForConnection = Math.max(1, RESEARCH_PHASE_TIMEOUT_MS - (Date.now() - phaseStartedAt));
      this.safeEmit({ type: "MCP_CONNECT_ATTEMPT" });
      try {
        client = await withTimeout(this.factory.connect(), Math.min(RESEARCH_TOOL_TIMEOUT_MS, remainingForConnection), "RESEARCH_CONNECTION_TIMEOUT");
        this.safeEmit({ type: "MCP_CONNECT_SUCCESS" });
      } catch (connectError) {
        this.safeEmit({ type: "MCP_CONNECT_FAILED", code: connectError instanceof Error ? connectError.message.split(":")[0] ?? "CONNECT_ERROR" : "CONNECT_ERROR" });
        throw connectError;
      }
      let next = 0;
      let toolCallCount = 0;
      const worker = async (): Promise<void> => {
        while (next < pending.length) {
          const current = pending[next++];
          if (!current) return;
          const observedAt = new Date().toISOString();
          try {
            const prepared = recipe(current.request);
            if (toolCallCount >= MAX_MCP_TOOL_CALLS_PER_CYCLE) throw new Error("MAX_MCP_TOOL_CALLS_PER_CYCLE");
            toolCallCount += 1;
            this.safeEmit({ type: "MCP_TOOL_ATTEMPT", skill: current.request.skill, symbol: current.request.symbol ?? "GLOBAL", tool: prepared.tool });
            const remainingMs = Math.max(1, RESEARCH_PHASE_TIMEOUT_MS - (Date.now() - phaseStartedAt));
            const raw = await Promise.race([
              client!.callTool(prepared.tool, prepared.argumentsValue),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("RESEARCH_PHASE_TIMEOUT")), Math.min(RESEARCH_TOOL_TIMEOUT_MS, remainingMs))),
            ]);
            const evidence = normalizeResearchEvidence(current.request.skill, current.request.symbol ?? "GLOBAL", raw, observedAt);
            this.safeEmit({ type: "MCP_TOOL_RESULT", skill: current.request.skill, symbol: current.request.symbol ?? "GLOBAL", status: evidence.status });
            results[current.index] = evidence;
            this.cacheEvidence(current.key, evidence, now.getTime());
          } catch (error) {
            const code = error instanceof Error ? error.message.split(":")[0] ?? "TOOL_ERROR" : "TOOL_ERROR";
            this.safeEmit({ type: "MCP_TOOL_FAILED", skill: current.request.skill, symbol: current.request.symbol ?? "GLOBAL", code });
            const evidence = unavailableResearchEvidence(current.request, "UNAVAILABLE", error instanceof Error ? error.message : "Research tool unavailable.", observedAt);
            results[current.index] = evidence;
            this.cacheEvidence(current.key, evidence, now.getTime());
          }
        }
      };
      await Promise.race([
        Promise.all(Array.from({ length: Math.min(RESEARCH_CONCURRENCY, pending.length) }, () => worker())),
        new Promise<void>((resolve) => setTimeout(resolve, RESEARCH_PHASE_TIMEOUT_MS)),
      ]);
    } catch {
      for (const item of pending) if (!results[item.index]) results[item.index] = unavailableResearchEvidence(item.request, "UNAVAILABLE", "MCP connection unavailable.", new Date().toISOString());
    } finally {
      if (client?.close) await withTimeout(client.close(), 250, "RESEARCH_CLOSE_TIMEOUT").catch(() => undefined);
    }
    return enforceCycleBudget(results.map((item, index) => item ?? unavailableResearchEvidence(boundedRequests[index]!, "UNAVAILABLE", "Research result unavailable.", new Date().toISOString())));
  }

  public async executeWithTelemetry(
    requests: readonly ResearchRequest[],
    telemetry: ResearchExecutionTelemetryCallback | undefined,
    now = new Date(),
  ): Promise<ResearchEvidence[]> {
    if (!telemetry) return this.execute(requests, now);
    const executor = new ResearchExecutor(this.factory, { telemetry, cache: this.cache });
    return executor.execute(requests, now);
  }

  private safeEmit(event: ResearchExecutionTelemetryEvent): void {
    if (!this.options.telemetry) return;
    try {
      this.options.telemetry(event);
    } catch {
      // Telemetry callback failure must never break research execution
    }
  }
}
