import { describe, expect, it } from "vitest";
import { calculateNetPnlSinceBaseline, calculateVerifiedExternalFlows, classifyFinancialRecordType, isFinancialRecordCoverageComplete, BITGET_UTA_FINANCIAL_RECORD_CLASSIFICATION } from "../src/trading/external-flow.js";
import { BITGET_UTA_FINANCIAL_RECORD_TYPES_2026_09_23 } from "./fixtures/bitget-uta-financial-record-types-2026-09-23.js";

const completeCategories = ["USDT-FUTURES", "OTHER", "SPOT", "MARGIN", "COIN-FUTURES", "USDC-FUTURES"]
  .map(() => ({ complete: true, lastError: null }));

describe("Bitget financial record external-flow accounting", () => {
  it("matches the pinned complete official UTA financial-record enum snapshot", () => {
    const expected = [...new Set(BITGET_UTA_FINANCIAL_RECORD_TYPES_2026_09_23)].sort();
    expect(BITGET_UTA_FINANCIAL_RECORD_TYPES_2026_09_23).toHaveLength(154);
    expect(expected).toHaveLength(154);
    expect(Object.keys(BITGET_UTA_FINANCIAL_RECORD_CLASSIFICATION).sort()).toEqual(expected);
    for (const type of expected) expect(classifyFinancialRecordType(type), type).not.toBe("UNKNOWN");
  });

  it("classifies documented types by exact enum and excludes trading, fees, and RWA PnL components", () => {
    expect(classifyFinancialRecordType("TRANSFER_IN")).toBe("EXTERNAL_INFLOW");
    expect(classifyFinancialRecordType("ORDER_DEALT_FROZEN_OUT")).toBe("INTERNAL_NON_FLOW");
    expect(classifyFinancialRecordType("CONTRACT_MAIN_SETTLE_FEE_USER_OUT")).toBe("TRADING_OR_PNL_COMPONENT");
    expect(classifyFinancialRecordType("RWA_CONTRACT_REBASE_USER_OPEN_LONG")).toBe("TRADING_OR_PNL_COMPONENT");
    expect(classifyFinancialRecordType("ORDER_DEALT_FROZEN_OUT_SUFFIX")).toBe("UNKNOWN");
  });

  it("verifies six-category USDT flow coverage and computes the account PnL formula exactly", () => {
    const records = [
      { type: "TRANSFER_IN", amount: "100", fee: "0", coin: "USDT" },
      { type: "TRANSFER_OUT", amount: "-25", fee: "0", coin: "USDT" },
      { type: "ORDER_DEALT_IN", amount: "-500", fee: "0", coin: "USDT" },
      { type: "CONTRACT_MAIN_SETTLE_FEE_USER_OUT", amount: "-1.25", fee: "0", coin: "USDT" },
      { type: "RWA_CONTRACT_REBASE_USER_OPEN_LONG", amount: "0", fee: "0", coin: "USDT" },
      { type: "ORDER_DEALT_FROZEN_OUT", amount: "-4", fee: "0", coin: "USDT" },
    ];
    const flows = calculateVerifiedExternalFlows(records, completeCategories);
    expect(flows).toEqual({ status: "VERIFIED", netExternalInflows: "75", unknownTypes: [] });
    expect(calculateNetPnlSinceBaseline("1150", "1000", flows)).toBe("75");
  });

  it("classifies all August 13, 2026 UTA financial-record enum additions exactly", () => {
    const expected = new Map<string, string>([
      ["RISK_LIQ_DEFAULT_USER_IN", "TRADING_OR_PNL_COMPONENT"],
      ["FIXED_RISK_LIQ_DEFAULT_USER_IN", "TRADING_OR_PNL_COMPONENT"],
      ["BONUS_GRANT_USER_IN", "EXTERNAL_INFLOW"],
      ["BONUS_EXPIRE_USER_OUT", "EXTERNAL_OUTFLOW"],
      ["BONUS_TRANSFER_USER_OUT", "EXTERNAL_OUTFLOW"],
      ["WITHDRAW_TRANSFER_OUT", "EXTERNAL_OUTFLOW"],
      ["WITHDRAW_TRANSFER_IN", "EXTERNAL_INFLOW"],
      ["DELIVERY_LONG", "TRADING_OR_PNL_COMPONENT"],
      ["DELIVERY_SHORT", "TRADING_OR_PNL_COMPONENT"],
      ["FIXED_DELIVERY_LONG", "TRADING_OR_PNL_COMPONENT"],
      ["FIXED_DELIVERY_SHORT", "TRADING_OR_PNL_COMPONENT"],
      ["REBASE_COIN_SPLIT_OUT", "INTERNAL_NON_FLOW"],
      ["REBASE_COIN_SPLIT_IN", "INTERNAL_NON_FLOW"],
      ["REBASE_COIN_MERGE_OUT", "INTERNAL_NON_FLOW"],
      ["REBASE_COIN_MERGE_IN", "INTERNAL_NON_FLOW"],
    ]);
    for (const [type, classification] of expected) {
      expect(classifyFinancialRecordType(type), type).toBe(classification);
    }
  });

  it("applies withdrawal and bonus adjustments without subtracting delivery, liquidation, or rebase records", () => {
    const flows = calculateVerifiedExternalFlows([
      { type: "BONUS_GRANT_USER_IN", amount: "20", fee: "0", coin: "USDT" },
      { type: "BONUS_EXPIRE_USER_OUT", amount: "-2", fee: "0", coin: "USDT" },
      { type: "BONUS_TRANSFER_USER_OUT", amount: "-3", fee: "0", coin: "USDT" },
      { type: "WITHDRAW_TRANSFER_OUT", amount: "-7", fee: "0", coin: "USDT" },
      { type: "WITHDRAW_TRANSFER_IN", amount: "1", fee: "0", coin: "USDT" },
      { type: "DELIVERY_LONG", amount: "900", fee: "0", coin: "USDT" },
      { type: "FIXED_RISK_LIQ_DEFAULT_USER_IN", amount: "800", fee: "0", coin: "USDT" },
      { type: "REBASE_COIN_SPLIT_IN", amount: "700", fee: "0", coin: "USDT" },
      { type: "REBASE_COIN_MERGE_OUT", amount: "-600", fee: "0", coin: "USDT" },
    ], completeCategories);
    expect(flows).toEqual({ status: "VERIFIED", netExternalInflows: "9", unknownTypes: [] });
  });

  it("returns UNVERIFIED and unavailable accounting for incomplete category coverage", () => {
    const flows = calculateVerifiedExternalFlows(
      [{ type: "TRANSFER_IN", amount: "100", fee: "0", coin: "USDT" }],
      completeCategories.map((category, index) => index === 4 ? { ...category, complete: false } : category),
    );
    expect(flows).toMatchObject({ status: "UNVERIFIED", netExternalInflows: "UNAVAILABLE" });
    expect(calculateNetPnlSinceBaseline("1150", "1000", flows)).toBe("UNAVAILABLE");
  });

  it("does not classify an unknown type or non-USDT capital amount as verified", () => {
    const unknown = calculateVerifiedExternalFlows([
      { type: "UNRECOGNIZED_NEW_TYPE", amount: "10", fee: "0", coin: "USDT" },
    ], completeCategories);
    expect(unknown).toMatchObject({ status: "UNVERIFIED", netExternalInflows: "UNAVAILABLE", unknownTypes: ["UNRECOGNIZED_NEW_TYPE"] });
    const foreignCoin = calculateVerifiedExternalFlows([
      { type: "TRANSFER_IN", amount: "0.1", fee: "0", coin: "BTC" },
    ], completeCategories);
    expect(foreignCoin).toMatchObject({ status: "UNVERIFIED", netExternalInflows: "UNAVAILABLE" });
  });

  it("requires baseline-start and current coverage for each category", () => {
    const now = new Date("2026-09-23T00:00:00.000Z");
    const coverage = {
      coveredFrom: "2026-08-01T00:00:00.000Z",
      coveredThrough: "2026-09-22T18:00:00.000Z",
      lastSuccessfulSyncAt: "2026-09-22T18:00:00.000Z",
      lastError: null,
    };
    expect(isFinancialRecordCoverageComplete(coverage, "2026-08-15T00:00:00.000Z", now)).toBe(true);
    expect(isFinancialRecordCoverageComplete({ ...coverage, coveredFrom: "2026-08-16T00:00:00.000Z" }, "2026-08-15T00:00:00.000Z", now)).toBe(false);
    expect(isFinancialRecordCoverageComplete({ ...coverage, coveredThrough: "2026-09-21T00:00:00.000Z" }, "2026-08-15T00:00:00.000Z", now)).toBe(false);
    expect(isFinancialRecordCoverageComplete({ ...coverage, lastSuccessfulSyncAt: "2026-09-20T00:00:00.000Z" }, "2026-08-15T00:00:00.000Z", now)).toBe(false);
    expect(isFinancialRecordCoverageComplete({ ...coverage, lastError: "financial-records:read_failed" }, "2026-08-15T00:00:00.000Z", now)).toBe(false);
  });

  it("rejects missing or malformed financial amounts", () => {
    expect(calculateVerifiedExternalFlows([
      { type: "PAPTRADING_USER_IN", amount: null, fee: "0", coin: "USDT" },
    ], completeCategories)).toMatchObject({ status: "UNVERIFIED", netExternalInflows: "UNAVAILABLE" });
  });
});
