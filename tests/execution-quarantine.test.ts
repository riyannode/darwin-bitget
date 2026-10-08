import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { clearExecutionQuarantine, loadExecutionQuarantines, loadExecutionQuarantineResolution, recordExecutionQuarantineResolution, saveExecutionQuarantine, saveEvent, saveJournal } from "../src/storage/store.js";
import { loadExecutionQuarantineDiagnostics } from "../src/storage/execution-quarantine-diagnostics.js";
import { upsertProviderFill, upsertProviderOrder } from "../src/storage/provider-ledger.js";
import type { TradingJournal } from "../src/types.js";

function memoryExecutor(): { db: DatabaseSync; executor: SqlExecutor } {
  const db = new DatabaseSync(":memory:");
  const executor: SqlExecutor = {
    sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
      const query = strings.reduce((text, part, index) => text + part + (index < values.length ? "?" : ""), "");
      return db.prepare(query).all(...values.map((value) => typeof value === "boolean" ? Number(value) : value)) as T[];
    },
  };
  ensureStorage(executor);
  return { db, executor };
}

const quarantine = (symbol: string, decisionId: string) => ({
  symbol,
  decisionId,
  cycleId: `cycle-${decisionId}`,
  clientOrderId: `order-${decisionId}`,
  reason: "POSITION_READBACK_UNAVAILABLE",
  createdAt: "2026-10-04T00:00:00.000Z",
});

describe("durable execution quarantines", () => {
  it("persists per-symbol unresolved executions and clears only an exact reconciled identity", () => {
    const { db, executor } = memoryExecutor();
    try {
      const mstr = quarantine("MSTRUSDT", "decision-mstr");
      const hood = quarantine("HOODUSDT", "decision-hood");
      saveExecutionQuarantine(executor, mstr);
      saveExecutionQuarantine(executor, hood);

      expect(loadExecutionQuarantines(executor)).toEqual([mstr, hood]);
      expect(clearExecutionQuarantine(executor, { ...mstr, clientOrderId: "wrong-order" }, "2026-10-04T00:01:00.000Z")).toBe(false);
      expect(loadExecutionQuarantines(executor)).toEqual([mstr, hood]);
      expect(clearExecutionQuarantine(executor, mstr, "2026-10-04T00:01:00.000Z")).toBe(true);
      expect(loadExecutionQuarantines(executor)).toEqual([hood]);
      expect(db.prepare("SELECT state_key FROM risk_state WHERE state_key = 'unresolved_execution_quarantine'").get()).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("stores one idempotent resolution per exact quarantine identity and rejects conflicting provider IDs", () => {
    const { db, executor } = memoryExecutor();
    try {
      const resolution = {
        symbol: "CRCLUSDT",
        decisionId: "decision-crcl",
        cycleId: "cycle-crcl",
        clientOrderId: "client-crcl",
        providerOrderId: "provider-crcl",
        resolvedAt: "2026-10-07T00:00:00.000Z",
      };
      recordExecutionQuarantineResolution(executor, resolution);
      recordExecutionQuarantineResolution(executor, { ...resolution, resolvedAt: "2026-10-07T00:01:00.000Z" });
      expect(loadExecutionQuarantineResolution(executor, resolution)).toEqual(resolution);
      expect(() => recordExecutionQuarantineResolution(executor, { ...resolution, providerOrderId: "provider-other" })).toThrow("EXECUTION_QUARANTINE_RESOLUTION_IDENTITY_CONFLICT");
    } finally {
      db.close();
    }
  });

  it("joins diagnostics to the exact persisted quarantine identity, journal, and provider ledger rows", () => {
    const { db, executor } = memoryExecutor();
    try {
      const active = quarantine("CRCLUSDT", "decision-crcl");
      const journal = {
        cycleId: active.cycleId,
        mode: "AUTONOMOUS",
        startedAt: "2026-10-07T00:00:00.000Z",
        completedAt: "2026-10-07T00:01:00.000Z",
        executionRecords: [{
          decision: { decisionId: active.decisionId, cycleId: active.cycleId, symbol: active.symbol, action: "OPEN_LONG", positionSide: "LONG" },
          executionResult: { status: "filled", providerOrderId: "provider-crcl", clientOrderId: active.clientOrderId, tradeSide: "open", executedQuantity: "3", averageFillPrice: "100", submittedAt: active.createdAt, readBackAt: "2026-10-07T00:00:10.000Z" },
          reconciliationResult: { status: "MISMATCH", codes: ["POSITION_READBACK_UNAVAILABLE"], execution: { status: "filled" } },
        }],
      } as unknown as TradingJournal;
      saveExecutionQuarantine(executor, active);
      saveJournal(executor, journal);
      saveEvent(executor, { eventId: "event-quarantine", type: "EXECUTION_QUARANTINED", cycleId: active.cycleId, createdAt: active.createdAt, metadata: { decisionId: active.decisionId, clientOrderId: active.clientOrderId, symbol: active.symbol } });
      upsertProviderOrder(executor, {
        providerOrderId: "provider-crcl", clientOid: active.clientOrderId, category: "USDT-FUTURES", symbol: active.symbol,
        side: "buy", posSide: "long", tradeSide: "open", reduceOnly: "NO", orderType: "market", qty: "3", cumExecQty: "3",
        cumExecValue: "300", avgPrice: "100", orderStatus: "filled", feeTotal: null, feeDetailsJson: null,
        createdTime: active.createdAt, updatedTime: active.createdAt, origin: "DARWIN", rawProviderJson: "{}",
      }, "2026-10-07T00:02:00.000Z");
      upsertProviderFill(executor, {
        execId: "fill-crcl", providerOrderId: "provider-crcl", clientOid: active.clientOrderId, category: "USDT-FUTURES", symbol: active.symbol,
        side: "buy", posSide: "long", tradeSide: "open", execQty: "3", execPrice: "100", execValue: "300", execPnl: "0",
        feeTotal: null, feeDetailsJson: null, createdTime: active.createdAt, updatedTime: active.createdAt, origin: "DARWIN", rawProviderJson: "{}",
      }, "2026-10-07T00:02:00.000Z");

      const [diagnostic] = loadExecutionQuarantineDiagnostics(executor, ["CRCLUSDT"], "USDT-FUTURES", Date.parse(active.createdAt) + 3_600_000);
      expect(diagnostic).toMatchObject({
        identity: { symbol: "CRCLUSDT", cycleId: active.cycleId, decisionId: active.decisionId, clientOrderId: active.clientOrderId },
        reason: active.reason,
        ageSeconds: 3600,
        sourceJournal: { found: true, cycleId: active.cycleId },
        decision: { action: "OPEN_LONG", positionSide: "LONG" },
        executionResult: { status: "filled", providerOrderId: "provider-crcl", executedQuantity: "3" },
        reconciliationResult: { status: "MISMATCH", codes: ["POSITION_READBACK_UNAVAILABLE"] },
        reconciliationRecords: [{ eventId: "event-quarantine", type: "EXECUTION_QUARANTINED" }],
        providerLedger: {
          orders: [{ providerOrderId: "provider-crcl", identityMatch: true, origin: "DARWIN" }],
          fills: [{ fillId: "fill-crcl", identityMatch: true, origin: "DARWIN" }],
        },
      });
      expect(loadExecutionQuarantineDiagnostics(executor, ["MSTRUSDT"], "USDT-FUTURES")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
