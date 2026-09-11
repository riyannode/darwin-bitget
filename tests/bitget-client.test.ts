import { describe, expect, it } from "vitest";
import { buildOpenOrdersReadParams, formatBitgetReadFailure } from "../src/bitget/client.js";

describe("Bitget read diagnostics", () => {
  it("identifies the failed operation and symbol without provider payloads", () => {
    expect(formatBitgetReadFailure("getOpenOrders", "KORUUSDT")).toBe("BITGET_READ_FAILED_getOpenOrders_KORUUSDT");
    expect(formatBitgetReadFailure("getAccountAssets")).toBe("BITGET_READ_FAILED_getAccountAssets_ACCOUNT");
  });

  it("reads open orders once at category scope", () => {
    expect(buildOpenOrdersReadParams("USDT-FUTURES")).toEqual({ category: "USDT-FUTURES" });
  });
});
