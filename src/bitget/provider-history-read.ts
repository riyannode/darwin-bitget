import { providerPage, type ProviderLedgerReadParams } from "./provider-ledger.js";
import type { ProviderLedgerReadClient } from "./provider-sync.js";

const MAX_HISTORY_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 24;
const DEFAULT_MAX_ROWS = 2_400;

type ProviderResource = "orders" | "fills" | "positionHistory" | "financialRecords";

type ReadFunction = (params: ProviderLedgerReadParams) => Promise<unknown>;

export interface ProviderHistoryCheckpoint {
  windowStart: string;
  windowEnd: string;
  pages: number;
  rows: number;
  complete: boolean;
  nextCursor: string | null;
}

export interface BoundedProviderHistoryResult {
  status: "COMPLETE" | "INCOMPLETE";
  requestedFrom: string;
  requestedThrough: string;
  coveredFrom: string;
  coveredThrough: string;
  withinProviderRetention: boolean;
  rows: Record<ProviderResource, Record<string, unknown>[]>;
  checkpoints: Record<ProviderResource, ProviderHistoryCheckpoint[]>;
  errors: string[];
}

export interface BoundedProviderHistoryOptions {
  category: string;
  symbol: string;
  from: string;
  through: string;
  now?: Date;
  maxPages?: number;
  maxRows?: number;
}

function safeFailureCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "details" in error) {
    const details = (error as { details?: { classification?: unknown } }).details;
    const classification = details?.classification;
    if (typeof classification === "string" && /^[A-Z0-9_-]{1,80}$/.test(classification)) return classification;
  }
  return "PROVIDER_HISTORY_READ_FAILED";
}

function resourceReader(client: ProviderLedgerReadClient, resource: ProviderResource): ReadFunction {
  switch (resource) {
    case "orders": return client.getOrderHistoryRead.bind(client);
    case "fills": return client.getFillHistoryWindowRead.bind(client);
    case "positionHistory": return client.getPositionHistoryRead.bind(client);
    case "financialRecords": return client.getFinancialRecordsRead.bind(client);
  }
}

function windows(fromMs: number, throughMs: number): Array<{ fromMs: number; throughMs: number }> {
  const result: Array<{ fromMs: number; throughMs: number }> = [];
  let cursor = fromMs;
  while (cursor <= throughMs) {
    const end = Math.min(throughMs, cursor + MAX_WINDOW_MS - 1);
    result.push({ fromMs: cursor, throughMs: end });
    cursor = end + 1;
  }
  return result;
}

async function readResource(
  client: ProviderLedgerReadClient,
  resource: ProviderResource,
  options: BoundedProviderHistoryOptions,
  fromMs: number,
  throughMs: number,
  maxPages: number,
  maxRows: number,
): Promise<{ rows: Record<string, unknown>[]; checkpoints: ProviderHistoryCheckpoint[]; errors: string[] }> {
  const read = resourceReader(client, resource);
  const rows: Record<string, unknown>[] = [];
  const checkpoints: ProviderHistoryCheckpoint[] = [];
  const errors: string[] = [];
  let totalPages = 0;

  for (const window of windows(fromMs, throughMs)) {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let pages = 0;
    let rowsInWindow = 0;
    let complete = false;
    try {
      while (true) {
        if (totalPages >= maxPages) throw new Error("PROVIDER_HISTORY_PAGE_BUDGET_EXCEEDED");
        const params: ProviderLedgerReadParams = {
          category: options.category,
          ...(resource === "financialRecords" ? {} : { symbol: options.symbol }),
          startTime: String(window.fromMs),
          endTime: String(window.throughMs),
          limit: String(PAGE_SIZE),
          ...(cursor ? { cursor } : {}),
        };
        const page = providerPage(await read(params));
        if (rows.length + page.rows.length > maxRows) throw new Error("PROVIDER_HISTORY_ROW_BUDGET_EXCEEDED");
        rows.push(...page.rows);
        rowsInWindow += page.rows.length;
        pages += 1;
        totalPages += 1;
        const nextCursor = page.cursor ?? null;
        if (!nextCursor) {
          complete = true;
          checkpoints.push({
            windowStart: new Date(window.fromMs).toISOString(),
            windowEnd: new Date(window.throughMs).toISOString(),
            pages,
            rows: rowsInWindow,
            complete: true,
            nextCursor: null,
          });
          break;
        }
        if (page.rows.length === 0) throw new Error("PROVIDER_HISTORY_EMPTY_PAGE_WITH_CURSOR");
        if (seenCursors.has(nextCursor)) throw new Error("PROVIDER_HISTORY_CURSOR_REPEATED");
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_-]{1,80}$/.test(error.message)
        ? error.message
        : safeFailureCode(error);
      errors.push(`${resource}:${code}`);
      checkpoints.push({
        windowStart: new Date(window.fromMs).toISOString(),
        windowEnd: new Date(window.throughMs).toISOString(),
        pages,
        rows: rowsInWindow,
        complete: false,
        nextCursor: cursor ?? null,
      });
      break;
    }
    if (!complete) break;
  }

  return { rows, checkpoints, errors };
}

export async function readBoundedProviderHistory(
  client: ProviderLedgerReadClient,
  options: BoundedProviderHistoryOptions,
): Promise<BoundedProviderHistoryResult> {
  const fromMs = Date.parse(options.from);
  const throughMs = Date.parse(options.through);
  const nowMs = (options.now ?? new Date()).getTime();
  if (!options.category || !/^[A-Z0-9_-]{1,40}$/.test(options.symbol)
    || !Number.isFinite(fromMs) || !Number.isFinite(throughMs) || throughMs < fromMs || throughMs > nowMs) {
    throw new Error("PROVIDER_HISTORY_WINDOW_INVALID");
  }

  const retentionFloor = nowMs - MAX_HISTORY_AGE_MS;
  const withinProviderRetention = fromMs >= retentionFloor;
  const coveredFromMs = Math.max(fromMs, retentionFloor);
  const maxPages = Math.min(100, Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES));
  const maxRows = Math.min(10_000, Math.max(1, options.maxRows ?? DEFAULT_MAX_ROWS));
  const resources = ["orders", "fills", "positionHistory", "financialRecords"] as const;
  const result = {
    rows: { orders: [], fills: [], positionHistory: [], financialRecords: [] } as Record<ProviderResource, Record<string, unknown>[]>,
    checkpoints: { orders: [], fills: [], positionHistory: [], financialRecords: [] } as Record<ProviderResource, ProviderHistoryCheckpoint[]>,
    errors: [] as string[],
  };

  for (const resource of resources) {
    const resourceResult = await readResource(client, resource, options, coveredFromMs, throughMs, maxPages, maxRows);
    result.rows[resource] = resourceResult.rows;
    result.checkpoints[resource] = resourceResult.checkpoints;
    result.errors.push(...resourceResult.errors);
  }
  if (!withinProviderRetention) result.errors.unshift("coverage:PROVIDER_HISTORY_RETENTION_WINDOW_EXCEEDED");
  const complete = result.errors.length === 0 && resources.every((resource) => result.checkpoints[resource].length > 0 && result.checkpoints[resource].every((checkpoint) => checkpoint.complete));
  return {
    status: complete ? "COMPLETE" : "INCOMPLETE",
    requestedFrom: new Date(fromMs).toISOString(),
    requestedThrough: new Date(throughMs).toISOString(),
    coveredFrom: new Date(coveredFromMs).toISOString(),
    coveredThrough: new Date(throughMs).toISOString(),
    withinProviderRetention,
    rows: result.rows,
    checkpoints: result.checkpoints,
    errors: result.errors,
  };
}
