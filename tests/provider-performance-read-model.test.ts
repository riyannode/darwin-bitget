import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { resolveProviderPerformanceReadModel } from "../src/trading/provider-performance-read-model.js";
import { rebuildProviderPerformance } from "../src/trading/provider-performance.js";
import type { SqlExecutor } from "../src/storage/schema.js";

function memoryExecutor(): { db: DatabaseSync; executor: SqlExecutor } {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE risk_state (state_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const executor: SqlExecutor = {
    sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
      const statement = db.prepare(strings.join("?"));
      const sqlValues = values.map((value) => typeof value === "boolean" ? Number(value) : value);
      return statement.all(...sqlValues) as T[];
    },
  };
  return { db, executor };
}

const staleTotals = {
  source: "PROVIDER_LEDGER" as const,
  closedTrades: 0,
  openTrades: 0,
  totalTrades: 0,
  wins: 0,
  losses: 0,
  breakeven: 0,
  closedEpisodeRealizedPnl: "0",
  verifiedRealizedPnl: "0",
  unresolvedClosedLifecycles: 0,
  dailyPnl: {},
};

const SAMSUNG = {
  lifecycleId: "1485976014620573698",
  origin: "DARWIN" as const,
  status: "CLOSED" as const,
  netProfit: "33.19485709",
  closedAt: "2026-09-22T01:43:06.332Z",
};

describe("provider lifecycle performance read-model cache semantics", () => {
  it("rejects a stale v1 semantic cache and rebuilds from provider lifecycle facts, then reuses the current cache", () => {
    const { db, executor } = memoryExecutor();
    db.prepare("INSERT INTO risk_state (state_key, payload, updated_at) VALUES (?, ?, ?)").run(
      "provider_lifecycle_performance_v1",
      JSON.stringify({ version: 1, signature: "unchanged-ledger-signature", totals: staleTotals }),
      "2026-09-22T02:00:00.000Z",
    );
    const rebuild = () => rebuildProviderPerformance([SAMSUNG]);

    const first = resolveProviderPerformanceReadModel(executor, "unchanged-ledger-signature", "2026-09-24T00:00:00.000Z", rebuild);
    expect(first.cacheHit).toBe(false);
    expect(first.totals).toMatchObject({ closedTrades: 1, wins: 1, closedEpisodeRealizedPnl: "33.19485709", verifiedRealizedPnl: "33.19485709" });

    const second = resolveProviderPerformanceReadModel(executor, "unchanged-ledger-signature", "2026-09-24T00:01:00.000Z", () => {
      throw new Error("unchanged semantic cache should be reused");
    });
    expect(second.cacheHit).toBe(true);
    expect(second.totals).toEqual(first.totals);
    db.close();
  });
});
