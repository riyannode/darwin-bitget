import { z } from "zod";
import type { Lesson } from "../types.js";

const lessonSchema = z.object({
  lessonId: z.string().min(1),
  lessonType: z.string().min(1),
  source: z.enum(["SELF_OUTCOME", "EXECUTION_FAILURE", "RISK_GATE", "BACKTEST_REPLAY", "EVA_EVALUATION"]),
  symbolScope: z.string().min(1),
  marketRegime: z.string().min(1),
  trigger: z.string().min(1),
  failureCode: z.string(),
  actionTaken: z.enum(["OPEN_LONG", "OPEN_SHORT", "HOLD", "REDUCE", "CLOSE"]),
  observedOutcome: z.string().min(1),
  lesson: z.string().min(1),
  applicableConditions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  timesRetrieved: z.number().int().nonnegative(),
  timesApplied: z.number().int().nonnegative(),
  successfulApplications: z.number().int().nonnegative(),
  failedApplications: z.number().int().nonnegative(),
  status: z.enum(["CANDIDATE", "ACTIVE", "WEAKENED", "CONTRADICTED", "RETIRED"]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export function parseLesson(value: unknown): Lesson {
  return lessonSchema.parse(value);
}
