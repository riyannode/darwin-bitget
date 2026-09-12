export const CYCLE_INTERVAL_SECONDS = 900;
export const TEMPORARY_SCAN_INTERVAL_MINUTES = 2;
export const TEMPORARY_SCAN_INTERVAL_DURATION_MS = 2 * 60 * 60 * 1000;

export function temporaryScanIntervalActive(expiresAt: string | null, completed: boolean, now = Date.now()): boolean {
  return !completed && Boolean(expiresAt) && new Date(expiresAt as string).getTime() > now;
}

export interface CycleScheduler {
  scheduleEvery(
    intervalSeconds: number,
    callback: string,
    payload?: undefined,
    options?: { _idempotent?: boolean },
  ): Promise<unknown>;
  listSchedules(): Promise<Array<{ id: string; callback: string; type?: string; intervalSeconds?: number; time?: number }>>;
  cancelSchedule(id: string): Promise<boolean>;
}

export async function scheduleTradingCycle(
  scheduler: CycleScheduler,
  intervalMinutes = CYCLE_INTERVAL_SECONDS / 60,
): Promise<unknown> {
  const intervalSeconds = intervalMinutes * 60;
  const schedules = await scheduler.listSchedules();
  const cycleSchedules = schedules.filter((entry) => entry.callback === "runScheduledCycle");
  const matchingSchedule = cycleSchedules.find((entry) => entry.type === "interval" && entry.intervalSeconds === intervalSeconds);
  if (cycleSchedules.length === 1 && matchingSchedule) return matchingSchedule;
  for (const schedule of cycleSchedules) {
    await scheduler.cancelSchedule(schedule.id);
  }
  return scheduler.scheduleEvery(intervalSeconds, "runScheduledCycle", undefined, { _idempotent: true });
}
