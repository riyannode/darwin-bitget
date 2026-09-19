import { describe, expect, it } from "vitest";
import { DEFAULT_OWNER_POLICY, parseOwnerPolicy, updateOwnerPolicy } from "../src/trading/policy.js";

describe("owner policy", () => {
  it("defaults to the authoritative 5-minute scan cadence", () => {
    expect(DEFAULT_OWNER_POLICY.scanIntervalMinutes).toBe(5);
  });

  it("accepts an update inside hard bounds", () => {
    expect(updateOwnerPolicy(DEFAULT_OWNER_POLICY, { maxLeverage: "3", scanIntervalMinutes: 30 })).toMatchObject({ maxLeverage: "3", scanIntervalMinutes: 30 });
  });

  it("accepts an unrestricted positive inspection cadence", () => {
    expect(updateOwnerPolicy(DEFAULT_OWNER_POLICY, { scanIntervalMinutes: 10000 }).scanIntervalMinutes).toBe(10000);
  });

  it("rejects an invalid non-positive cadence", () => {
    expect(() => updateOwnerPolicy(DEFAULT_OWNER_POLICY, { scanIntervalMinutes: 0 })).toThrow("INVALID_POLICY");
  });

  it("rejects a policy above the absolute owner ceiling", () => {
    expect(() => updateOwnerPolicy(DEFAULT_OWNER_POLICY, { maxLeverage: "6" })).toThrow("INVALID_POLICY");
  });

  it("rejects a corrupted persisted policy", () => {
    expect(() => parseOwnerPolicy({ ...DEFAULT_OWNER_POLICY, maxDailyDrawdownPct: "30" })).toThrow("INVALID_POLICY");
  });
});
