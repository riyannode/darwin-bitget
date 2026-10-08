import type { DecisionExecutionRecord, PositionSide } from "../types.js";
import { normalizeCycleDecisions } from "./journal-normalizer.js";
import { loadExecutionQuarantineResolution, loadExecutionQuarantines, loadJournalForExactDecisionCycle, type ExecutionQuarantine, type ExecutionQuarantineResolution } from "./store.js";
import type { SqlExecutor } from "./schema.js";

const MAX_DIAGNOSTIC_QUARANTINES = 20;
const MAX_PROVIDER_ORDERS = 5;
const MAX_PROVIDER_FILLS = 20;
const MAX_RECONCILIATION_EVENTS = 20;

interface ProviderOrderRow {
  provider_order_id: string;
  client_oid: string | null;
  symbol: string;
  side: string;
  pos_side: string | null;
  trade_side: string | null;
  qty: string;
  cum_exec_qty: string;
  avg_price: string | null;
  order_status: string;
  created_time: string;
  origin: string;
  last_seen_at: string;
}

interface ProviderFillRow {
  exec_id: string;
  provider_order_id: string;
  client_oid: string | null;
  symbol: string;
  side: string;
  pos_side: string | null;
  trade_side: string | null;
  exec_qty: string;
  exec_price: string;
  created_time: string;
  origin: string;
  last_seen_at: string;
}

interface EventRow {
  event_id: string;
  event_type: string;
  cycle_id: string;
  payload: string;
  created_at: string;
}

export interface ExecutionQuarantineDiagnostic {
  identity: Pick<ExecutionQuarantine, "symbol" | "cycleId" | "decisionId" | "clientOrderId">;
  reason: string;
  createdAt: string;
  ageSeconds: number | null;
  sourceJournal: null | { found: true; cycleId: string; startedAt: string; completedAt: string | null };
  decision: null | { action: string; positionSide: PositionSide | null };
  executionResult: null | (Pick<NonNullable<DecisionExecutionRecord["executionResult"]>, "status" | "clientOrderId" | "providerSide" | "tradeSide" | "executedQuantity" | "submittedAt" | "readBackAt"> & Partial<Pick<NonNullable<DecisionExecutionRecord["executionResult"]>, "providerOrderId" | "averageFillPrice">>);
  reconciliationResult: null | { status: string; codes: string[] };
  reconciliationRecords: Array<{ eventId: string; type: string; createdAt: string; metadata: Record<string, string> }>;
  priorResolution: ExecutionQuarantineResolution | null;
  providerLedger: {
    orders: Array<{
      providerOrderId: string; clientOrderId: string | null; symbol: string; side: string; positionSide: string | null;
      tradeSide: string | null; quantity: string; executedQuantity: string; averageFillPrice: string | null;
      status: string; createdAt: string; lastSeenAt: string; origin: string; identityMatch: boolean;
    }>;
    fills: Array<{
      fillId: string; providerOrderId: string; clientOrderId: string | null; symbol: string; side: string;
      positionSide: string | null; tradeSide: string | null; quantity: string; price: string; createdAt: string;
      lastSeenAt: string; origin: string; identityMatch: boolean;
    }>;
  };
}

