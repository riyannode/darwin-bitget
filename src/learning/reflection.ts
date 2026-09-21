import { z } from "zod";
import type {
  Decision,
  ExperienceOutcomeStatus,
  Lesson,
  ReflectionResult,
  RuntimeConfig,
  TradeExperience,
} from "../types.js";
import { generateQwenJson } from "../agent/qwen.js";
import { REFLECTION_TASK_PROMPT } from "../agent/mandate.js";

const reflectionModelSchema = z.object({
  summary: z.string().min(1).max(500),
  strategyAssessment: z.string().min(1).max(240),
  directionAssessment: z.string().min(1).max(240),
  entryAssessment: z.string().min(1).max(240),
  exitAssessment: z.string().min(1).max(240),
  leverageAssessment: z.string().min(1).max(240),
  marginAssessment: z.string().min(1).max(240),
  evidenceAssessment: z.string().min(1).max(240),
  executionAssessment: z.string().min(1).max(240),
  outcomeAssessment: z.string().min(1).max(240),
  lesson: z.string().min(1).max(500),
  applicableConditions: z.array(z.string().min(1).max(160)).max(5),
  confidence: z.number().min(0).max(1),
  lessonEvaluations: z.array(z.object({
    lessonId: z.string().min(1),
    assessment: z.enum(["HELPFUL", "NEUTRAL", "HARMFUL"]),
    rationale: z.string().min(1).max(240),
  })).max(5),
});

export interface ReflectionInput {
  decision: Decision;
  outcome: string;
  failureCode: string;
  symbol: string;
  marketRegime: string;
  experienceStatus?: ExperienceOutcomeStatus;
  entryPrice?: string;
  exitPrice?: string;
  evidenceAtEntry?: string[];
  evidenceAtExit?: string[];
  lessonsUsed?: string[];
  lessons?: Lesson[];
  marginAllocated?: string;
  positionNotional?: string;
  realizedPnl?: string;
  realizedPnlPct?: string;
  fees?: string;
  funding?: string;
  realizedPnlVerified?: boolean;
  existingExperience?: TradeExperience;
  now?: Date;
}

function statusFromPnl(realizedPnl: string, verified: boolean): ExperienceOutcomeStatus {
  if (!verified) return "EXECUTION_FAILURE";
  const value = Number(realizedPnl);
  if (!Number.isFinite(value)) return "EXECUTION_FAILURE";
  if (value > 0) return "PROFITABLE";
  if (value < 0) return "LOSING";
  return "BREAK_EVEN";
}

function localReflection(input: ReflectionInput, experience: TradeExperience): ReflectionResult {
  const createdAt = (input.now ?? new Date()).toISOString();
  return {
    reflectionId: crypto.randomUUID(),
    experienceId: experience.experienceId,
    createdAt,
    summary: input.outcome,
    strategyAssessment: input.decision.strategyThesis,
    directionAssessment: input.decision.action,
    entryAssessment: input.failureCode || "UNASSESSED",
    exitAssessment: input.decision.action === "CLOSE" || input.decision.action === "REDUCE" ? input.decision.thesis : "UNASSESSED",
    leverageAssessment: input.decision.leverage,
    marginAssessment: input.marginAllocated ?? "0",
    evidenceAssessment: input.evidenceAtExit?.join(",") || input.evidenceAtEntry?.join(",") || "NONE",
    executionAssessment: input.failureCode || "VERIFIED_OR_NOT_REQUIRED",
    outcomeAssessment: input.realizedPnl ?? input.outcome,
    outcome: input.outcome,
    assumption: input.decision.thesis,
    ignoredEvidence: input.failureCode || "NONE",
    lesson: input.failureCode ? `Review ${input.failureCode} before repeating this action.` : "Compare the thesis with the next verified outcome before increasing confidence.",
    applicableConditions: [input.marketRegime, input.symbol],
    confidence: input.failureCode ? 0.8 : 0.5,
    lessonEvaluations: [],
  };
}

