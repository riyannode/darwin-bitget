import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { loadProviderDataRevisions } from "../src/storage/provider-ledger.js";
import { resolveProviderPerformanceReadModel } from "../src/trading/provider-performance-read-model.js";
import { resolveExternalFlowReadModel, type FinancialFlowCategoryState } from "../src/trading/external-flow-read-model.js";

const TOTALS = {
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

function fixture() {
  const db = new DatabaseSync(":memory:");
  const executor: SqlExecutor = {
    sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
      const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
      return db.prepare(query).all(...values.map((value) => typeof value === "boolean" ? Number(value) : value)) as T[];
    },
  };
  ensureStorage(executor);
  return { db, executor };
}

function category(revision: number, time: string): FinancialFlowCategoryState & { checkpoint: string } {
  return {
    category: "USDT-FUTURES",
    complete: true,
    lastError: null,
    revision,
    updatedAt: time,
    lastSuccessfulSyncAt: time,
    coveredFrom: "2026-01-01T00:00:00.000Z",
    coveredThrough: time,
    financialRecordCount: 0,
    checkpoint: time,
  };
}

describe("provider data-semantic cache revisions", () => {
  it("keeps both read-model caches on a hit when sync bookkeeping changes without provider facts", () => {
    const { db, executor } = fixture();
    const revisions = loadProviderDataRevisions(executor, ["USDT-FUTURES"]).get("USDT-FUTURES")!;
    const performanceRebuild = vi.fn(() => TOTALS);
    const performanceSignature = `lifecycle:${revisions.lifecycleRevision}:${revisions.identityRevision}`;
    resolveProviderPerformanceReadModel(executor, performanceSignature, "t1", performanceRebuild);
    const perfHit = resolveProviderPerformanceReadModel(executor, performanceSignature, "t2", performanceRebuild);
    expect(perfHit.cacheHit).toBe(true);
    expect(performanceRebuild).toHaveBeenCalledTimes(1);

    const flowRebuild = () => resolveExternalFlowReadModel(executor, "2026-01-01T00:00:00.000Z", "1000", [category(revisions.financialRevision, "t1")], ["USDT-FUTURES"], "t1");
    expect(flowRebuild().cacheHit).toBe(false);
    db.prepare("INSERT INTO provider_sync_state(category, checkpoint_json, updated_at, revision) VALUES ('USDT-FUTURES', '{}', 't1', 1)").run();
    db.prepare("UPDATE provider_sync_state SET updated_at=?, last_successful_sync_at=?, checkpoint_json=?, revision=revision+1 WHERE category=?")
      .run("t2", "t2", '{"checkpoints":{"financialRecords":{"cursor":"later"}}}', "USDT-FUTURES");
    const flowHit = resolveExternalFlowReadModel(executor, "2026-01-01T00:00:00.000Z", "1000", [category(revisions.financialRevision, "t2")], ["USDT-FUTURES"], "t2");
    expect(flowHit.cacheHit).toBe(true);
    expect(flowHit.recordsRead).toBe(0);
    db.close();
  });

  it("invalidates lifecycle performance only when normalized lifecycle facts materially change", () => {
    const { db, executor } = fixture();
    const signature = () => {
      const revisions = loadProviderDataRevisions(executor, ["USDT-FUTURES"]).get("USDT-FUTURES")!;
      return `lifecycle:${revisions.lifecycleRevision}:${revisions.identityRevision}`;
    };
    const rebuild = vi.fn(() => TOTALS);
    resolveProviderPerformanceReadModel(executor, signature(), "t1", rebuild);
    db.prepare(`INSERT INTO provider_position_history (
      provider_position_history_key, provider_position_history_id, category, symbol, position_side, opening_time, closing_time,
      closing_quantity, net_profit, origin, raw_provider_json, first_seen_at, last_seen_at
    ) VALUES ('key-1','id-1','USDT-FUTURES','BTCUSDT','LONG','2026-02-01T00:00:00.000Z','2026-02-02T00:00:00.000Z','1','2','DARWIN','{}','t1','t1')`).run();
    resolveProviderPerformanceReadModel(executor, signature(), "t2", rebuild);
    expect(rebuild).toHaveBeenCalledTimes(2);
    db.prepare("UPDATE provider_position_history SET last_seen_at='t3', raw_provider_json='{\"observed\":true}' WHERE provider_position_history_key='key-1'").run();
    const third = resolveProviderPerformanceReadModel(executor, signature(), "t3", rebuild);
    expect(third.cacheHit).toBe(true);
    expect(rebuild).toHaveBeenCalledTimes(2);
    db.prepare("UPDATE provider_position_history SET net_profit='3' WHERE provider_position_history_key='key-1'").run();
    resolveProviderPerformanceReadModel(executor, signature(), "t4", rebuild);
    expect(rebuild).toHaveBeenCalledTimes(3);
    db.close();
  });

  it("bounds financial replay using the timestamp-order index", () => {
    const { db } = fixture();
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT type, amount, fee, coin FROM provider_financial_records INDEXED BY provider_financial_records_timestamp_category_key_idx WHERE category IN (SELECT value FROM json_each(?)) AND provider_timestamp >= ? ORDER BY provider_timestamp, category, provider_record_key LIMIT 50001`).all('["USDT-FUTURES","COIN-FUTURES"]', "2026-01-01T00:00:00.000Z") as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes("provider_financial_records_timestamp_category_key_idx") && detail.includes("provider_timestamp>?"))).toBe(true);
    expect(plan.some(({ detail }) => detail.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(false);
    db.close();
  });

  it("invalidates external-flow replay when a normalized financial fact changes", () => {
    const { db, executor } = fixture();
    const revision = () => loadProviderDataRevisions(executor, ["USDT-FUTURES"]).get("USDT-FUTURES")!.financialRevision;
    const resolve = (updatedAt: string) => resolveExternalFlowReadModel(
      executor,
      "2026-01-01T00:00:00.000Z",
      "1000",
      [category(revision(), updatedAt)],
      ["USDT-FUTURES"],
      updatedAt,
    );
    expect(resolve("t1").cacheHit).toBe(false);
    db.prepare(`INSERT INTO provider_financial_records (
      provider_record_key, category, type, coin, amount, fee, provider_timestamp, origin, raw_provider_json, first_seen_at, last_seen_at
    ) VALUES ('record-1','USDT-FUTURES','deposit','USDT','10','0','2026-02-01T00:00:00.000Z','PROVIDER_EXTERNAL','{}','t1','t1')`).run();
    const changed = resolve("t2");
    expect(changed.cacheHit).toBe(false);
    expect(changed.recordsRead).toBe(1);
    db.prepare("UPDATE provider_financial_records SET last_seen_at='t3', raw_provider_json='{\"observed\":true}' WHERE provider_record_key='record-1'").run();
    expect(resolve("t3").cacheHit).toBe(true);
    db.prepare("UPDATE provider_financial_records SET amount='11' WHERE provider_record_key='record-1'").run();
    expect(resolve("t4").cacheHit).toBe(false);
    db.close();
  });
});
