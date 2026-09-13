import type { DashboardSnapshot } from "../types.js";

export function resolveDashboardPortfolio(livePortfolio: DashboardSnapshot["portfolio"], journalPortfolio: DashboardSnapshot["portfolio"], observedAt: string): { value: DashboardSnapshot["portfolio"]; freshness: DashboardSnapshot["portfolioFreshness"] } {
  if (livePortfolio) return { value: livePortfolio, freshness: { source: "PROVIDER_LIVE", observedAt: livePortfolio.observedAt, stale: false } };
  return { value: journalPortfolio, freshness: { source: "JOURNAL_FALLBACK", observedAt: journalPortfolio?.observedAt ?? observedAt, stale: true } };
}
