export const ACTIVE_SNAPSHOT_POLL_INTERVAL_MS = 10_000;
export const INACTIVE_SNAPSHOT_POLL_INTERVAL_MS = 60_000;

const ACTIVE_STAGES = new Set(["ONLINE", "SCANNING", "ANALYZING"]);
const INACTIVE_STATES = new Set(["PAUSED", "IDLE"]);

export function snapshotPollIntervalMs(agent) {
  const stage = agent?.currentStage?.toUpperCase() ?? "";
  const states = [agent?.status, agent?.runtimeStatus].filter(Boolean).map((value) => value.toUpperCase());
  if (INACTIVE_STATES.has(stage) || states.some((state) => INACTIVE_STATES.has(state))) {
    return INACTIVE_SNAPSHOT_POLL_INTERVAL_MS;
  }
  return ACTIVE_STAGES.has(stage) && states.includes("ONLINE")
    ? ACTIVE_SNAPSHOT_POLL_INTERVAL_MS
    : INACTIVE_SNAPSHOT_POLL_INTERVAL_MS;
}

export function createSnapshotPolling({ document, getAgent, refresh, setTimeoutFn = globalThis.setTimeout, clearTimeoutFn = globalThis.clearTimeout }) {
  let timer;
  let running = false;
  let inFlight = false;
  let refreshWhenIdle = false;

  const cancelTimer = () => {
    if (timer !== undefined) clearTimeoutFn(timer);
    timer = undefined;
  };

  const schedule = () => {
    if (!running || document.hidden || timer !== undefined || inFlight) return;
    timer = setTimeoutFn(() => {
      timer = undefined;
      void refreshNow();
    }, snapshotPollIntervalMs(getAgent()));
  };

  const refreshNow = async () => {
    if (!running || document.hidden) return;
    if (inFlight) {
      refreshWhenIdle = true;
      return;
    }
    inFlight = true;
    try {
      await refresh();
    } finally {
      inFlight = false;
      if (refreshWhenIdle && running && !document.hidden) {
        refreshWhenIdle = false;
        void refreshNow();
      } else {
        refreshWhenIdle = false;
        schedule();
      }
    }
  };

  const onVisibilityChange = () => {
    if (document.hidden) {
      cancelTimer();
      return;
    }
    cancelTimer();
    void refreshNow();
  };

  return {
    start() {
      if (running) return;
      running = true;
      document.addEventListener("visibilitychange", onVisibilityChange);
      void refreshNow();
    },
    stop() {
      running = false;
      refreshWhenIdle = false;
      cancelTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
