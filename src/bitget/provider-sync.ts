import {
  normalizeProviderFill,
  normalizeProviderFinancialRecord,
  normalizeProviderOrder,
  normalizeProviderPositionHistory,
  providerPage,
  type ProviderLedgerReadParams,
} from "./provider-ledger.js";
import {
  loadProviderSyncState,
  resolveProviderOrigin,
  saveProviderSyncState,
  upsertProviderFill,
  upsertProviderFinancialRecord,
  upsertProviderOrder,
  upsertProviderPositionHistory,
  type ProviderResourceCheckpoint,
  type ProviderSyncCheckpoints,
  type ProviderSyncState,
} from "../storage/provider-ledger.js";
import type { SqlExecutor } from "../storage/schema.js";

const MAX_PROVIDER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PROVIDER_HISTORY_MS = 90 * 24 * 60 * 60 * 1000;
const PROVIDER_HISTORY_SAFETY_MS = 60 * 1000;
const DEFAULT_INITIAL_LOOKBACK_MS = MAX_PROVIDER_HISTORY_MS;
const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OVERLAP_MS = 15 * 60 * 1000;
const MAX_PAGES_PER_WINDOW = 1000;
const DEFAULT_MAX_PAGES_PER_RUN = 1000;
const DEFAULT_MAX_ROWS_PER_RUN = 100_000;

type ResourceName = keyof ProviderSyncCheckpoints;

export interface ProviderLedgerReadClient {
  getOrderHistoryRead(params: ProviderLedgerReadParams): Promise<unknown>;
  getFillHistoryWindowRead(params: ProviderLedgerReadParams): Promise<unknown>;
  getPositionHistoryRead(params: ProviderLedgerReadParams): Promise<unknown>;
  getFinancialRecordsRead(params: ProviderLedgerReadParams): Promise<unknown>;
}

export interface ProviderLedgerSyncOptions {
  category: string;
  mode: "backfill" | "recent";
  now?: Date;
  initialLookbackMs?: number;
  recentWindowMs?: number;
  overlapMs?: number;
  maxPagesPerRun?: number;
  maxRowsPerRun?: number;
}

export interface ProviderLedgerSyncResult {
  status: "SUCCESS" | "PARTIAL";
  category: string;
  observedAt: string;
  truncated: boolean;
  resources: Record<string, { pages: number; rows: number; malformedRows: number }>;
  errors: string[];
}

interface Window {
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
}

interface SyncBudget {
  pages: number;
  rows: number;
  maxPages: number;
  maxRows: number;
}

