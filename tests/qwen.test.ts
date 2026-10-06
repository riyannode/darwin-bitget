import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { generateQwenJson, QwenJsonError } from "../src/agent/qwen.js";
import { DECISION_MAX_OUTPUT_TOKENS, decide } from "../src/agent/decision.js";
import type { DecisionContext, RuntimeConfig } from "../src/types.js";

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => ({ chatModel: vi.fn(() => "qwen-test-model") })),
}));
vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

const mockedGenerateText = vi.mocked(generateText);
const mockedCreateOpenAICompatible = vi.mocked(createOpenAICompatible);
const schema = z.object({ value: z.string() });
const config: RuntimeConfig = {
  tradingMode: "PAPER",
  agentMode: "AUTONOMOUS",
  ownerPolicy: { paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 5, emergencyStop: false },
  evidenceMaxAgeSeconds: 90,
  bitgetCategory: "USDT-FUTURES",
  bitgetApiBaseUrl: "https://api.bitget.com",
  qwenApiKey: "test-key",
  qwenBaseUrl: "https://qwen.test/v1",
  qwenModel: "qwen-test",
};

function result(text: string, finishReason = "stop", usage: { inputTokens: number; outputTokens: number; totalTokens?: number } = { inputTokens: 12, outputTokens: 8 }) {
  return { text, finishReason, usage };
}

function emptyDecisionContext(): DecisionContext {
  return {
    bundles: [],
    supportedUniverse: ["NVDAUSDT", "COINUSDT"],
    openPositionSymbols: [],
    entryCandidateSymbols: [],
    experiences: [],
    openExperiences: [],
    lessons: [],
    observedAt: "2026-10-06T00:00:00.000Z",
    mandate: "private decision mandate",
    openPositions: [],
  };
}

beforeEach(() => {
  mockedGenerateText.mockReset();
  mockedCreateOpenAICompatible.mockClear();
});