export function loadExecutionQuarantineDiagnostics(
  executor: SqlExecutor,
  symbols: readonly string[],
  category: string,
  nowMs = Date.now(),
): ExecutionQuarantineDiagnostic[] {
  const requested = new Set(symbols);
  const quarantines = loadExecutionQuarantines(executor).filter((entry) => requested.has(entry.symbol));
  if (quarantines.length > MAX_DIAGNOSTIC_QUARANTINES) throw new Error("EXECUTION_QUARANTINE_DIAGNOSTICS_LIMIT_EXCEEDED");

  return quarantines.map((quarantine) => {
    const identity = {
      symbol: quarantine.symbol,
      cycleId: quarantine.cycleId,
      decisionId: quarantine.decisionId,
      clientOrderId: quarantine.clientOrderId,
    };
    const journal = loadJournalForExactDecisionCycle(executor, quarantine.cycleId, quarantine.decisionId);
    const executionRecord = journal
      ? normalizeCycleDecisions(journal).records.find((record) => record.decision.decisionId === quarantine.decisionId)
      : undefined;
    const execution = executionRecord?.executionResult ?? null;
    const expectedProviderOrderId = execution?.providerOrderId ?? null;
    const orderRows = executor.sql<ProviderOrderRow>`
      SELECT provider_order_id, client_oid, symbol, side, pos_side, trade_side, qty, cum_exec_qty,
        avg_price, order_status, created_time, origin, last_seen_at
      FROM provider_orders
      WHERE category = ${category}
        AND (client_oid = ${quarantine.clientOrderId} OR provider_order_id = ${expectedProviderOrderId ?? ""})
      ORDER BY created_time DESC, provider_order_id
      LIMIT ${MAX_PROVIDER_ORDERS}
    `;
    const orderIds = [...new Set([...orderRows.map((row) => row.provider_order_id), ...(expectedProviderOrderId ? [expectedProviderOrderId] : [])])];
    const fills = executor.sql<ProviderFillRow>`
      SELECT exec_id, provider_order_id, client_oid, symbol, side, pos_side, trade_side, exec_qty,
        exec_price, created_time, origin, last_seen_at
      FROM provider_fills
      WHERE category = ${category}
        AND (client_oid = ${quarantine.clientOrderId}
          OR provider_order_id IN (SELECT value FROM json_each(${JSON.stringify(orderIds)})))
      ORDER BY created_time, exec_id
      LIMIT ${MAX_PROVIDER_FILLS}
    `;
    const eventRows = executor.sql<EventRow>`
      SELECT event_id, event_type, cycle_id, payload, created_at FROM events
      WHERE cycle_id = ${quarantine.cycleId}
        AND event_type IN ('EXECUTION_QUARANTINED', 'EXECUTION_QUARANTINE_CLEARED', 'LATE_EXECUTION_RECONCILED')
      ORDER BY created_at, event_id
      LIMIT ${MAX_RECONCILIATION_EVENTS}
    `;
    const reconciliationRecords = eventRows.flatMap((row) => {
      try {
        const event = JSON.parse(row.payload) as { metadata?: Record<string, unknown> };
        const metadata = event.metadata;
        if (!metadata || metadata.decisionId !== quarantine.decisionId
          || (metadata.clientOrderId !== undefined && metadata.clientOrderId !== quarantine.clientOrderId)) return [];
        return [{
          eventId: row.event_id,
          type: row.event_type,
          createdAt: row.created_at,
          metadata: Object.fromEntries(Object.entries(metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        }];
      } catch {
        return [];
      }
    });

    const createdAtMs = Date.parse(quarantine.createdAt);
    return {
      identity,
      reason: quarantine.reason,
      createdAt: quarantine.createdAt,
      ageSeconds: Number.isFinite(createdAtMs) ? Math.max(0, Math.floor((nowMs - createdAtMs) / 1000)) : null,
      sourceJournal: journal ? { found: true as const, cycleId: journal.cycleId, startedAt: journal.startedAt, completedAt: journal.completedAt ?? null } : null,
      decision: executionRecord ? { action: executionRecord.decision.action, positionSide: executionRecord.decision.positionSide ?? null } : null,
      executionResult: execution ? {
        status: execution.status,
        ...(execution.providerOrderId ? { providerOrderId: execution.providerOrderId } : {}),
        clientOrderId: execution.clientOrderId,
        providerSide: execution.providerSide,
        tradeSide: execution.tradeSide,
        executedQuantity: execution.executedQuantity,
        ...(execution.averageFillPrice ? { averageFillPrice: execution.averageFillPrice } : {}),
        submittedAt: execution.submittedAt,
        readBackAt: execution.readBackAt,
      } : null,
      reconciliationResult: executionRecord?.reconciliationResult
        ? { status: executionRecord.reconciliationResult.status, codes: [...executionRecord.reconciliationResult.codes] }
        : null,
      reconciliationRecords,
      priorResolution: loadExecutionQuarantineResolution(executor, identity),
      providerLedger: {
        orders: orderRows.map((row) => ({
          providerOrderId: row.provider_order_id,
          clientOrderId: row.client_oid,
          symbol: row.symbol,
          side: row.side,
          positionSide: row.pos_side,
          tradeSide: row.trade_side,
          quantity: row.qty,
          executedQuantity: row.cum_exec_qty,
          averageFillPrice: row.avg_price,
          status: row.order_status,
          createdAt: row.created_time,
          lastSeenAt: row.last_seen_at,
          origin: row.origin,
          identityMatch: row.client_oid === quarantine.clientOrderId
            && (!expectedProviderOrderId || row.provider_order_id === expectedProviderOrderId)
            && row.symbol === quarantine.symbol,
        })),
        fills: fills.map((row) => ({
          fillId: row.exec_id,
          providerOrderId: row.provider_order_id,
          clientOrderId: row.client_oid,
          symbol: row.symbol,
          side: row.side,
          positionSide: row.pos_side,
          tradeSide: row.trade_side,
          quantity: row.exec_qty,
          price: row.exec_price,
          createdAt: row.created_time,
          lastSeenAt: row.last_seen_at,
          origin: row.origin,
          identityMatch: row.client_oid === quarantine.clientOrderId
            && (!expectedProviderOrderId || row.provider_order_id === expectedProviderOrderId)
            && row.symbol === quarantine.symbol,
        })),
      },
    };
  });
}
