import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AccountSnapshot, Decision, ExecutionResult, TradeExperience, TradingJournal } from "../src/types.js";
import type { SqlExecutor } from "../src/storage/schema.js";
import { bootstrapPositionContexts } from "../src/agent/position-context.js";
import { bootstrapPerformance } from "../src/trading/performance.js";
import { loadJournalsForDecisionIds, loadOpenExperiences, loadRecentJournals } from "../src/storage/store.js";

const observedAt = "2026-09-14T10:00:00.000Z";
const account: AccountSnapshot = { balance: "1000", availableBalance: "900", availableMargin: "900", marginUsage: "100", positionNotional: "300", totalPositionNotional: "300", positionQuantity: "3", portfolioEquity: "1000", positions: [{ symbol: "CRCLUSDT", positionSide: "LONG", quantity: "3", notional: "300", marginAllocated: "100", leverage: "3", entryPrice: "100", unrealizedPnl: "0", realizedPnl: "" }], realizedPnl: "", unrealizedPnl: "0", openOrders: 0, openOrderSymbols: [], observedAt };
const opening: Decision = { decisionId: "old-crcl-open", cycleId: "old-cycle", action: "OPEN_LONG", positionSide: "LONG", symbol: "CRCLUSDT", marginAllocationPct: "10", leverage: "3", reductionPct: null, thesis: "original CRCL entry", strategyThesis: "original CRCL strategy", supportingFactors: ["trend"], riskFactors: ["volatility"], evidenceUsed: ["ticker"], lessonsUsed: [], confidence: 0.8, createdAt: "2026-06-01T10:00:00.000Z" };
const execution: ExecutionResult = { provider: "bitget", providerOrderId: "old-order", clientOrderId: "old-client", symbol: "CRCLUSDT", action: "OPEN_LONG", positionSide: "LONG", providerSide: "buy", tradeSide: "open", marginAllocated: "100", leverage: "3", positionNotional: "300", requestedQuantity: "3", executedQuantity: "3", status: "filled", submittedAt: opening.createdAt, readBackAt: opening.createdAt };
const experience: TradeExperience = { experienceId: "open-crcl-experience", symbol: "CRCLUSDT", positionSide: "LONG", action: "OPEN_LONG", entryDecisionId: opening.decisionId, entryPrice: "100", entryTime: opening.createdAt, exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10", marginAllocated: "100", positionNotional: "300", realizedPnl: "0", realizedPnlPct: "0", maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0", liquidationDistance: "0", entryThesis: "original CRCL entry", exitThesis: "", evidenceAtEntry: ["ticker"], evidenceAtExit: [], lessonsUsed: [], marketContext: "TRENDING_UP", outcomeStatus: "OPEN", realizedPnlVerified: false };
const oldJournal: TradingJournal = { cycleId: opening.cycleId, agentVersion: "1", model: "qwen", mode: "AUTONOMOUS", startedAt: opening.createdAt, completedAt: opening.createdAt, portfolio: account, decision: opening, executionResult: execution, reconciliationResult: { status: "MATCHED", codes: [], execution }, retrievedLessons: [], createdLessons: [] };

function newerJournal(index: number): TradingJournal { return { cycleId: `newer-${index}`, agentVersion: "1", model: "qwen", mode: "AUTONOMOUS", startedAt: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T10:00:00.000Z`, retrievedLessons: [], createdLessons: [] }; }

describe("bounded legacy bootstrap lookup", () => {
  it("recovers a current open lifecycle whose opening is older than 100 newer journals", () => {
    const newer = Array.from({ length: 101 }, (_, index) => ({ payload: JSON.stringify(newerJournal(index)) }));
    const sql = (strings: TemplateStringsArray, ...values: unknown[]): unknown[] => {
      const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
      if (query.includes("outcome_status = 'OPEN'")) return [{ payload: JSON.stringify(experience) }];
      if (query.includes("instr(payload")) return [{ payload: JSON.stringify(oldJournal) }];
      if (query.includes("FROM journals")) return newer;
      if (query.includes("FROM experiences")) return [];
      return [];
    };
    const executor = { sql } as unknown as SqlExecutor;
    const openExperiences = loadOpenExperiences(executor, 100);
    const journals = [...loadRecentJournals(executor, 100), ...loadJournalsForDecisionIds(executor, openExperiences.map((item) => item.entryDecisionId), 100)];
    const uniqueJournals = [...new Map(journals.map((journal) => [journal.cycleId, journal])).values()];
    const performance = bootstrapPerformance(uniqueJournals, openExperiences, observedAt);
    const contexts = bootstrapPositionContexts(uniqueJournals, openExperiences, observedAt);
    expect(uniqueJournals).toHaveLength(102);
    expect(performance.totalTrades).toBe(1);
    expect(performance.openTrades).toBe(1);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ symbol: "CRCLUSDT", positionSide: "LONG", entryDecisionId: "old-crcl-open", entryReasoning: { thesis: "original CRCL entry" } });
  });

  it("executes literal instr matching in SQLite and skips malformed or pathological IDs", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE journals (cycle_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)");
    const payload = (decisionId: string, cycleId: string): string => JSON.stringify({ ...oldJournal, cycleId, decision: { ...opening, decisionId } });
    const rows: Array<[string, string]> = [
      ["normal-uuid", payload("123e4567-e89b-12d3-a456-426614174000", "normal")],
      ["short", payload("legacy-short", "short")],
      ["wildcards", payload("legacy%_wildcard", "wildcards")],
      ["quotes", payload("legacy\"quoted", "quotes")],
      ["malformed", "{\"decisionId\":\"legacy-short\""],
    ];
    const insert = db.prepare("INSERT INTO journals (cycle_id, payload, created_at) VALUES (?, ?, ?)");
    for (const [cycleId, journal] of rows) insert.run(cycleId, journal, "2026-09-14T10:00:00.000Z");
    const queries: string[] = [];
    const executor = { sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] { const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), ""); queries.push(query); const sqliteValues = values.map((value) => typeof value === "boolean" ? (value ? 1 : 0) : value) as (string | number | null)[]; if (query.trimStart().startsWith("SELECT")) return db.prepare(query).all(...sqliteValues) as T[]; db.exec(query); return []; } };
    const found = loadJournalsForDecisionIds(executor, ["123e4567-e89b-12d3-a456-426614174000", "legacy-short", "legacy%_wildcard", "legacy\"quoted", "x".repeat(257)]);
    expect(found.map((journal) => journal.cycleId).sort()).toEqual(["normal", "quotes", "short", "wildcards"]);
    expect(queries.every((query) => !/\b(LIKE|GLOB)\b/i.test(query))).toBe(true);
    expect(queries.every((query) => query.includes("instr(payload, ?)") && query.includes("ORDER BY created_at DESC LIMIT 2"))).toBe(true);
  });
});
