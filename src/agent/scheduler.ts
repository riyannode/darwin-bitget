export const CYCLE_INTERVAL_SECONDS = 900;

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
