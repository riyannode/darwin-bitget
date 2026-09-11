import { z } from "zod";
import type { BacktestReplay, HistoricalBar, Lesson, RuntimeConfig, TradeExperience } from "../types.js";
import { generateQwenJson } from "../agent/qwen.js";
import { BACKTEST_TASK_PROMPT } from "../agent/mandate.js";

const actionSchema = z.enum(["OPEN_LONG", "OPEN_SHORT", "HOLD", "REDUCE", "CLOSE"]);

function decimal(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("INVALID_HISTORICAL_PRICE");
  return parsed;
}

function metric(hypothesis: string, actions: z.infer<typeof actionSchema>[], bars: HistoricalBar[]) {
  let position = 0;
  let entry = 0;
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const price = decimal(bars[index]?.close ?? "0");
    const action = actions[index] ?? "HOLD";
    if ((action === "OPEN_LONG" || action === "OPEN_SHORT") && position === 0) {
      position = action === "OPEN_LONG" ? 1 : -1;
      entry = price;
      trades += 1;
    } else if ((action === "REDUCE" || action === "CLOSE") && position !== 0) {
      const change = position === 1 ? price / entry - 1 : entry / price - 1;
      equity *= 1 + change;
      position = 0;
      if (change >= 0) wins += 1;
      else losses += 1;
    }
    if (position !== 0) equity = 1 + (position === 1 ? price / entry - 1 : entry / price - 1);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak === 0 ? 0 : (peak - equity) / peak);
  }
  return {
    hypothesis,
    returnPct: ((equity - 1) * 100).toFixed(6),
    maxDrawdownPct: (maxDrawdown * 100).toFixed(6),
    trades,
    wins,
    losses,
  };
}

export interface CooldownBacktestInput {
  symbol: string;
  bars: HistoricalBar[];
  experiences: TradeExperience[];
  trigger: string;
  now?: Date;
}

export async function runCooldownBacktest(
  config: RuntimeConfig,
  input: CooldownBacktestInput,
): Promise<BacktestReplay | undefined> {
  const bars = input.bars.slice(-48);
  if (bars.length < 3 || !config.qwenApiKey) return undefined;
  const schema = z.object({
    hypotheses: z.array(z.string().min(1).max(240)).min(1).max(3),
    traces: z.array(z.object({
      hypothesis: z.string().min(1).max(240),
      actions: z.array(actionSchema).length(bars.length),
    })).min(1).max(3),
    selectedLesson: z.string().min(1).max(500),
  });
  const parsed = await generateQwenJson(config, schema, BACKTEST_TASK_PROMPT, JSON.stringify({ symbol: input.symbol, bars, experiences: input.experiences.slice(0, 20), baseline: "NO_TRADE_BASELINE" }));
  const metrics = [
    { hypothesis: "NO_TRADE_BASELINE", returnPct: "0.000000", maxDrawdownPct: "0.000000", trades: 0, wins: 0, losses: 0 },
    ...parsed.traces.map((trace) => metric(trace.hypothesis, trace.actions, bars)),
  ];
  const now = (input.now ?? new Date()).toISOString();
  return {
    backtestId: crypto.randomUUID(),
    trigger: input.trigger,
    sourceTradeIds: input.experiences.map((experience) => experience.experienceId).slice(0, 20),
    symbols: [input.symbol],
    historicalWindow: `${bars[0]?.observedAt ?? now}/${bars[bars.length - 1]?.observedAt ?? now}`,
    hypotheses: parsed.hypotheses,
    baseline: "NO_TRADE_BASELINE",
    metrics,
    selectedLesson: parsed.selectedLesson,
    createdAt: now,
  };
}

export function createBacktestLesson(replay: BacktestReplay): Lesson {
  const now = replay.createdAt;
  return {
    lessonId: crypto.randomUUID(),
    lessonType: "BACKTEST_REPLAY",
    source: "BACKTEST_REPLAY",
    symbolScope: replay.symbols[0] ?? "ALL",
    marketRegime: "UNKNOWN",
    trigger: replay.trigger,
    failureCode: "",
    actionTaken: "HOLD",
    observedOutcome: replay.selectedLesson,
    lesson: replay.selectedLesson,
    applicableConditions: ["BACKTEST_REPLAY"],
    confidence: 0.4,
    timesRetrieved: 0,
    timesApplied: 0,
    successfulApplications: 0,
    failedApplications: 0,
    status: "CANDIDATE",
    createdAt: now,
    updatedAt: now,
  };
}