describe("bounded Qwen JSON handling", () => {
  it("parses valid plain JSON", async () => {
    mockedGenerateText.mockResolvedValue(result('{"value":"ok"}') as never);
    await expect(generateQwenJson(config, schema, "system", "prompt")).resolves.toEqual({ value: "ok" });
  });

  it("parses valid fenced JSON", async () => {
    mockedGenerateText.mockResolvedValue(result("```json\n{\"value\":\"ok\"}\n```") as never);
    await expect(generateQwenJson(config, schema, "system", "prompt")).resolves.toEqual({ value: "ok" });
  });

  it("classifies completed malformed JSON as QWEN_INVALID_JSON", async () => {
    mockedGenerateText.mockResolvedValue(result('{"value":}') as never);
    await expect(generateQwenJson(config, schema, "system", "prompt")).rejects.toMatchObject({ code: "QWEN_INVALID_JSON", diagnostic: { parserStage: "JSON_PARSE" } });
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
  });

  it("retries malformed JSON once and succeeds on the second model call", async () => {
    mockedGenerateText
      .mockResolvedValueOnce(result('{"value":}') as never)
      .mockResolvedValueOnce(result('{"value":"recovered"}') as never);
    await expect(generateQwenJson(config, schema, "system", "prompt", { retryMalformedJson: true })).resolves.toEqual({ value: "recovered" });
    expect(mockedGenerateText).toHaveBeenCalledTimes(2);
    expect(mockedGenerateText.mock.calls[1]?.[0]?.prompt).toContain("Previous response was not valid JSON");
  });

  it("fails after exactly two malformed JSON attempts", async () => {
    const telemetry: Array<Record<string, unknown>> = [];
    mockedGenerateText
      .mockResolvedValueOnce(result('{"value":}') as never)
      .mockResolvedValueOnce(result('{"value":}') as never);
    await expect(generateQwenJson(config, schema, "system", "prompt", {
      retryMalformedJson: true,
      onAttemptTelemetry: (event) => telemetry.push(event as unknown as Record<string, unknown>),
    })).rejects.toMatchObject({ code: "QWEN_INVALID_JSON", diagnostic: { parserStage: "JSON_PARSE" } });
    expect(mockedGenerateText).toHaveBeenCalledTimes(2);
    expect(telemetry).toHaveLength(2);
    expect(telemetry[1]).toMatchObject({ attempt: 2, outerMalformedRetry: true, malformedReason: "json_parse", finalStatus: "MALFORMED_RETRY" });
  });

  it("reports response JSON extraction failures separately", async () => {
    mockedGenerateText.mockResolvedValue(result("not json") as never);
    await expect(generateQwenJson(config, schema, "system", "prompt")).rejects.toMatchObject({ code: "QWEN_INVALID_JSON", diagnostic: { parserStage: "RESPONSE_JSON_EXTRACTION" } });
  });

  it("classifies length-finished output as QWEN_OUTPUT_TRUNCATED", async () => {
    mockedGenerateText.mockResolvedValue(result('{"value":"partial"', "length") as never);
    await expect(generateQwenJson(config, schema, "system", "prompt")).rejects.toMatchObject({ code: "QWEN_OUTPUT_TRUNCATED" });
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
  });

  it("keeps raw model output out of bounded diagnostics", async () => {
    const raw = "model-private-output-DO-NOT-PERSIST";
    mockedGenerateText.mockResolvedValue(result(raw) as never);
    const error = await generateQwenJson(config, schema, "system", "prompt").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(QwenJsonError);
    expect((error as Error).message).not.toContain(raw);
    expect(JSON.stringify(error)).not.toContain(raw);
  });

  it("preserves Zod validation errors", async () => {
    mockedGenerateText.mockResolvedValue(result('{"value":123}') as never);
    await expect(generateQwenJson(config, schema, "system", "prompt")).rejects.toMatchObject({ name: "ZodError" });
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
  });

  it("records non-sensitive per-call telemetry when malformed JSON is retried", async () => {
    const telemetry: Array<Record<string, unknown>> = [];
    mockedGenerateText
      .mockResolvedValueOnce(result('{"value":}') as never)
      .mockResolvedValueOnce(result('{"value":"recovered"}') as never);
    await expect(generateQwenJson(config, schema, "private system", "private user prompt", {
      retryMalformedJson: true,
      onAttemptTelemetry: (event) => telemetry.push(event as unknown as Record<string, unknown>),
    })).resolves.toEqual({ value: "recovered" });
    expect(telemetry).toHaveLength(2);
    expect(telemetry[0]).toMatchObject({ attempt: 1, outerMalformedRetry: true, malformedReason: "json_parse", finalStatus: "MALFORMED_RETRY", sdkMaxRetries: 2, sdkInternalRetryAttempts: "UNOBSERVABLE" });
    expect(telemetry[1]).toMatchObject({ attempt: 2, outerMalformedRetry: true, malformedReason: "json_parse", finalStatus: "SUCCESS" });
    expect(telemetry[0]?.dynamicPromptChars).toBe("private user prompt".length);
    expect(telemetry[0]?.inputTokens).toBe(12);
    expect(telemetry[0]?.outputTokens).toBe(8);
    expect(telemetry[0]).toHaveProperty("durationMs");
    expect(telemetry[0]).toHaveProperty("finishReason", "stop");
    const serializedTelemetry = JSON.stringify(telemetry);
    expect(serializedTelemetry).not.toContain("private system");
    expect(serializedTelemetry).not.toContain("private user prompt");
    expect(serializedTelemetry).not.toContain("recovered");
  });

  it("does not let telemetry callback failures affect Qwen generation", async () => {
    mockedGenerateText.mockResolvedValue(result('{"value":"ok"}') as never);
    await expect(generateQwenJson(config, schema, "system", "prompt", {
      onAttemptTelemetry: () => { throw new Error("logging unavailable"); },
    })).resolves.toEqual({ value: "ok" });
  });

  it("reports schema validation errors without retrying", async () => {
    const telemetry: Array<Record<string, unknown>> = [];
    mockedGenerateText.mockResolvedValue(result('{"value":123}') as never);
    await expect(generateQwenJson(config, schema, "system", "prompt", {
      retryMalformedJson: true,
      onAttemptTelemetry: (event) => telemetry.push(event as unknown as Record<string, unknown>),
    })).rejects.toMatchObject({ name: "ZodError" });
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({ finalStatus: "SCHEMA_ERROR", outerMalformedRetry: false, malformedReason: null });
  });

  it("reports truncation without retrying", async () => {
    const telemetry: Array<Record<string, unknown>> = [];
    mockedGenerateText.mockResolvedValue(result('{"value":"partial"', "length") as never);
    await expect(generateQwenJson(config, schema, "system", "prompt", {
      retryMalformedJson: true,
      onAttemptTelemetry: (event) => telemetry.push(event as unknown as Record<string, unknown>),
    })).rejects.toMatchObject({ code: "QWEN_OUTPUT_TRUNCATED" });
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
    expect(telemetry[0]).toMatchObject({ finalStatus: "TRUNCATED", outerMalformedRetry: false, malformedReason: null });
  });

  it("logs only non-sensitive final-decision telemetry", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockedGenerateText.mockResolvedValue(result('{"positionActions":[],"entryActions":[]}', "stop", { inputTokens: 18, outputTokens: 9, totalTokens: 27 }) as never);
    await expect(decide(config, emptyDecisionContext(), "cycle-telemetry")).resolves.toMatchObject({ plan: { positionActions: [], entryActions: [] } });
    expect(log).toHaveBeenCalledTimes(1);
    const event = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(event).toMatchObject({
      event: "FINAL_DECISION_QWEN_TELEMETRY",
      cycleId: "cycle-telemetry",
      model: "qwen-test",
      attempt: 1,
      supportedUniverseCount: 2,
      openPositionCount: 0,
      entryCandidateCount: 0,
      deepEvidenceCount: 0,
      experienceCount: 0,
      openExperienceCount: 0,
      lessonCount: 0,
      researchEvidenceCount: 0,
      inputTokens: 18,
      outputTokens: 9,
      totalTokens: 27,
      finishReason: "stop",
      finalStatus: "SUCCESS",
      sdkInternalRetryAttempts: "UNOBSERVABLE",
    });
    expect(event).toHaveProperty("staticPromptBytes");
    expect(event).toHaveProperty("dynamicPromptBytes");
    expect(event).toHaveProperty("totalPromptChars");
    expect(event).toHaveProperty("totalPromptBytes");
    expect(JSON.stringify(event)).not.toContain("private decision mandate");
    log.mockRestore();
  });

  it("keeps decision generation successful when structured logging throws", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => { throw new Error("log unavailable"); });
    mockedGenerateText.mockResolvedValue(result('{"positionActions":[],"entryActions":[]}') as never);
    await expect(decide(config, emptyDecisionContext(), "cycle-log-failure")).resolves.toMatchObject({ plan: { positionActions: [], entryActions: [] } });
    log.mockRestore();
  });

  it("passes the configured generic token budget to generateText", async () => {
    mockedGenerateText.mockResolvedValue(result('{"value":"ok"}') as never);
    await generateQwenJson(config, schema, "system", "prompt", { maxOutputTokens: 3200, timeoutMs: 60_000 });
    expect(mockedGenerateText.mock.calls[0]?.[0]).toMatchObject({ maxOutputTokens: 3200, maxRetries: 2 });
  });
});

describe("Qwen call budgets", () => {
  it("keeps the final decision output budget configured", () => {
    expect(DECISION_MAX_OUTPUT_TOKENS).toBe(3200);
  });
});
