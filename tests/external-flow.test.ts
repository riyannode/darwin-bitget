import { describe, expect, it } from "vitest";
import { calculateNetPnlSinceBaseline, calculateVerifiedExternalFlows, classifyFinancialRecordType, isFinancialRecordCoverageComplete } from "../src/trading/external-flow.js";

const completeCategories = ["USDT-FUTURES", "OTHER", "SPOT", "MARGIN", "COIN-FUTURES", "USDC-FUTURES"]
  .map(() => ({ complete: true, lastError: null }));

describe("Bitget financial record external-flow accounting", () => {
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
