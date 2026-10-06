export type CyclePhase =
  | "INITIAL_PORTFOLIO"
  | "INSTRUMENTS"
  | "MARKET_SCAN"
  | "MARKET_EVIDENCE"
  | "POSITION_MANAGEMENT"
  | "RESEARCH"
  | "DECISION_QWEN"
  | "EXECUTION_PLAN"
  | "FINALIZE";

export async function runTimedCyclePhase<T>(
  phase: CyclePhase,
  operation: () => Promise<T> | T,
  log: (line: string) => void = (line) => console.log(line),
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    try {
      log(JSON.stringify({
        event: "CYCLE_PHASE_TIMING",
        phase,
        durationMs: Math.max(0, Date.now() - startedAt),
      }));
    } catch {
      // Timing telemetry must never affect the trading cycle.
    }
  }
}
