import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { generateQwenJson, QwenJsonError } from "../src/agent/qwen.js";
import { CANDIDATE_MAX_OUTPUT_TOKENS, DECISION_MAX_OUTPUT_TOKENS } from "../src/agent/decision.js";
import type { RuntimeConfig } from "../src/types.js";

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

function result(text: string, finishReason = "stop", usage = { inputTokens: 12, outputTokens: 8 }) {
  return { text, finishReason, usage };
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
    await expect(generateQwenJson(config, schema, "system", "prompt")).rejects.toMatchObject({ code: "QWEN_INVALID_JSON" });
  });

  it("classifies length-finished output as QWEN_OUTPUT_TRUNCATED", async () => {
    mockedGenerateText.mockResolvedValue(result('{"value":"partial"', "length") as never);
    await expect(generateQwenJson(config, schema, "system", "prompt")).rejects.toMatchObject({ code: "QWEN_OUTPUT_TRUNCATED" });
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
  });

  it("passes the configured generic token budget to generateText", async () => {
    mockedGenerateText.mockResolvedValue(result('{"value":"ok"}') as never);
    await generateQwenJson(config, schema, "system", "prompt", { maxOutputTokens: 3200, timeoutMs: 60_000 });
    expect(mockedGenerateText.mock.calls[0]?.[0]).toMatchObject({ maxOutputTokens: 3200 });
  });
});

describe("Qwen call budgets", () => {
  it("keeps decision and candidate budgets distinct", () => {
    expect(DECISION_MAX_OUTPUT_TOKENS).toBe(3200);
    expect(CANDIDATE_MAX_OUTPUT_TOKENS).toBe(700);
  });
});
