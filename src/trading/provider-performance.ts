import { addDecimal, compareDecimal, isDecimal } from "./decimal.js";

export type ProviderLifecycleOrigin = "DARWIN" | "PROVIDER_EXTERNAL" | "UNATTRIBUTED";
export interface ProviderPerformanceLifecycle {
  lifecycleId: string;
  origin: ProviderLifecycleOrigin;
  status: "OPEN" | "CLOSED";
  netProfit?: string;
  closedAt?: string;
}
export interface ProviderPerformanceTotals {
  source: "PROVIDER_LEDGER";
  closedTrades: number;
  openTrades: number;
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  closedEpisodeRealizedPnl: string;
  verifiedRealizedPnl: string;
  unresolvedClosedLifecycles: number;
  dailyPnl: Record<string, { pnl: string; trades: number }>;
}

/** Deterministically rebuild DARWIN performance from uniquely identified provider lifecycles. */
export function rebuildProviderPerformance(lifecycles: readonly ProviderPerformanceLifecycle[]): ProviderPerformanceTotals {
  const byId = new Map<string, ProviderPerformanceLifecycle>();
  for (const lifecycle of lifecycles) {
    if (!lifecycle.lifecycleId) continue;
    const existing = byId.get(lifecycle.lifecycleId);
    if (existing && (existing.origin !== lifecycle.origin || existing.status !== lifecycle.status || existing.netProfit !== lifecycle.netProfit || existing.closedAt !== lifecycle.closedAt)) {
      throw new Error("PROVIDER_PERFORMANCE_DUPLICATE_LIFECYCLE_CONTRADICTION");
    }
    byId.set(lifecycle.lifecycleId, lifecycle);
  }
  const darwin = [...byId.values()].filter((lifecycle) => lifecycle.origin === "DARWIN");
  const closed = darwin.filter((lifecycle) => lifecycle.status === "CLOSED");
  const open = darwin.filter((lifecycle) => lifecycle.status === "OPEN");
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let unresolvedClosedLifecycles = 0;
  let realized = "0";
  const dailyPnl: ProviderPerformanceTotals["dailyPnl"] = {};
  for (const lifecycle of closed) {
    if (!isDecimal(lifecycle.netProfit)) {
      unresolvedClosedLifecycles += 1;
      continue;
    }
    realized = addDecimal(realized, lifecycle.netProfit);
    const comparison = compareDecimal(lifecycle.netProfit, "0");
    if (comparison > 0) wins += 1;
    else if (comparison < 0) losses += 1;
    else breakeven += 1;
    const day = lifecycle.closedAt && Number.isFinite(Date.parse(lifecycle.closedAt)) ? lifecycle.closedAt.slice(0, 10) : null;
    if (day) {
      const current = dailyPnl[day] ?? { pnl: "0", trades: 0 };
      dailyPnl[day] = { pnl: addDecimal(current.pnl, lifecycle.netProfit), trades: current.trades + 1 };
    }
  }
  return {
    source: "PROVIDER_LEDGER",
    closedTrades: closed.length,
    openTrades: open.length,
    totalTrades: closed.length + open.length,
    wins,
    losses,
    breakeven,
    closedEpisodeRealizedPnl: unresolvedClosedLifecycles ? "UNAVAILABLE" : realized,
    verifiedRealizedPnl: unresolvedClosedLifecycles ? "UNAVAILABLE" : realized,
    unresolvedClosedLifecycles,
    dailyPnl,
  };
}