export async function syncProviderLedger(
  client: ProviderLedgerReadClient,
  executor: SqlExecutor,
  options: ProviderLedgerSyncOptions,
): Promise<ProviderLedgerSyncResult> {
  const now = options.now ?? new Date();
  const observedAt = now.toISOString();
  const previous = loadProviderSyncState(executor, options.category);
  const state = initialSyncState(options.category, observedAt, previous);
  const windows = buildWindows(now.getTime(), options, previous);
  const resources: ProviderLedgerSyncResult["resources"] = {};
  const errors: string[] = [];
  const budget: SyncBudget = {
    pages: 0,
    rows: 0,
    maxPages: Math.max(1, options.maxPagesPerRun ?? DEFAULT_MAX_PAGES_PER_RUN),
    maxRows: Math.max(1, options.maxRowsPerRun ?? DEFAULT_MAX_ROWS_PER_RUN),
  };

  const run = async (name: ResourceName, read: (params: ProviderLedgerReadParams) => Promise<unknown>, processRow: (row: Record<string, unknown>) => boolean): Promise<void> => {
    let totals = { pages: 0, rows: 0, malformedRows: 0 };
    const resumeCheckpoint = state.checkpoints[name];
    const resourceWindows = windowsForResource(windows, resumeCheckpoint);
    try {
      for (const window of resourceWindows) {
        const resumeCursor = resumeCheckpoint && resumeCheckpoint.windowStart === window.startIso && resumeCheckpoint.windowEnd === window.endIso
          ? resumeCheckpoint.cursor
          : undefined;
        const page = await readPaged(read, options.category, window, processRow, budget, resumeCursor, (cursor) => {
          state.checkpoints = {
            ...state.checkpoints,
            [name]: { windowStart: window.startIso, windowEnd: window.endIso, cursor },
          };
          state.lastError = null;
          state.updatedAt = observedAt;
          saveProviderSyncState(executor, state);
        });
        totals = {
          pages: totals.pages + page.pages,
          rows: totals.rows + page.rows,
          malformedRows: totals.malformedRows + page.malformedRows,
        };
        if (page.malformedRows > 0) throw new Error(`PROVIDER_MALFORMED_ROWS_${name}_${page.malformedRows}`);
      }
      resources[name] = { ...totals };
      state.checkpoints = {
        ...state.checkpoints,
        [name]: {
          windowStart: windows[0]?.startIso ?? observedAt,
          windowEnd: windows[windows.length - 1]?.endIso ?? observedAt,
        },
      };
      state.updatedAt = observedAt;
      saveProviderSyncState(executor, state);
    } catch (error) {
      resources[name] = { ...totals };
      const message = `${name}:${safeErrorMessage(error)}`;
      errors.push(message);
      state.lastError = message;
      state.updatedAt = observedAt;
      saveProviderSyncState(executor, state);
    }
  };

  await run("historyOrders", client.getOrderHistoryRead.bind(client), (row) => {
    const origin = resolveProviderOrigin(executor, text(row.orderId), text(row.clientOid), "PROVIDER_EXTERNAL");
    const record = normalizeProviderOrder(row, origin, observedAt);
    if (!record) return false;
    upsertProviderOrder(executor, record, observedAt);
    return true;
  });
  await run("fills", client.getFillHistoryWindowRead.bind(client), (row) => {
    const origin = resolveProviderOrigin(executor, text(row.orderId), text(row.clientOid));
    const record = normalizeProviderFill(row, origin, observedAt);
    if (!record) return false;
    upsertProviderFill(executor, record, observedAt);
    return true;
  });
  await run("positionHistory", client.getPositionHistoryRead.bind(client), (row) => {
    const origin = resolveProviderOrigin(executor, text(row.orderId), text(row.clientOid));
    const record = normalizeProviderPositionHistory(row, observedAt, origin);
    if (!record) return false;
    upsertProviderPositionHistory(executor, record, observedAt);
    return true;
  });
  await run("financialRecords", client.getFinancialRecordsRead.bind(client), (row) => {
    const origin = resolveProviderOrigin(executor, text(row.orderId), text(row.clientOid));
    const record = normalizeProviderFinancialRecord(row, observedAt, origin);
    if (!record) return false;
    upsertProviderFinancialRecord(executor, record, observedAt);
    return true;
  });

  const allResourcesCompleted = errors.length === 0 && Object.keys(resources).length === 4;
  state.lastSuccessfulSyncAt = allResourcesCompleted ? observedAt : previous?.lastSuccessfulSyncAt ?? null;
  state.lastError = errors.length > 0 ? errors.join("; ") : null;
  state.updatedAt = observedAt;
  saveProviderSyncState(executor, state);

  return {
    status: errors.length > 0 ? "PARTIAL" : "SUCCESS",
    category: options.category,
    observedAt,
    truncated: errors.some((error) => /BUDGET_EXCEEDED|PAGE_LIMIT_EXCEEDED/.test(error)),
    resources,
    errors,
  };
}

