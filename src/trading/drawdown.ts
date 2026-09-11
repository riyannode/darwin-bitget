import type { OwnerPolicy } from "../types.js";
import { z } from "zod";

export interface DailyDrawdownState {
  date: string;
  baselineEquity: string;
  lastEquity: string;
  cooldownUntil?: string;
}

export interface DrawdownDecision {
  blocked: boolean;
  code: "DAILY_DRAWDOWN" | "DRAWDOWN_COOLDOWN" | "NONE";
  state: DailyDrawdownState;
}

const drawdownStateSchema = z.object({
  date: z.string().min(1),
  baselineEquity: z.string().min(1),
  lastEquity: z.string().min(1),
  cooldownUntil: z.string().min(1).optional(),
});

function scaled(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(value.trim());
  if (!match?.[1]) throw new Error("INVALID_DECIMAL");
  return BigInt(match[1] + (match[2] ?? "").padEnd(8, "0"));
}

export function parseDailyDrawdownState(value: unknown): DailyDrawdownState {
  const record = drawdownStateSchema.parse(value);
  return {
    date: record.date,
    baselineEquity: record.baselineEquity,
    lastEquity: record.lastEquity,
    ...(record.cooldownUntil ? { cooldownUntil: record.cooldownUntil } : {}),
  };
}

export function evaluateDrawdown(
  policy: OwnerPolicy,
  existing: DailyDrawdownState | undefined,
  currentEquity: string,
  now: Date,
): DrawdownDecision {
  const date = now.toISOString().slice(0, 10);
  const baselineEquity = existing?.date === date ? existing.baselineEquity : currentEquity;
  const baseline = scaled(baselineEquity);
  const current = scaled(currentEquity);
  if (baseline <= 0n || current < 0n) throw new Error("INVALID_PORTFOLIO_EQUITY");
  const nextState: DailyDrawdownState = { date, baselineEquity, lastEquity: currentEquity };
  const threshold = BigInt(policy.maxDailyDrawdownPct.replace(".", "").padEnd(8, "0"));
  const reached = current < baseline
    && (baseline - current) * 100n >= baseline * threshold / 10n ** 8n;
  if (!reached) return { blocked: false, code: "NONE", state: nextState };
  const cooldownUntil = existing?.date === date ? existing.cooldownUntil : undefined;
  if (cooldownUntil && now.getTime() < new Date(cooldownUntil).getTime()) {
    return {
      blocked: true,
      code: "DRAWDOWN_COOLDOWN",
      state: { ...nextState, cooldownUntil },
    };
  }
  const nextCooldownUntil = new Date(now.getTime() + policy.drawdownCooldownMinutes * 60_000).toISOString();
  return {
    blocked: true,
    code: "DAILY_DRAWDOWN",
    state: { ...nextState, cooldownUntil: nextCooldownUntil },
  };
}