function buildExperience(input: ReflectionInput, now: string): TradeExperience {
  const action = input.decision.action;
  const existing = input.existingExperience;
  if (existing) {
    return {
      ...existing,
      exitDecisionId: action === "REDUCE" || action === "CLOSE" ? input.decision.decisionId : existing.exitDecisionId,
      exitPrice: input.exitPrice ?? existing.exitPrice,
      exitTime: action === "REDUCE" || action === "CLOSE" ? now : existing.exitTime,
      realizedPnl: input.realizedPnl ?? existing.realizedPnl,
      realizedPnlPct: input.realizedPnlPct ?? existing.realizedPnlPct,
      exitThesis: action === "REDUCE" || action === "CLOSE" ? input.decision.thesis : existing.exitThesis,
      evidenceAtExit: input.evidenceAtExit ?? existing.evidenceAtExit,
      outcomeStatus: input.experienceStatus ?? statusFromPnl(input.realizedPnl ?? "", input.realizedPnlVerified === true),
      lastAction: action,
      ...(input.fees ? { fees: input.fees } : {}),
      ...(input.funding ? { funding: input.funding } : {}),
      ...(input.realizedPnlVerified !== undefined ? { realizedPnlVerified: input.realizedPnlVerified } : {}),
    };
  }
  const outcomeStatus = input.experienceStatus ?? (action === "OPEN_LONG" || action === "OPEN_SHORT" ? "OPEN" : statusFromPnl(input.realizedPnl ?? "", input.realizedPnlVerified === true));
  return {
    experienceId: crypto.randomUUID(),
    symbol: input.symbol,
    positionSide: input.decision.positionSide,
    action,
    entryDecisionId: action === "OPEN_LONG" || action === "OPEN_SHORT" ? input.decision.decisionId : "",
    entryPrice: input.entryPrice ?? "0",
    entryTime: now,
    exitDecisionId: action === "REDUCE" || action === "CLOSE" ? input.decision.decisionId : "",
    exitPrice: input.exitPrice ?? "0",
    exitTime: action === "REDUCE" || action === "CLOSE" ? now : "",
    selectedLeverage: input.decision.leverage,
    marginAllocationPct: input.decision.marginAllocationPct,
    marginAllocated: input.marginAllocated ?? "0",
    positionNotional: input.positionNotional ?? "0",
    realizedPnl: input.realizedPnl ?? "0",
    realizedPnlPct: input.realizedPnlPct ?? "0",
    maximumFavorableExcursion: "0",
    maximumFavorableExcursionBasis: "SINCE_ENTRY",
    maximumAdverseExcursion: "0",
    drawdownContribution: "0",
    liquidationDistance: "0",
    entryThesis: input.decision.thesis,
    exitThesis: action === "REDUCE" || action === "CLOSE" ? input.decision.thesis : "",
    evidenceAtEntry: input.evidenceAtEntry ?? [],
    evidenceAtExit: input.evidenceAtExit ?? [],
    lessonsUsed: input.lessonsUsed ?? [],
    marketContext: input.marketRegime,
    outcomeStatus,
    lastAction: action,
    ...(input.fees ? { fees: input.fees } : {}),
    ...(input.funding ? { funding: input.funding } : {}),
    ...(input.realizedPnlVerified !== undefined ? { realizedPnlVerified: input.realizedPnlVerified } : {}),
  };
}

export function reflect(input: ReflectionInput): { reflection: ReflectionResult; lesson: Lesson; experience: TradeExperience } {
  const now = (input.now ?? new Date()).toISOString();
  const experience = buildExperience(input, now);
  const reflection = localReflection(input, experience);
  const lesson: Lesson = {
    lessonId: crypto.randomUUID(),
    lessonType: input.failureCode === "" ? "OUTCOME" : "FAILURE_AVOIDANCE",
    source: input.failureCode === "" ? "SELF_OUTCOME" : input.outcome === "EXECUTION_FAILURE" ? "EXECUTION_FAILURE" : "RISK_GATE",
    symbolScope: input.symbol,
    marketRegime: input.marketRegime,
    trigger: input.failureCode || "COMPLETED_CYCLE",
    failureCode: input.failureCode,
    actionTaken: input.decision.action,
    observedOutcome: input.outcome,
    lesson: reflection.lesson,
    applicableConditions: reflection.applicableConditions,
    confidence: reflection.confidence,
    timesRetrieved: 0,
    timesApplied: 0,
    successfulApplications: 0,
    failedApplications: 0,
    status: "CANDIDATE",
    createdAt: now,
    updatedAt: now,
  };
  return { reflection, lesson, experience };
}

export async function reflectWithQwen(config: RuntimeConfig, input: ReflectionInput): Promise<{ reflection: ReflectionResult; lesson: Lesson; experience: TradeExperience }> {
  const local = reflect(input);
  const model = await generateQwenJson(config, reflectionModelSchema, REFLECTION_TASK_PROMPT, JSON.stringify({ decision: input.decision, experience: local.experience, outcome: input.outcome, failureCode: input.failureCode, marketRegime: input.marketRegime, lessonsUsed: input.lessonsUsed ?? [], lessons: input.lessons ?? [] }));
  const knownLessons = new Set(input.lessonsUsed ?? []);
  if (model.lessonEvaluations.some((evaluation) => !knownLessons.has(evaluation.lessonId))) throw new Error("LESSON_REFERENCE_INVALID");
  if ((input.lessonsUsed ?? []).some((lessonId) => !model.lessonEvaluations.some((evaluation) => evaluation.lessonId === lessonId))) throw new Error("LESSON_EVALUATION_MISSING");
  const reflection: ReflectionResult = {
    ...model,
    reflectionId: local.reflection.reflectionId,
    experienceId: local.experience.experienceId,
    createdAt: new Date().toISOString(),
    outcome: input.outcome,
    assumption: input.decision.thesis,
    ignoredEvidence: input.failureCode || "NONE",
  };
  const lesson: Lesson = {
    ...local.lesson,
    lesson: model.lesson,
    applicableConditions: model.applicableConditions,
    confidence: model.confidence,
    updatedAt: new Date().toISOString(),
  };
  return { reflection, lesson, experience: local.experience };
}
