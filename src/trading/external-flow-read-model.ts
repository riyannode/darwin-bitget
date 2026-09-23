import {
  calculateVerifiedExternalFlows,
  type VerifiedExternalFlows,
} from "./external-flow.js";
import { loadProviderFinancialRecordsSinceCategories } from "../storage/provider-ledger.js";
import type { SqlExecutor } from "../storage/schema.js";
import { loadExternalFlowReadModelCache, saveExternalFlowReadModelCache } from "../storage/store.js";

export interface FinancialFlowCategoryState {
  category: string;
  complete: boolean;
  lastError: string | null;
  revision: number | null;
  updatedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  coveredFrom: string | null;
  coveredThrough: string | null;
  financialRecordCount: number | null;
}

export interface ExternalFlowReadModelResult {
  flows: VerifiedExternalFlows;
  cacheHit: boolean;
  recordsRead: number;
  truncated: boolean;
}

function categorySignature(categories: readonly FinancialFlowCategoryState[]): FinancialFlowCategoryState[] {
  return [...categories]
    .map((category) => ({ ...category }))
    .sort((left, right) => left.category.localeCompare(right.category));
}

function buildSignature(
  baselineAt: string | null,
  baselineEquity: string | null,
  categories: readonly FinancialFlowCategoryState[],
  requiredCategories: readonly string[],
): string {
  return JSON.stringify({
    version: 1,
    baselineAt,
    baselineEquity,
    requiredCategories: [...requiredCategories].sort(),
    categories: categorySignature(categories),
  });
}

function unavailableFlows(categories: readonly FinancialFlowCategoryState[]): VerifiedExternalFlows {
  return calculateVerifiedExternalFlows([], categories.map((category) => ({
    complete: false,
    lastError: category.lastError,
  })));
}

export function resolveExternalFlowReadModel(
  executor: SqlExecutor,
  baselineAt: string | null,
  baselineEquity: string | null,
  categories: readonly FinancialFlowCategoryState[],
  requiredCategories: readonly string[],
  updatedAt: string,
): ExternalFlowReadModelResult {
  const signature = buildSignature(baselineAt, baselineEquity, categories, requiredCategories);
  const cached = loadExternalFlowReadModelCache(executor);
  if (cached?.signature === signature) {
    return {
      flows: cached.flows,
      cacheHit: true,
      recordsRead: 0,
      truncated: cached.truncated,
    };
  }

  const categoryNames = new Set(categories.map((category) => category.category));
  const allRequiredComplete = Boolean(baselineAt)
    && requiredCategories.length > 0
    && categories.length === requiredCategories.length
    && categoryNames.size === categories.length
    && requiredCategories.every((category) => categoryNames.has(category))
    && categories.every((category) => category.complete && !category.lastError);

  let recordsRead = 0;
  let truncated = false;
  let flows: VerifiedExternalFlows;
  if (!allRequiredComplete || !baselineAt) {
    flows = unavailableFlows(categories);
  } else {
    const financialRecords = loadProviderFinancialRecordsSinceCategories(executor, requiredCategories, baselineAt);
    recordsRead = financialRecords.records.length;
    truncated = financialRecords.truncated;
    flows = truncated
      ? { status: "UNVERIFIED", netExternalInflows: "UNAVAILABLE", unknownTypes: [] }
      : calculateVerifiedExternalFlows(financialRecords.records, categories.map((category) => ({
        complete: category.complete,
        lastError: category.lastError,
      })));
  }

  saveExternalFlowReadModelCache(executor, { version: 1, signature, flows, truncated }, updatedAt);
  return { flows, cacheHit: false, recordsRead, truncated };
}
