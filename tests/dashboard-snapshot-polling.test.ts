import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The browser asset is plain JavaScript; keep its declarations out of the public directory.
import { createSnapshotPolling, snapshotPollIntervalMs } from "../public/snapshot-polling.js";

describe("snapshot polling", () => {
  it("uses 60 seconds for paused or idle state and a bounded fast interval for active state", () => {
    expect(snapshotPollIntervalMs({ status: "PAUSED", currentStage: "PAUSED" })).toBe(60_000);
    expect(snapshotPollIntervalMs({ status: "ONLINE", currentStage: "IDLE" })).toBe(60_000);
    expect(snapshotPollIntervalMs({ status: "ONLINE", currentStage: "SCANNING" })).toBe(10_000);
    expect(snapshotPollIntervalMs({ status: "ONLINE", currentStage: "ANALYZING" })).toBe(10_000);
  });

  it("does not poll hidden tabs and refreshes immediately when visible", async () => {
    let visibilityHandler: (() => void) | undefined;
    let hidden = false;
    let pending: { callback: () => void; delay: number } | undefined;
    const setTimeoutFn = vi.fn((callback: () => void, delay: number) => {
      pending = { callback, delay };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutFn = vi.fn(() => { pending = undefined; });
    const refresh = vi.fn(async () => undefined);
    const polling = createSnapshotPolling({
      document: {
        get hidden() { return hidden; },
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => { visibilityHandler = listener as () => void; },
        removeEventListener: () => undefined,
      },
      getAgent: () => ({ status: "PAUSED", currentStage: "PAUSED" }),
      refresh,
      setTimeoutFn,
      clearTimeoutFn,
    });

    polling.start();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(pending?.delay).toBe(60_000);
    hidden = true;
    visibilityHandler?.();
    expect(pending).toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);

    hidden = false;
    visibilityHandler?.();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(pending?.delay).toBe(60_000);
    polling.stop();
  });
});
