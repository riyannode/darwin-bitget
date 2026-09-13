export const CYCLE_INTERVAL_SECONDS = 900;
export const TEMPORARY_SCAN_INTERVAL_MINUTES = 2;
export const TEMPORARY_SCAN_INTERVAL_DURATION_MS = 2 * 60 * 60 * 1000;

export function temporaryScanIntervalActive(expiresAt: string | null, completed: boolean, now = Date.now()): boolean {
  return !completed && Boolean(expiresAt) && new Date(expiresAt as string).getTime() > now;
}

export type CycleSchedule = {
  id: string;
  callback: string;
  type?: string;
  intervalSeconds?: number;
  time?: number;
};

export interface CycleScheduler {
  scheduleEvery(
    intervalSeconds: number,
    callback: string,
    payload?: undefined,
    options?: { _idempotent?: boolean },
  ): Promise<unknown>;
  listSchedules(): Promise<CycleSchedule[]>;
  cancelSchedule(id: string): Promise<boolean>;
}

export type SchedulerReconciliationState = {
  paused: boolean;
  emergencyStop: boolean;
  activeCycle: boolean;
  nextScanAt: string | null;
};

export type SchedulerReconciliationResult = {
  cycleSchedules: CycleSchedule[];
  matchingSchedules: CycleSchedule[];
  nextScanAt: string | null;
  nextScanStale: boolean;
  repaired: boolean;
};

function scheduleMatches(schedule: CycleSchedule, intervalSeconds: number): boolean {
  return schedule.type === "interval" && schedule.intervalSeconds === intervalSeconds;
}

function nextScanIsStale(nextScanAt: string | null, intervalMs: number, now: number): boolean {
  if (!nextScanAt) return true;
  const nextScanMs = Date.parse(nextScanAt);
  return !Number.isFinite(nextScanMs) || now > nextScanMs + intervalMs + 30_000;
}

function scheduledTimeToIso(schedule: CycleSchedule | undefined, fallback: string): string {
  return schedule?.time !== undefined && Number.isFinite(schedule.time)
    ? new Date(schedule.time * 1000).toISOString()
    : fallback;
}

/**
 * Reconcile the single autonomous cycle schedule with one bounded inspection,
 * optional replacement, and one readback after mutation.
 */
export async function reconcileTradingSchedule(
  scheduler: CycleScheduler,
  intervalMinutes: number,
  state: SchedulerReconciliationState,
  options: { ensureSchedule?: boolean; now?: number } = {},
): Promise<SchedulerReconciliationResult> {
  const intervalSeconds = intervalMinutes * 60;
  const intervalMs = intervalMinutes * 60_000;
  const now = options.now ?? Date.now();
  const fallbackNextScanAt = new Date(now + intervalMs).toISOString();
  const stale = nextScanIsStale(state.nextScanAt, intervalMs, now);
  const eligible = !state.paused && !state.emergencyStop && !state.activeCycle;

  let schedules: CycleSchedule[];
  try {
    schedules = await scheduler.listSchedules();
  } catch {
    throw new Error("SCHEDULE_LIST_FAILED");
  }
  let cycleSchedules = schedules.filter((entry) => entry.callback === "runScheduledCycle");
  let matchingSchedules = cycleSchedules.filter((entry) => scheduleMatches(entry, intervalSeconds));
  const structurallyHealthy = cycleSchedules.length === 1 && matchingSchedules.length === 1;
  const shouldRepair = eligible && (stale || options.ensureSchedule === true) && !structurallyHealthy;
  const shouldRecreateStaleMatching = eligible && stale && structurallyHealthy;
  let repaired = false;

  if (shouldRepair || shouldRecreateStaleMatching) {
    for (const schedule of cycleSchedules) await scheduler.cancelSchedule(schedule.id);
    await scheduler.scheduleEvery(intervalSeconds, "runScheduledCycle", undefined, { _idempotent: true });
    repaired = true;

    try {
      schedules = await scheduler.listSchedules();
    } catch {
      throw new Error("SCHEDULE_REPAIR_FAILED");
    }
    cycleSchedules = schedules.filter((entry) => entry.callback === "runScheduledCycle");
    matchingSchedules = cycleSchedules.filter((entry) => scheduleMatches(entry, intervalSeconds));
    if (cycleSchedules.length !== 1 || matchingSchedules.length !== 1) throw new Error("SCHEDULE_REPAIR_NOT_VERIFIED");
  }

  const verifiedSchedule = matchingSchedules.length === 1 ? matchingSchedules[0] : undefined;
  const nextScanAt = verifiedSchedule && (repaired || options.ensureSchedule === true)
    ? scheduledTimeToIso(verifiedSchedule, repaired ? fallbackNextScanAt : state.nextScanAt ?? fallbackNextScanAt)
    : state.nextScanAt;

  return {
    cycleSchedules,
    matchingSchedules,
    nextScanAt,
    nextScanStale: nextScanIsStale(nextScanAt, intervalMs, now),
    repaired,
  };
}

export async function scheduleTradingCycle(
  scheduler: CycleScheduler,
  intervalMinutes = CYCLE_INTERVAL_SECONDS / 60,
): Promise<unknown> {
  const intervalSeconds = intervalMinutes * 60;
  const schedules = await scheduler.listSchedules();
  const cycleSchedules = schedules.filter((entry) => entry.callback === "runScheduledCycle");
  const matchingSchedule = cycleSchedules.find((entry) => scheduleMatches(entry, intervalSeconds));
  if (cycleSchedules.length === 1 && matchingSchedule) return matchingSchedule;
  for (const schedule of cycleSchedules) await scheduler.cancelSchedule(schedule.id);
  return scheduler.scheduleEvery(intervalSeconds, "runScheduledCycle", undefined, { _idempotent: true });
}
