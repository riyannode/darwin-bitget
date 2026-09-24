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

/** Bump when provider lifecycle attribution or performance calculation semantics change. */
export const PROVIDER_LIFECYCLE_PERFORMANCE_READ_MODEL_VERSION = 2;

export function resolveProviderPerformanceReadModel(
  executor: SqlExecutor,
  signature: string,
  updatedAt: string,
  rebuild: () => ProviderPerformanceTotals,
): ProviderPerformanceReadModelResult {
  const cached = loadProviderLifecyclePerformanceReadModelCache(executor);
  if (cached?.semanticVersion === PROVIDER_LIFECYCLE_PERFORMANCE_READ_MODEL_VERSION && cached.signature === signature) {
    return { totals: cached.totals, cacheHit: true };
  }
  const totals = rebuild();
  saveProviderLifecyclePerformanceReadModelCache(executor, {
    version: 1,
    semanticVersion: PROVIDER_LIFECYCLE_PERFORMANCE_READ_MODEL_VERSION,
    signature,
    totals,
  }, updatedAt);
  return { totals, cacheHit: false };
}
