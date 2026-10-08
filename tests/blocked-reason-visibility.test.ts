import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { saveExperience, saveJournal } from "../src/storage/store.js";
import { blockedRiskGateResult } from "../src/storage/journal-normalizer.js";
import { TraderAgent } from "../src/agent/agent.js";
import { BitgetClient } from "../src/bitget/client.js";
import { reflect } from "../src/learning/reflection.js";
import type { Decision, DecisionExecutionRecord, EntryDecision, PositionManagementDecision, RiskGateResult, TradeExperience, TradingJournal } from "../src/types.js";

vi.mock("agents", () => ({ Agent: class {} }));

const AT = "2026-10-08T03:00:00.000Z";

function memoryExecutor(db = new DatabaseSync(":memory:")) {
  const executor: SqlExecutor = {
    sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
      const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
      const params = values.map((value) => (typeof value === "boolean" ? Number(value) : value)) as (string | number | null)[];
      const normalized = query.trimStart().toUpperCase();
      if (normalized.startsWith("SELECT") || normalized.startsWith("WITH")) return db.prepare(query).all(...params) as T[];
      db.prepare(query).run(...params);
      return [];
    },
  };
  ensureStorage(executor);
  return { db, executor };
}

function fakeAgent(executor: SqlExecutor, db: DatabaseSync) {
  return {
    sql: executor.sql,
    env: { TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", BITGET_CATEGORY: "USDT-FUTURES", OWNER_CONTROL_TOKEN: "owner-control-test-token" },
    state: { paused: false, runtimeStatus: "ONLINE" },
    ctx: { storage: { transactionSync: <T>(closure: () => T) => { db.exec("BEGIN IMMEDIATE"); try { const value = closure(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } } } },
    ensureActivePolicy: () => ({ paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 5, emergencyStop: false }),
    getTradeHistory: (TraderAgent.prototype as unknown as { getTradeHistory: (url: URL) => Promise<Response> }).getTradeHistory,
    onRequest: TraderAgent.prototype.onRequest,
  };
}

function decision(decisionId: string, cycleId: string): EntryDecision {
  return {
    decisionId, cycleId, action: "OPEN_LONG", positionSide: "LONG", symbol: "SAMSUNGUSDT",
    marginAllocationPct: "40", leverage: "3", reductionPct: null, confidence: 0.42,
    thesis: "blocked proposal", strategyThesis: "bounded strategy",
    supportingFactors: ["volume"], riskFactors: ["drawdown"], evidenceUsed: ["ticker"], lessonsUsed: [],
    createdAt: AT,
  };
}

function managementDecision(decisionId: string, cycleId: string, action: "CLOSE" | "REDUCE" | "INCREASE" | "REVERSE" = "CLOSE"): PositionManagementDecision {
  return {
    ...decision(decisionId, cycleId),
    action,
    reductionPct: action === "REDUCE" ? "50" : null,
    additionalMarginPct: action === "INCREASE" ? "10" : null,
    targetPositionSide: action === "REVERSE" ? "SHORT" : null,
  };
}

function blockedExperience(decisionId: string, overrides: Partial<TradeExperience> = {}): TradeExperience {
  return {
    experienceId: "exp-blocked", symbol: "SAMSUNGUSDT", positionSide: "LONG", action: "OPEN_LONG",
    entryDecisionId: decisionId, entryPrice: "198.02", entryTime: AT, exitDecisionId: "", exitPrice: "0", exitTime: "",
    selectedLeverage: "3", marginAllocationPct: "40", marginAllocated: "400", positionNotional: "1200",
    realizedPnl: "0", realizedPnlPct: "0", maximumFavorableExcursion: "0", maximumAdverseExcursion: "0",
    drawdownContribution: "0", liquidationDistance: "0", entryThesis: "blocked proposal", exitThesis: "",
    evidenceAtEntry: ["ticker"], evidenceAtExit: [], lessonsUsed: [], marketContext: "TREND_UP",
    outcomeStatus: "BLOCKED", lastAction: "OPEN_LONG", ...overrides,
  };
}

function blockedJournal(decisionId: string, codes: string[], overrides: Partial<TradingJournal> = {}): TradingJournal {
  const current = decision(decisionId, "cycle-blocked");
  const record: DecisionExecutionRecord = { decision: current, riskGateResult: { status: "BLOCK", codes, checkedAt: AT } };
  return {
    cycleId: "cycle-blocked", agentVersion: "test", model: "test", mode: "AUTONOMOUS",
    startedAt: AT, completedAt: AT, retrievedLessons: [], createdLessons: [],
    cyclePlan: { positionActions: [], entryActions: [current] },
    executionRecords: [record],
    experienceIds: ["exp-blocked"], experienceId: "exp-blocked",
    ...overrides,
  };
}

function journalWithGate(decisionId: string, result: RiskGateResult, cycleId = "cycle-blocked"): TradingJournal {
  const current = decision(decisionId, cycleId);
  return {
    cycleId, agentVersion: "test", model: "test", mode: "AUTONOMOUS",
    startedAt: AT, completedAt: AT, retrievedLessons: [], createdLessons: [],
    cyclePlan: { positionActions: [], entryActions: [current] },
    executionRecords: [{ decision: current, riskGateResult: result }],
    experienceIds: ["exp-blocked"], experienceId: "exp-blocked",
  };
}

function experienceLinkedJournal(experienceId: string, cycleId: string, positionActions: PositionManagementDecision[], executionRecords: DecisionExecutionRecord[]): TradingJournal {
  return {
    cycleId, agentVersion: "test", model: "test", mode: "AUTONOMOUS",
    startedAt: AT, completedAt: AT, retrievedLessons: [], createdLessons: [],
    cyclePlan: { positionActions, entryActions: [] },
    executionRecords,
    experienceId, experienceIds: [experienceId],
  };
}

async function tradeHistory(executor: SqlExecutor, db: DatabaseSync): Promise<Array<Record<string, unknown>>> {
  const agent = fakeAgent(executor, db) as never;
  const response = await (agent as { onRequest: (request: Request) => Promise<Response> }).onRequest.call(agent, new Request("https://example.test/trade-history?limit=25"));
  expect(response.status).toBe(200);
  return (await response.json() as { trades: Array<Record<string, unknown>> }).trades;
}

describe("blocked proposal risk gate reason", () => {
  it.each(["CLOSE", "REDUCE"] as const)("retrieves a BLOCKED %s decision by exitDecisionId and returns its persisted evaluation", async (action) => {
    const { db, executor } = memoryExecutor();
    const decisionId = `dec-blocked-${action.toLowerCase()}`;
    const codes = ["DAILY_DRAWDOWN", "STALE_EVIDENCE", "MIN_ORDER_AMOUNT"];
    const management = managementDecision(decisionId, "cycle-management", action);
    const journal: TradingJournal = {
      cycleId: "cycle-management", agentVersion: "test", model: "test", mode: "AUTONOMOUS",
      startedAt: AT, completedAt: AT, retrievedLessons: [], createdLessons: [],
      cyclePlan: { positionActions: [management], entryActions: [] },
      executionRecords: [{ decision: management, riskGateResult: { status: "BLOCK", codes, checkedAt: AT } }],
    };
    saveJournal(executor, journal);
    saveExperience(executor, blockedExperience("", {
      experienceId: `exp-blocked-${action.toLowerCase()}`, action, lastAction: action,
      entryDecisionId: "", exitDecisionId: decisionId,
    }), AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED", action, blockedReasonCodes: codes, riskGateCheckedAt: AT });
    db.close();
  });

  it.each(["experienceId", "experienceIds"] as const)("surfaces a BLOCKED INCREASE reason through its unique persisted %s link", async (linkField) => {
    const { db, executor } = memoryExecutor();
    const increase = managementDecision(`dec-increase-${linkField}`, "cycle-increase", "INCREASE");
    const codes = ["MAX_SINGLE_POSITION_MARGIN", "INSUFFICIENT_MARGIN"];
    const reflected = reflect({
      decision: increase, outcome: "RISK_BLOCKED", failureCode: codes.join(","), symbol: increase.symbol,
      marketRegime: "TREND_UP", experienceStatus: "BLOCKED", entryPrice: "198.02", exitPrice: "198.02", now: new Date(AT),
    });
    const experienceId = reflected.experience.experienceId;
    expect(reflected.experience.entryDecisionId).toBe("");
    expect(reflected.experience.exitDecisionId).toBe("");
    const journal = experienceLinkedJournal(experienceId, "cycle-increase", [increase], [
      { decision: increase, riskGateResult: { status: "BLOCK", codes, checkedAt: AT } },
    ]);
    if (linkField === "experienceId") journal.experienceIds = [];
    else delete journal.experienceId;
    saveJournal(executor, journal);
    saveExperience(executor, reflected.experience, AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED", action: "INCREASE", blockedReasonCodes: codes, riskGateCheckedAt: AT });
    db.close();
  });

  it("does not confuse a BLOCKED INCREASE with its prior entry decision", async () => {
    const { db, executor } = memoryExecutor();
    const opened = reflect({
      decision: decision("dec-open-origin", "cycle-open-origin"), outcome: "OPEN", failureCode: "", symbol: "SAMSUNGUSDT",
      marketRegime: "TREND_UP", experienceStatus: "OPEN", entryPrice: "198.02", now: new Date(AT),
    });
    const increase = managementDecision("dec-increase-after-open", "cycle-increase-after-open", "INCREASE");
    const blocked = reflect({
      decision: increase, outcome: "RISK_BLOCKED", failureCode: "MAX_SINGLE_POSITION_MARGIN", symbol: increase.symbol,
      marketRegime: "TREND_UP", experienceStatus: "BLOCKED", entryPrice: "198.02", exitPrice: "198.02",
      existingExperience: opened.experience, now: new Date(AT),
    });
    expect(blocked.experience.entryDecisionId).toBe("dec-open-origin");
    expect(blocked.experience.lastAction).toBe("INCREASE");
    saveJournal(executor, journalWithGate("dec-open-origin", { status: "PASS", codes: [], checkedAt: AT }, "cycle-open-origin"));
    saveJournal(executor, experienceLinkedJournal(blocked.experience.experienceId, "cycle-increase-after-open", [increase], [
      { decision: increase, riskGateResult: { status: "BLOCK", codes: ["MAX_SINGLE_POSITION_MARGIN"], checkedAt: AT } },
    ]));
    saveExperience(executor, blocked.experience, AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED", action: "INCREASE", blockedReasonCodes: ["MAX_SINGLE_POSITION_MARGIN"], riskGateCheckedAt: AT });
    db.close();
  });

  it("omits a BLOCKED INCREASE reason when its linked journal has multiple blocked decisions", async () => {
    const { db, executor } = memoryExecutor();
    const first = managementDecision("dec-increase-a", "cycle-increase-ambiguous", "INCREASE");
    const second = managementDecision("dec-increase-b", "cycle-increase-ambiguous", "INCREASE");
    const reflected = reflect({
      decision: first, outcome: "RISK_BLOCKED", failureCode: "MULTIPLE_CANDIDATE_BLOCKS", symbol: first.symbol,
      marketRegime: "TREND_UP", experienceStatus: "BLOCKED", entryPrice: "198.02", exitPrice: "198.02", now: new Date(AT),
    });
    const experienceId = reflected.experience.experienceId;
    const journal = experienceLinkedJournal(experienceId, "cycle-increase-ambiguous", [first, second], [
      { decision: first, riskGateResult: { status: "BLOCK", codes: ["MAX_SINGLE_POSITION_MARGIN"], checkedAt: AT } },
      { decision: second, riskGateResult: { status: "BLOCK", codes: ["INSUFFICIENT_MARGIN"], checkedAt: AT } },
    ]);
    saveJournal(executor, journal);
    saveExperience(executor, reflected.experience, AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED" });
    expect(trade).not.toHaveProperty("blockedReasonCodes");
    expect(trade).not.toHaveProperty("riskGateCheckedAt");
    db.close();
  });

  it("omits a BLOCKED INCREASE reason when the linked journal has same-action PASS and BLOCK candidates", async () => {
    const { db, executor } = memoryExecutor();
    const first = managementDecision("dec-increase-block", "cycle-increase-mixed", "INCREASE");
    const second = managementDecision("dec-increase-pass", "cycle-increase-mixed", "INCREASE");
    const reflected = reflect({
      decision: first, outcome: "RISK_BLOCKED", failureCode: "MAX_SINGLE_POSITION_MARGIN", symbol: first.symbol,
      marketRegime: "TREND_UP", experienceStatus: "BLOCKED", entryPrice: "198.02", exitPrice: "198.02", now: new Date(AT),
    });
    const journal = experienceLinkedJournal(reflected.experience.experienceId, "cycle-increase-mixed", [first, second], [
      { decision: first, riskGateResult: { status: "BLOCK", codes: ["MAX_SINGLE_POSITION_MARGIN"], checkedAt: AT } },
      { decision: second, riskGateResult: { status: "PASS", codes: [], checkedAt: AT } },
    ]);
    saveJournal(executor, journal);
    saveExperience(executor, reflected.experience, AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED" });
    expect(trade).not.toHaveProperty("blockedReasonCodes");
    expect(trade).not.toHaveProperty("riskGateCheckedAt");
    db.close();
  });

  it.each(["CLOSE", "OPEN_SHORT"] as const)("attributes a blocked REVERSE synthetic %s leg through its persisted execution record", async (blockedAction) => {
    const { db, executor } = memoryExecutor();
    const reverse = managementDecision(`dec-reverse-${blockedAction.toLowerCase()}`, "cycle-reverse", "REVERSE");
    const close: Decision = { ...reverse, decisionId: `${reverse.decisionId}:close`, action: "CLOSE", positionSide: "LONG", marginAllocationPct: "0", reductionPct: "100", additionalMarginPct: null, targetPositionSide: null };
    const open: Decision = { ...reverse, decisionId: `${reverse.decisionId}:open`, action: "OPEN_SHORT", positionSide: "SHORT", reductionPct: null, additionalMarginPct: null, targetPositionSide: null };
    const closeResult: RiskGateResult = blockedAction === "CLOSE"
      ? { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT }
      : { status: "PASS", codes: [], checkedAt: AT };
    const closeRecord: DecisionExecutionRecord = { decision: close, riskGateResult: closeResult, parentDecisionId: reverse.decisionId, parentAction: "REVERSE", parentDecision: reverse };
    const openRecord: DecisionExecutionRecord = { decision: open, riskGateResult: { status: "BLOCK", codes: ["TARGET_SIDE_CAPACITY"], checkedAt: AT }, parentDecisionId: reverse.decisionId, parentAction: "REVERSE", parentDecision: reverse };
    const records = blockedAction === "CLOSE" ? [closeRecord] : [closeRecord, openRecord];
    const blockedDecision = blockedAction === "CLOSE" ? close : open;
    const reflected = reflect({
      decision: blockedDecision, outcome: "RISK_BLOCKED", failureCode: "SYNTHETIC_REVERSE_LEG_BLOCKED",
      symbol: blockedDecision.symbol, marketRegime: "TREND_UP", experienceStatus: "BLOCKED",
      entryPrice: "198.02", exitPrice: "198.02", now: new Date(AT),
    });
    saveJournal(executor, experienceLinkedJournal(reflected.experience.experienceId, "cycle-reverse", [reverse], records));
    saveExperience(executor, reflected.experience, AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED", action: blockedAction, riskGateCheckedAt: AT });
    expect(trade?.blockedReasonCodes).toEqual(blockedAction === "CLOSE" ? ["DAILY_DRAWDOWN"] : ["TARGET_SIDE_CAPACITY"]);
    db.close();
  });

  it("surfaces every persisted gate code on the BLOCKED trade row", async () => {
    const { db, executor } = memoryExecutor();
    const codes = ["DAILY_DRAWDOWN", "STALE_EVIDENCE", "MIN_ORDER_AMOUNT"];
    saveJournal(executor, blockedJournal("dec-1", codes));
    saveExperience(executor, blockedExperience("dec-1"), AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED", blockedReasonCodes: codes, riskGateCheckedAt: AT });
    db.close();
  });

  it("keeps a single persisted gate code intact", async () => {
    const { db, executor } = memoryExecutor();
    saveJournal(executor, blockedJournal("dec-2", ["INSUFFICIENT_MARGIN"]));
    saveExperience(executor, blockedExperience("dec-2"), AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED", blockedReasonCodes: ["INSUFFICIENT_MARGIN"] });
    db.close();
  });

  it("omits the reason entirely when no persisted gate is attributable", async () => {
    const { db, executor } = memoryExecutor();
    saveExperience(executor, blockedExperience("dec-missing"), AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED" });
    expect(trade).not.toHaveProperty("blockedReasonCodes");
    expect(trade).not.toHaveProperty("riskGateCheckedAt");
    db.close();
  });

  it("does not leak a gate result from a PASS evaluation onto a BLOCKED row", async () => {
    const { db, executor } = memoryExecutor();
    const journal = blockedJournal("dec-pass", ["INSUFFICIENT_MARGIN"]);
    const passing: RiskGateResult = { status: "PASS", codes: [], checkedAt: AT };
    journal.executionRecords = [{ decision: journal.cyclePlan!.entryActions[0]!, riskGateResult: passing }];
    saveJournal(executor, journal);
    saveExperience(executor, blockedExperience("dec-pass"), AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED" });
    expect(trade).not.toHaveProperty("blockedReasonCodes");
    db.close();
  });

  it("never attributes a reason to a non-BLOCKED row", () => {
    const journal = blockedJournal("dec-open", ["DAILY_DRAWDOWN"]);
    const open = blockedExperience("dec-open", { outcomeStatus: "OPEN" });
    expect(blockedRiskGateResult(open, [journal])).toBeUndefined();
  });

  it("refuses attribution when two journals disagree about the same decision", () => {
    const journalA = journalWithGate("dec-conflict", { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT });
    const journalB = journalWithGate("dec-conflict", { status: "BLOCK", codes: ["MIN_ORDER_AMOUNT"], checkedAt: AT });
    expect(blockedRiskGateResult(blockedExperience("dec-conflict"), [journalA, journalB])).toBeUndefined();
  });

  it("rejects PASS and BLOCK evaluations for the same decision identity", () => {
    const blocked = { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT } satisfies RiskGateResult;
    const passed = { status: "PASS", codes: [], checkedAt: AT } satisfies RiskGateResult;
    expect(blockedRiskGateResult(blockedExperience("dec-status-conflict"), [
      journalWithGate("dec-status-conflict", blocked), journalWithGate("dec-status-conflict", passed),
    ])).toBeUndefined();
  });

  it("rejects a legacy journal-level PASS conflicting with its execution-record BLOCK", () => {
    const journal = journalWithGate("dec-internal-conflict", { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT });
    journal.decision = journal.cyclePlan!.entryActions[0]!;
    journal.riskGateResult = { status: "PASS", codes: [], checkedAt: AT };
    expect(blockedRiskGateResult(blockedExperience("dec-internal-conflict"), [journal])).toBeUndefined();
  });

  it("rejects evaluations with conflicting persisted decision identity", () => {
    const result = { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT } satisfies RiskGateResult;
    const experience = blockedExperience("dec-identity-conflict");
    expect(blockedRiskGateResult(experience, [
      journalWithGate("dec-identity-conflict", result, "cycle-identity-a"),
      journalWithGate("dec-identity-conflict", result, "cycle-identity-b"),
    ])).toBeUndefined();
  });

  it("rejects a persisted BLOCK whose decision cycle conflicts with its journal cycle", () => {
    const journal = journalWithGate("dec-cycle-mismatch", { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT });
    journal.cycleId = "cycle-container-mismatch";
    expect(blockedRiskGateResult(blockedExperience("dec-cycle-mismatch"), [journal])).toBeUndefined();
  });

  it("rejects BLOCK evaluations with conflicting evaluation timestamps", () => {
    const first = { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT } satisfies RiskGateResult;
    const second = { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: "2026-10-08T03:01:00.000Z" } satisfies RiskGateResult;
    expect(blockedRiskGateResult(blockedExperience("dec-time-conflict"), [
      journalWithGate("dec-time-conflict", first), journalWithGate("dec-time-conflict", second),
    ])).toBeUndefined();
  });

  it("preserves a unique authoritative BLOCK evaluation", () => {
    const result = { status: "BLOCK", codes: ["DAILY_DRAWDOWN", "STALE_EVIDENCE"], checkedAt: AT } satisfies RiskGateResult;
    expect(blockedRiskGateResult(blockedExperience("dec-unique"), [journalWithGate("dec-unique", result)])).toEqual(result);
  });

  it("returns no attribution without a journal or decision identity", () => {
    expect(blockedRiskGateResult(blockedExperience("dec-absent"), [])).toBeUndefined();
    expect(blockedRiskGateResult(blockedExperience("", { experienceId: "exp-no-decision-identity" }), [journalWithGate("dec-unrelated", { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT })])).toBeUndefined();
  });

  it("ignores a gate that reported BLOCK with no codes", () => {
    const journal = blockedJournal("dec-empty", []);
    expect(blockedRiskGateResult(blockedExperience("dec-empty"), [journal])).toBeUndefined();
  });
});