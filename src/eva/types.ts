import { z } from "zod";

export const evaFeedbackSchema = z.object({
  status: z.enum(["PASS", "FAIL"]),
  feedback: z.string().min(1).max(1000),
  weakness: z.string().min(1).max(500).optional(),
});

export type EvaFeedback = z.infer<typeof evaFeedbackSchema>;

export interface EvaScenario {
  scenarioId: string;
  symbol: string;
  prompt: string;
  evidence: unknown;
}
