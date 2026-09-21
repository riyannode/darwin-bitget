import { z } from "zod";
import type { TradeExperience } from "../types.js";

const experienceSchema = z.object({
  experienceId: z.string().min(1),
  symbol: z.string().min(1),
  positionSide: z.enum(["LONG", "SHORT"]).nullable(),
  action: z.enum(["OPEN_LONG", "OPEN_SHORT", "HOLD", "INCREASE", "REDUCE", "CLOSE", "REVERSE"]),
  entryDecisionId: z.string(),
  entryPrice: z.string(),
  entryTime: z.string(),
  exitDecisionId: z.string(),
  exitPrice: z.string(),
  exitTime: z.string(),
  realizedPnl: z.string(),
  realizedPnlPct: z.string(),
  selectedLeverage: z.string(),
  marginAllocationPct: z.string(),
  marginAllocated: z.string(),
  positionNotional: z.string(),
  maximumFavorableExcursion: z.string(),
  maximumFavorableExcursionBasis: z.enum(["SINCE_ENTRY", "SINCE_FIRST_DETERMINISTIC_OBSERVATION"]).optional(),
  maximumAdverseExcursion: z.string(),
  drawdownContribution: z.string(),
  liquidationDistance: z.string(),
  entryThesis: z.string(),
  exitThesis: z.string(),
  evidenceAtEntry: z.array(z.string()),
  evidenceAtExit: z.array(z.string()),
  lessonsUsed: z.array(z.string()),
  marketContext: z.string(),
  outcomeStatus: z.enum(["PROFITABLE", "LOSING", "BREAK_EVEN", "CLOSED_UNCLASSIFIED", "BLOCKED", "EXECUTION_FAILURE", "OPEN"]),
  lastAction: z.enum(["OPEN_LONG", "OPEN_SHORT", "HOLD", "INCREASE", "REDUCE", "CLOSE", "REVERSE"]).optional(),
  fees: z.string().optional(),
  funding: z.string().optional(),
  realizedPnlVerified: z.boolean().optional(),
});

export function parseExperience(value: unknown): TradeExperience {
  return experienceSchema.parse(value) as TradeExperience;
}
