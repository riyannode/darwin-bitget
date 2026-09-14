import { describe, expect, it } from "vitest";
import { buildDemoSnapshot } from "../demo/fixtures.js";

describe("zero-credential judge demo fixtures", () => {
  it("replays a matched provider open without claiming a live write", () => {
    const snapshot = buildDemoSnapshot("verified-open");
    expect(snapshot.demo.writesBlocked).toBe(true);
    expect(snapshot.demo.externalCalls).toBe(false);
    expect(snapshot.executionEvidence?.executionStatus).toBe("filled");
    expect(snapshot.executionEvidence?.reconciliationStatus).toBe("MATCHED");
    expect(snapshot.portfolioFreshness.source).toBe("JOURNAL_FALLBACK");
    expect(snapshot.agent.status).toBe("PAUSED");
    expect(snapshot.performance.totalTrades).toBe(0);
    expect(snapshot.demo.preTradeAccount.positions).toHaveLength(0);
    expect(snapshot.demo.postTradeAccount.positions).toHaveLength(1);
  });

  it("keeps HOLD a no-write replay", () => {
    const snapshot = buildDemoSnapshot("hold");
    expect(snapshot.latestDecision?.action).toBe("HOLD");
    expect(snapshot.latestCyclePlan?.positionActions).toHaveLength(1);
    expect(snapshot.latestCyclePlan?.positionActions[0]).toMatchObject({ symbol: "CRCLUSDT", action: "HOLD", positionSide: "LONG" });
    expect(snapshot.latestCyclePlan?.entryActions[0]).toMatchObject({ symbol: "NVDAUSDT", action: "OPEN_LONG" });
    expect(snapshot.latestDiscovery?.scannedUniverseCount).toBeGreaterThan(0);
    expect(snapshot.executionEvidence).toBeNull();
    expect(snapshot.demo.schedulerEnabled).toBe(false);
  });

  it("uses the deterministic risk gate for a rejected proposal", () => {
    const snapshot = buildDemoSnapshot("risk-reject");
    expect(snapshot.latestDecision?.action).toBe("OPEN_LONG");
    expect(snapshot.latestDecision?.leverage).toBe("6");
    expect(snapshot.executionEvidence).toBeNull();
    expect(snapshot.activity.at(-1)?.type).toBe("NO_ORDER_SUBMISSION");
  });
});
