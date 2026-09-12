import type { Lesson } from "../types.js";

export interface LessonContext {
  symbol: string;
  marketRegime: string;
  failureCode?: string;
  action?: string;
}

function score(lesson: Lesson, context: LessonContext): number {
  let value = 0;
  if (lesson.status === "RETIRED" || lesson.status === "CONTRADICTED") return -1;
  if (lesson.status === "CANDIDATE") value -= 1;
  if (lesson.status === "WEAKENED") value -= 2;
  if (lesson.symbolScope === context.symbol) value += 6;
  if (lesson.symbolScope === "ALL") value += 2;
  if (lesson.marketRegime === context.marketRegime) value += 4;
  if (context.failureCode && lesson.failureCode === context.failureCode) value += 5;
  if (context.action && lesson.actionTaken === context.action) value += 2;
  value += Math.min(lesson.successfulApplications, 3);
  value -= Math.min(lesson.failedApplications, 2);
  return value;
}

export function retrieveLessons(
  lessons: Lesson[],
  context: LessonContext,
  limit = 5,
): Lesson[] {
  return lessons
    .filter((lesson) => lesson.source !== "EXECUTION_FAILURE" || context.failureCode === lesson.failureCode)
    .map((lesson) => ({ lesson, value: score(lesson, context) }))
    .filter((entry) => entry.value >= 0)
    .sort((left, right) => right.value - left.value || right.lesson.updatedAt.localeCompare(left.lesson.updatedAt))
    .slice(0, limit)
    .map((entry) => entry.lesson);
}
