import type { SqlExecutor } from "../storage/schema.js";
import {
  loadProviderLifecyclePerformanceReadModelCache,
  saveProviderLifecyclePerformanceReadModelCache,
} from "../storage/store.js";
import type { ProviderPerformanceTotals } from "./provider-performance.js";

export interface ProviderPerformanceReadModelResult {
  totals: ProviderPerformanceTotals;
  cacheHit: boolean;
}

export function resolveProviderPerformanceReadModel(
  executor: SqlExecutor,
  signature: string,
  updatedAt: string,
  rebuild: () => ProviderPerformanceTotals,
): ProviderPerformanceReadModelResult {
  const cached = loadProviderLifecyclePerformanceReadModelCache(executor);
  if (cached?.signature === signature) return { totals: cached.totals, cacheHit: true };
  const totals = rebuild();
  saveProviderLifecyclePerformanceReadModelCache(executor, { version: 1, signature, totals }, updatedAt);
  return { totals, cacheHit: false };
}
