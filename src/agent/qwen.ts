import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { z } from "zod";
import type { RuntimeConfig } from "../types.js";
import { QWEN_DATA_BOUNDARY } from "./mandate.js";

export type QwenTelemetryFinalStatus = "SUCCESS" | "MALFORMED_RETRY" | "SCHEMA_ERROR" | "TIMEOUT" | "PROVIDER_ERROR" | "TRUNCATED" | "OTHER_ERROR";
export type QwenMalformedReason = "extraction" | "json_parse" | null;

export interface QwenAttemptTelemetry {
  attempt: number;
  durationMs: number;
  staticPromptChars: number;
  staticPromptBytes: number;
  dynamicPromptChars: number;
  dynamicPromptBytes: number;
  totalPromptChars: number;
  totalPromptBytes: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  finishReason?: string;
  outerMalformedRetry: boolean;
  malformedReason: QwenMalformedReason;
  sdkMaxRetries: 2;
  sdkInternalRetryAttempts: "UNOBSERVABLE";
  finalStatus: QwenTelemetryFinalStatus;
}

interface QwenRequestOptions {
  maxOutputTokens?: number;
  timeoutMs?: number;
  retryMalformedJson?: boolean;
  onAttemptTelemetry?: (telemetry: QwenAttemptTelemetry) => void;
}

export type QwenJsonErrorCode = "QWEN_OUTPUT_TRUNCATED" | "QWEN_INVALID_JSON";
export type QwenParserStage = "RESPONSE_JSON_EXTRACTION" | "JSON_PARSE";

export interface QwenOutputDiagnostic {
  finishReason: string;
  textLength: number;
  inputTokens?: number;
  outputTokens?: number;
  hasOpeningBrace: boolean;
  hasClosingBrace: boolean;
  parserStage?: QwenParserStage;
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
    ...(diagnostic.parserStage ? [`parserStage=${diagnostic.parserStage}`] : []),
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

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function emitAttemptTelemetry(
  callback: QwenRequestOptions["onAttemptTelemetry"],
  input: Omit<QwenAttemptTelemetry, "sdkMaxRetries" | "sdkInternalRetryAttempts">,
): void {
  if (!callback) return;
  try {
    callback({ ...input, sdkMaxRetries: 2, sdkInternalRetryAttempts: "UNOBSERVABLE" });
  } catch {
    // Observability must never affect generation or trading behavior.
  }
}

function statusForProviderError(error: unknown): QwenTelemetryFinalStatus {
  const name = error instanceof Error ? error.name : "";
  return name === "AbortError" || name === "TimeoutError" ? "TIMEOUT" : "PROVIDER_ERROR";
}

export async function generateQwenJson<T>(config: RuntimeConfig, schema: z.ZodType<T>, system: string, prompt: string, options: QwenRequestOptions = {}): Promise<T> {
  if (!config.qwenApiKey) throw new Error("QWEN_CREDENTIALS_REQUIRED");
  const provider = createOpenAICompatible({ name: "qwen", apiKey: config.qwenApiKey, baseURL: config.qwenBaseUrl });
  const schemaText = JSON.stringify(z.toJSONSchema(schema, { target: "draft-07", unrepresentable: "any" }));
  const systemPrompt = `${QWEN_DATA_BOUNDARY}\n${system}\nReturn valid JSON only. Match this JSON Schema: ${schemaText}`;
  const staticPromptChars = systemPrompt.length;
  const staticPromptBytes = utf8Bytes(systemPrompt);
  const maxAttempts = options.retryMalformedJson === true ? 2 : 1;
  let malformedReason: QwenMalformedReason = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const attemptPrompt = attempt === 0 ? prompt : `${prompt}\n\nPrevious response was not valid JSON. Return exactly one valid JSON object matching the schema, with no markdown or surrounding text.`;
    const dynamicPromptChars = attemptPrompt.length;
    const dynamicPromptBytes = utf8Bytes(attemptPrompt);
    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({ model: provider.chatModel(config.qwenModel), system: systemPrompt, prompt: attemptPrompt, maxOutputTokens: options.maxOutputTokens ?? 1600, temperature: 0, maxRetries: 2, providerOptions: { qwen: { enable_thinking: false } }, abortSignal: AbortSignal.timeout(options.timeoutMs ?? 45_000) });
    } catch (error) {
      emitAttemptTelemetry(options.onAttemptTelemetry, {
        attempt: attempt + 1,
        durationMs: Math.max(0, Date.now() - startedAt),
        staticPromptChars,
        staticPromptBytes,
        dynamicPromptChars,
        dynamicPromptBytes,
        totalPromptChars: staticPromptChars + dynamicPromptChars,
        totalPromptBytes: staticPromptBytes + dynamicPromptBytes,
        outerMalformedRetry: attempt > 0,
        malformedReason,
        finalStatus: statusForProviderError(error),
      });
      throw error;
    }

