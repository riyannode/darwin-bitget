import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { z } from "zod";
import type { RuntimeConfig } from "../types.js";
import { QWEN_DATA_BOUNDARY } from "./mandate.js";

interface QwenRequestOptions {
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export type QwenJsonErrorCode = "QWEN_OUTPUT_TRUNCATED" | "QWEN_INVALID_JSON";

export interface QwenOutputDiagnostic {
  finishReason: string;
  textLength: number;
  inputTokens?: number;
  outputTokens?: number;
  hasOpeningBrace: boolean;
  hasClosingBrace: boolean;
}

export class QwenJsonError extends Error {
  public readonly code: QwenJsonErrorCode;
  public readonly diagnostic: QwenOutputDiagnostic;

  public constructor(code: QwenJsonErrorCode, diagnostic: QwenOutputDiagnostic) {
    super(`${code}: ${formatDiagnostic(diagnostic)}`);
    this.name = "QwenJsonError";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function diagnosticFor(result: unknown, text: string): QwenOutputDiagnostic {
  const source = record(result);
  const usage = record(source.usage);
  const inputTokens = finiteNumber(usage.inputTokens ?? usage.promptTokens);
  const outputTokens = finiteNumber(usage.outputTokens ?? usage.completionTokens);
  return {
    finishReason: safeFinishReason(source.finishReason),
    textLength: text.length,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    hasOpeningBrace: text.includes("{"),
    hasClosingBrace: text.includes("}"),
  };
}

function safeFinishReason(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{1,40}$/.test(text) ? text : "UNKNOWN";
}

function formatDiagnostic(diagnostic: QwenOutputDiagnostic): string {
  return [
    `finishReason=${diagnostic.finishReason}`,
    `textLength=${diagnostic.textLength}`,
    `inputTokens=${diagnostic.inputTokens === undefined ? "UNKNOWN" : diagnostic.inputTokens}`,
    `outputTokens=${diagnostic.outputTokens === undefined ? "UNKNOWN" : diagnostic.outputTokens}`,
    `hasOpeningBrace=${diagnostic.hasOpeningBrace}`,
    `hasClosingBrace=${diagnostic.hasClosingBrace}`,
  ].join(" ");
}

function isTruncatedFinishReason(value: string): boolean {
  return ["length", "max_tokens", "max_output_tokens"].includes(value.toLowerCase());
}

function responseJson(text: string): string {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("QWEN_INVALID_JSON");
  return normalized.slice(start, end + 1);
}

export async function generateQwenJson<T>(config: RuntimeConfig, schema: z.ZodType<T>, system: string, prompt: string, options: QwenRequestOptions = {}): Promise<T> {
  if (!config.qwenApiKey) throw new Error("QWEN_CREDENTIALS_REQUIRED");
  const provider = createOpenAICompatible({ name: "qwen", apiKey: config.qwenApiKey, baseURL: config.qwenBaseUrl });
  const schemaText = JSON.stringify(z.toJSONSchema(schema, { target: "draft-07", unrepresentable: "any" }));
  const result = await generateText({ model: provider.chatModel(config.qwenModel), system: `${QWEN_DATA_BOUNDARY}\n${system}\nReturn valid JSON only. Match this JSON Schema: ${schemaText}`, prompt, maxOutputTokens: options.maxOutputTokens ?? 1600, temperature: 0, providerOptions: { qwen: { enable_thinking: false } }, abortSignal: AbortSignal.timeout(options.timeoutMs ?? 45_000) });
  const diagnostic = diagnosticFor(result, result.text);
  if (isTruncatedFinishReason(diagnostic.finishReason)) throw new QwenJsonError("QWEN_OUTPUT_TRUNCATED", diagnostic);
  try {
    return schema.parse(JSON.parse(responseJson(result.text)));
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new QwenJsonError("QWEN_INVALID_JSON", diagnostic);
  }
}
