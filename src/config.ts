import type { Env, OwnerPolicy, RuntimeConfig } from "./types.js";
import { loadOwnerPolicy } from "./trading/policy.js";

function required(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(required(value, String(fallback)));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("INVALID_CONFIG");
  }
  return parsed;
}

function validateCredentials(env: Omit<Env, "TRADER_AGENT">): void {
  const values = [env.BITGET_API_KEY, env.BITGET_SECRET_KEY, env.BITGET_PASSPHRASE];
  const present = values.filter((value) => Boolean(value?.trim())).length;
  if (present !== 0 && present !== values.length) {
    throw new Error("PARTIAL_BITGET_CREDENTIALS");
  }
}

export function loadConfig(env: Omit<Env, "TRADER_AGENT">, activePolicy?: OwnerPolicy): RuntimeConfig {
  if (env.TRADING_MODE !== "PAPER" || env.PAPER_ONLY !== "true") {
    throw new Error("PAPER_ONLY");
  }
  if (env.AGENT_MODE !== "AUTONOMOUS" && env.AGENT_MODE !== "EVA_EVALUATION") {
    throw new Error("INVALID_AGENT_MODE");
  }
  validateCredentials(env);
  const ownerPolicy = activePolicy ?? loadOwnerPolicy(env);
  const agentMode = env.AGENT_MODE;
  const credentials = {
    ...(env.BITGET_API_KEY?.trim() ? { bitgetApiKey: env.BITGET_API_KEY.trim() } : {}),
    ...(env.BITGET_SECRET_KEY?.trim() ? { bitgetSecretKey: env.BITGET_SECRET_KEY.trim() } : {}),
    ...(env.BITGET_PASSPHRASE?.trim() ? { bitgetPassphrase: env.BITGET_PASSPHRASE.trim() } : {}),
    ...(env.QWEN_API_KEY?.trim() ? { qwenApiKey: env.QWEN_API_KEY.trim() } : {}),
  };
  return {
    tradingMode: "PAPER",
    agentMode,
    ownerPolicy,
    evidenceMaxAgeSeconds: positiveInteger(env.EVIDENCE_MAX_AGE_SECONDS, 90),
    bitgetCategory: required(env.BITGET_CATEGORY, "USDT-FUTURES").toUpperCase(),
    bitgetApiBaseUrl: required(env.BITGET_API_BASE_URL, "https://api.bitget.com"),
    qwenBaseUrl: required(env.QWEN_BASE_URL, "https://hackathon.bitgetops.com/v1"),
    qwenModel: required(env.QWEN_MODEL, "qwen3.8-max"),
    version: required(env.APP_VERSION, "0.2.0"),
    commit: required(env.GIT_COMMIT_SHA, "local"),
    environment: required(env.ENVIRONMENT, "production"),
    ...credentials,
  };
}