    const diagnostic = diagnosticFor(result, result.text);
    const usage = record(result.usage);
    const totalTokens = finiteNumber(usage.totalTokens);
    const telemetryTokens = {
      ...(diagnostic.inputTokens === undefined ? {} : { inputTokens: diagnostic.inputTokens }),
      ...(diagnostic.outputTokens === undefined ? {} : { outputTokens: diagnostic.outputTokens }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
    };
    const baseTelemetry = {
      attempt: attempt + 1,
      durationMs: Math.max(0, Date.now() - startedAt),
      staticPromptChars,
      staticPromptBytes,
      dynamicPromptChars,
      dynamicPromptBytes,
      totalPromptChars: staticPromptChars + dynamicPromptChars,
      totalPromptBytes: staticPromptBytes + dynamicPromptBytes,
      ...telemetryTokens,
      finishReason: diagnostic.finishReason,
      outerMalformedRetry: attempt > 0,
      malformedReason,
    };

    if (isTruncatedFinishReason(diagnostic.finishReason)) {
      emitAttemptTelemetry(options.onAttemptTelemetry, { ...baseTelemetry, finalStatus: "TRUNCATED" });
      throw new QwenJsonError("QWEN_OUTPUT_TRUNCATED", diagnostic);
    }

    let jsonText: string;
    try {
      jsonText = responseJson(result.text);
    } catch {
      const error = new QwenJsonError("QWEN_INVALID_JSON", { ...diagnostic, parserStage: "RESPONSE_JSON_EXTRACTION" });
      malformedReason = "extraction";
      const retrying = attempt + 1 < maxAttempts;
      emitAttemptTelemetry(options.onAttemptTelemetry, {
        ...baseTelemetry,
        outerMalformedRetry: retrying || attempt > 0,
        malformedReason,
        finalStatus: retrying ? "MALFORMED_RETRY" : "OTHER_ERROR",
      });
      if (retrying) continue;
      throw error;
    }

    try {
      const parsed = schema.parse(JSON.parse(jsonText));
      emitAttemptTelemetry(options.onAttemptTelemetry, {
        ...baseTelemetry,
        outerMalformedRetry: attempt > 0,
        malformedReason,
        finalStatus: "SUCCESS",
      });
      return parsed;
    } catch (error) {
      if (error instanceof z.ZodError) {
        emitAttemptTelemetry(options.onAttemptTelemetry, { ...baseTelemetry, finalStatus: "SCHEMA_ERROR" });
        throw error;
      }
      const jsonError = new QwenJsonError("QWEN_INVALID_JSON", { ...diagnostic, parserStage: "JSON_PARSE" });
      malformedReason = "json_parse";
      const retrying = attempt + 1 < maxAttempts;
      emitAttemptTelemetry(options.onAttemptTelemetry, {
        ...baseTelemetry,
        outerMalformedRetry: retrying || attempt > 0,
        malformedReason,
        finalStatus: retrying ? "MALFORMED_RETRY" : "OTHER_ERROR",
      });
      if (retrying) continue;
      throw jsonError;
    }
  }
  throw new Error("QWEN_INVALID_JSON");
}
