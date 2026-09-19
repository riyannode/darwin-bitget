import type { Env, OwnerPolicy } from "../types.js";
import { z } from "zod";

export const DEFAULT_OWNER_POLICY: OwnerPolicy = {
  paperOnly: true,
  maxSinglePositionMarginPct: "30",
  maxLeverage: "5",
  maxDailyDrawdownPct: "10",
  drawdownCooldownMinutes: 60,
  scanIntervalMinutes: 5,
  emergencyStop: false,
};

export const OWNER_POLICY_HARD_BOUNDS = {
  maxLeverage: { min: 1, max: 5 },
  maxSinglePositionMarginPct: { min: 1, max: 30 },
  maxDailyDrawdownPct: { min: 1, max: 20 },
  drawdownCooldownMinutes: { min: 5, max: 1440 },
} as const;

export const ownerPolicyUpdateSchema = z.object({
  maxLeverage: z.string().optional(),
  maxSinglePositionMarginPct: z.string().optional(),
  maxDailyDrawdownPct: z.string().optional(),
  drawdownCooldownMinutes: z.number().int().optional(),
  scanIntervalMinutes: z.number().int().optional(),
}).strict();

export type OwnerPolicyUpdate = z.infer<typeof ownerPolicyUpdateSchema>;

function positiveNumber(value: string | undefined, fallback: number, maximum?: number, minimum = 1): number {
  const parsed = Number(value?.trim() || fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || (maximum !== undefined && parsed > maximum)) throw new Error("INVALID_POLICY");
  return parsed;
}

function decimal(value: string | undefined, fallback: string, maximum: number, minimum = 1): string {
  const text = value?.trim() || fallback;
  if (!/^\d+(?:\.\d{1,8})?$/.test(text)) throw new Error("INVALID_POLICY");
  if (Number(text) < minimum || Number(text) > maximum) throw new Error("INVALID_POLICY");
  return text;
}

export function loadOwnerPolicy(env: Omit<Env, "TRADER_AGENT">): OwnerPolicy {
  if (env.PAPER_ONLY !== "true") throw new Error("PAPER_ONLY");
  return {
    paperOnly: true,
    maxSinglePositionMarginPct: decimal(env.MAX_SINGLE_POSITION_MARGIN_PCT, DEFAULT_OWNER_POLICY.maxSinglePositionMarginPct, OWNER_POLICY_HARD_BOUNDS.maxSinglePositionMarginPct.max),
    maxLeverage: decimal(env.MAX_LEVERAGE, DEFAULT_OWNER_POLICY.maxLeverage, OWNER_POLICY_HARD_BOUNDS.maxLeverage.max),
    maxDailyDrawdownPct: decimal(env.MAX_DAILY_DRAWDOWN_PCT, DEFAULT_OWNER_POLICY.maxDailyDrawdownPct, OWNER_POLICY_HARD_BOUNDS.maxDailyDrawdownPct.max),
    drawdownCooldownMinutes: positiveNumber(env.DRAWDOWN_COOLDOWN_MINUTES, DEFAULT_OWNER_POLICY.drawdownCooldownMinutes, OWNER_POLICY_HARD_BOUNDS.drawdownCooldownMinutes.max, OWNER_POLICY_HARD_BOUNDS.drawdownCooldownMinutes.min),
    scanIntervalMinutes: positiveNumber(env.SCAN_INTERVAL_MINUTES, DEFAULT_OWNER_POLICY.scanIntervalMinutes),
    emergencyStop: env.EMERGENCY_STOP === "true",
  };
}

export function parseOwnerPolicy(value: unknown): OwnerPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_POLICY");
  const record = value as Record<string, unknown>;
  const paperOnly = record.paperOnly === true;
  if (!paperOnly) throw new Error("PAPER_ONLY");
  const maxLeverage = typeof record.maxLeverage === "string" ? record.maxLeverage : undefined;
  const maxSinglePositionMarginPct = typeof record.maxSinglePositionMarginPct === "string" ? record.maxSinglePositionMarginPct : undefined;
  const maxDailyDrawdownPct = typeof record.maxDailyDrawdownPct === "string" ? record.maxDailyDrawdownPct : undefined;
  const drawdownCooldownMinutes = typeof record.drawdownCooldownMinutes === "number" ? String(record.drawdownCooldownMinutes) : undefined;
  const scanIntervalMinutes = typeof record.scanIntervalMinutes === "number" ? String(record.scanIntervalMinutes) : undefined;
  return {
    paperOnly: true,
    maxLeverage: decimal(maxLeverage, "", OWNER_POLICY_HARD_BOUNDS.maxLeverage.max),
    maxSinglePositionMarginPct: decimal(maxSinglePositionMarginPct, "", OWNER_POLICY_HARD_BOUNDS.maxSinglePositionMarginPct.max),
    maxDailyDrawdownPct: decimal(maxDailyDrawdownPct, "", OWNER_POLICY_HARD_BOUNDS.maxDailyDrawdownPct.max),
    drawdownCooldownMinutes: positiveNumber(drawdownCooldownMinutes, 0, OWNER_POLICY_HARD_BOUNDS.drawdownCooldownMinutes.max, OWNER_POLICY_HARD_BOUNDS.drawdownCooldownMinutes.min),
    scanIntervalMinutes: positiveNumber(scanIntervalMinutes, 0),
    emergencyStop: record.emergencyStop === true,
  };
}

export function updateOwnerPolicy(current: OwnerPolicy, value: unknown): OwnerPolicy {
  const update = ownerPolicyUpdateSchema.parse(value);
  return parseOwnerPolicy({ ...current, ...update, paperOnly: true });
}
