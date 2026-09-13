import { describe, expect, it, vi } from "vitest";
import { BitgetGatewayClient } from "../src/bitget/gateway-client.js";

describe("Worker Bitget gateway client", () => {
  it("uses the internal service secret and typed route", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://gateway.test/v1/bitget/position-info");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gateway-secret");
      expect(new Headers(init?.headers).get("user-agent")).toBe("darwin-bitget-worker-gateway/1.0");
      expect(init?.body).toBe(JSON.stringify({ category: "USDT-FUTURES" }));
      return Response.json({ endpoint: "getPositionInfo", requestTime: "2026-09-13T00:00:00.000Z", data: [{ symbol: "SOXLUSDT" }] });
    });
    const client = new BitgetGatewayClient("https://gateway.test", "gateway-secret", fetchImpl);

    await expect(client.call("getPositionInfo", { category: "USDT-FUTURES" })).resolves.toMatchObject({ data: [{ symbol: "SOXLUSDT" }] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("preserves sanitized provider errors for the existing Bitget error path", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "BITGET_READ_FAILED_getAccountAssets_ACCOUNT", provider: { operation: "getAccountAssets", code: "403", message: "HTTP 403 from Bitget: Unknown error", symbol: "ACCOUNT" } }, { status: 502 }));
    const client = new BitgetGatewayClient("https://gateway.test", "gateway-secret", fetchImpl);

    await expect(client.call("getAccountAssets", {})).rejects.toMatchObject({ operation: "getAccountAssets", details: { code: "403", message: "HTTP 403 from Bitget: Unknown error" } });
  });

  it("does not expose an arbitrary operation escape hatch", () => {
    const client = new BitgetGatewayClient("https://gateway.test", "gateway-secret", vi.fn());

    expect(() => client.routeFor("rawOperation" as never)).toThrow("BITGET_OPERATION_NOT_ALLOWED");
  });
});
