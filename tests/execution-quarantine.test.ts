import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { clearExecutionQuarantine, loadExecutionQuarantines, saveExecutionQuarantine } from "../src/storage/store.js";

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
});