async function readPaged(
  read: (params: ProviderLedgerReadParams) => Promise<unknown>,
  category: string,
  window: Window,
  processRow: (row: Record<string, unknown>) => boolean,
  budget: SyncBudget,
  startingCursor: string | undefined,
  onCursor: (cursor: string) => void,
): Promise<{ pages: number; rows: number; malformedRows: number }> {
  let cursor: string | undefined = startingCursor;
  const seenCursors = new Set<string>();
  let pages = 0;
  let rows = 0;
  let malformedRows = 0;
  while (true) {
    if (pages >= MAX_PAGES_PER_WINDOW || budget.pages >= budget.maxPages) throw new Error("PROVIDER_PAGE_BUDGET_EXCEEDED");
    if (cursor && seenCursors.has(cursor)) throw new Error("PROVIDER_CURSOR_REPEATED");
    if (cursor) seenCursors.add(cursor);
    const params: ProviderLedgerReadParams = {
      category,
      startTime: String(window.startMs),
      endTime: String(window.endMs),
      limit: "100",
      ...(cursor ? { cursor } : {}),
    };
    const response = providerPage(await read(params));
    if (budget.rows + response.rows.length > budget.maxRows) throw new Error("PROVIDER_ROW_BUDGET_EXCEEDED");
    pages += 1;
    budget.pages += 1;
    for (const row of response.rows) {
      rows += 1;
      budget.rows += 1;
      if (!processRow(row)) malformedRows += 1;
    }
    if (malformedRows > 0) throw new Error(`PROVIDER_MALFORMED_ROWS_${malformedRows}`);
    if (!response.cursor) break;
    cursor = response.cursor;
    onCursor(cursor);
  }
  return { pages, rows, malformedRows };
}

function buildWindows(nowMs: number, options: ProviderLedgerSyncOptions, previous: ProviderSyncState | null): Window[] {
  const overlapMs = Math.max(0, Math.min(options.overlapMs ?? DEFAULT_OVERLAP_MS, MAX_PROVIDER_WINDOW_MS - 1));
  const lookbackMs = options.mode === "backfill"
    ? Math.min(options.initialLookbackMs ?? DEFAULT_INITIAL_LOOKBACK_MS, MAX_PROVIDER_HISTORY_MS)
    : Math.min(options.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS, MAX_PROVIDER_WINDOW_MS);
  const previousMs = previous?.lastSuccessfulSyncAt ? Date.parse(previous.lastSuccessfulSyncAt) : NaN;
  const historyFloorMs = nowMs - MAX_PROVIDER_HISTORY_MS + PROVIDER_HISTORY_SAFETY_MS;
  const requestedStartMs = Number.isFinite(previousMs) && options.mode === "recent" ? previousMs - overlapMs : nowMs - lookbackMs;
  const startMs = Math.max(0, historyFloorMs, requestedStartMs);
  const windows: Window[] = [];
  let cursor = startMs;
  while (cursor < nowMs) {
    const endMs = Math.min(nowMs, cursor + MAX_PROVIDER_WINDOW_MS);
    windows.push({ startMs: cursor, endMs, startIso: new Date(cursor).toISOString(), endIso: new Date(endMs).toISOString() });
    if (endMs >= nowMs) break;
    const next = endMs - overlapMs;
    if (next <= cursor) throw new Error("PROVIDER_WINDOW_NOT_ADVANCING");
    cursor = next;
  }
  if (windows.length === 0) {
    const iso = new Date(nowMs).toISOString();
    windows.push({ startMs: nowMs, endMs: nowMs, startIso: iso, endIso: iso });
  }
  return windows;
}

function windowsForResource(windows: Window[], checkpoint: ProviderResourceCheckpoint | undefined): Window[] {
  if (!checkpoint?.cursor) return windows;
  const startMs = Date.parse(checkpoint.windowStart);
  const endMs = Date.parse(checkpoint.windowEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return windows;
  const resumeWindow = { startMs, endMs, startIso: checkpoint.windowStart, endIso: checkpoint.windowEnd };
  return [resumeWindow, ...windows.filter((window) => window.startIso !== resumeWindow.startIso || window.endIso !== resumeWindow.endIso)];
}

function initialSyncState(category: string, updatedAt: string, previous: ProviderSyncState | null): ProviderSyncState {
  return previous ?? {
    category,
    checkpoints: {} as ProviderSyncCheckpoints,
    lastSuccessfulSyncAt: null,
    lastReconciliationAt: null,
    lastError: null,
    updatedAt,
  };
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : text(error);
  return raw
    .replace(/(ACCESS-(?:KEY|SIGN|PASSPHRASE|TIMESTAMP)|apiKey|secretKey|passphrase|authorization)(\s*[=:]\s*)(?:bearer\s+)?[^,;\s]+/gi, "$1$2REDACTED")
    .replace(/\bbearer\s+[^,;\s]+/gi, "Bearer REDACTED")
    .slice(0, 240) || "PROVIDER_SYNC_FAILED";
}
