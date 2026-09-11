import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { z } from "zod";
import type { RuntimeConfig } from "../types.js";
import { QWEN_DATA_BOUNDARY } from "./mandate.js";

interface QwenRequestOptions {
  maxOutputTokens?: number;
  timeoutMs?: number;
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
  try {
    return schema.parse(JSON.parse(responseJson(result.text)));
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new Error("QWEN_INVALID_JSON");
  }
}
