import { describe, expect, it, vi } from "vitest";
import type { ProviderLedgerReadClient } from "../src/bitget/provider-sync.js";
import { readBoundedProviderHistory } from "../src/bitget/provider-history-read.js";

const now = new Date("2026-10-08T00:00:00.000Z");
const window = {
  category: "USDT-FUTURES",
  symbol: "KORUUSDT",
  from: "2026-09-21T00:00:00.000Z",
  through: "2026-10-08T00:00:00.000Z",
  now,
};

function client(overrides: Partial<ProviderLedgerReadClient> = {}): ProviderLedgerReadClient {
  const empty = vi.fn(async () => ({ list: [] }));
  return {
    getOrderHistoryRead: empty,
    getFillHistoryWindowRead: empty,
    getPositionHistoryRead: empty,
    getFinancialRecordsRead: empty,
    ...overrides,
  };
}

describe("bounded read-only execution history scans", () => {
  it("paginates each provider resource and returns completed coverage checkpoints without writes", async () => {
    const orderRead = vi.fn()
      .mockResolvedValueOnce({ list: [{ orderId: "order-1" }], nextCursor: "cursor-2" })
      .mockResolvedValueOnce({ list: [{ orderId: "order-2" }], nextCursor: null });
    const provider = client({ getOrderHistoryRead: orderRead });

    const result = await readBoundedProviderHistory(provider, window);

    expect(result.status).toBe("COMPLETE");
    expect(result.rows.orders.map((row) => row.orderId)).toEqual(["order-1", "order-2"]);
    expect(result.checkpoints.orders).toMatchObject([{ pages: 2, rows: 2, complete: true, nextCursor: null }]);
    expect(orderRead).toHaveBeenCalledTimes(2);
    expect(orderRead.mock.calls[0]?.[0]).toMatchObject({ category: "USDT-FUTURES", symbol: "KORUUSDT", limit: "100" });
    expect(orderRead.mock.calls[1]?.[0]).toMatchObject({ cursor: "cursor-2" });
  });

  it("distinguishes a transient provider failure from complete empty history", async () => {
    const transient = Object.assign(new Error("gateway timeout"), { details: { classification: "GATEWAY_TIMEOUT" } });
    const failed = client({ getOrderHistoryRead: vi.fn().mockRejectedValue(transient) });
    const incomplete = await readBoundedProviderHistory(failed, window);
    expect(incomplete.status).toBe("INCOMPLETE");
    expect(incomplete.errors).toContain("orders:GATEWAY_TIMEOUT");
    expect(incomplete.checkpoints.orders[0]).toMatchObject({ complete: false, pages: 0 });

    const empty = await readBoundedProviderHistory(client(), window);
    expect(empty.status).toBe("COMPLETE");
    expect(empty.rows.orders).toEqual([]);
    expect(empty.checkpoints.orders[0]).toMatchObject({ complete: true, pages: 1, rows: 0 });
  });

  it("stops on repeated pagination cursors and exposes the last incomplete checkpoint", async () => {
    const repeated = client({ getOrderHistoryRead: vi.fn(async () => ({ list: [{ orderId: "same" }] })) });
    const result = await readBoundedProviderHistory(repeated, { ...window, maxPages: 5 });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.errors).toContain("orders:PROVIDER_HISTORY_CURSOR_REPEATED");
    expect(result.checkpoints.orders[0]).toMatchObject({ complete: false, pages: 2, nextCursor: "same" });
  });

  it("marks a scan incomplete when the requested time begins outside provider retention", async () => {
    const oldWindow = { ...window, from: "2026-06-01T00:00:00.000Z", maxPages: 20 };
    const result = await readBoundedProviderHistory(client(), oldWindow);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.withinProviderRetention).toBe(false);
    expect(result.errors).toContain("coverage:PROVIDER_HISTORY_RETENTION_WINDOW_EXCEEDED");
    expect(Date.parse(result.coveredFrom)).toBeGreaterThan(Date.parse(oldWindow.from));
  });
});
