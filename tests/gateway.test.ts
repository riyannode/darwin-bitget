import { describe, expect, it, vi } from "vitest";
import { createGatewayHandler, type GatewayProvider } from "../gateway/src/server.js";

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://gateway.test${path}`, init);
}

function providerFixture(): GatewayProvider {
  return {
    call: vi.fn(async (operation, args) => ({
      endpoint: operation,
      requestTime: "2026-09-13T00:00:00.000Z",
      data: { operation, args },
    })),
  };
}

describe("Bitget gateway", () => {
  it("serves health without exposing provider credentials", async () => {
    const response = await createGatewayHandler({ serviceSecret: "service-secret", provider: providerFixture() })(request("/healthz"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, mode: "PAPER", demo: true });
  });

  it("requires the separate Worker service secret", async () => {
    const handler = createGatewayHandler({ serviceSecret: "service-secret", provider: providerFixture() });

    expect((await handler(request("/v1/bitget/account-assets", { method: "POST" }))).status).toBe(401);
    expect((await handler(request("/v1/bitget/account-assets", { method: "POST", headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
  });

  it("routes a typed account-assets action to the provider", async () => {
    const provider = providerFixture();
    const handler = createGatewayHandler({ serviceSecret: "service-secret", provider });

    const response = await handler(request("/v1/bitget/account-assets", {
      method: "POST",
      headers: { authorization: "Bearer service-secret", "content-type": "application/json" },
      body: "{}",
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ endpoint: "getAccountAssets", data: { operation: "getAccountAssets", args: {} } });
    expect(provider.call).toHaveBeenCalledWith("getAccountAssets", {});
  });

  it("rejects arbitrary paths and invalid typed payloads", async () => {
    const handler = createGatewayHandler({ serviceSecret: "service-secret", provider: providerFixture() });
    const headers = { authorization: "Bearer service-secret", "content-type": "application/json" };

    expect((await handler(request("/v1/bitget/raw", { method: "POST", headers, body: "{}" }))).status).toBe(404);
    expect((await handler(request("/v1/bitget/position-info", { method: "POST", headers, body: JSON.stringify({ category: "SPOT" }) }))).status).toBe(400);
  });

  it("preserves clientOid on the narrow order action", async () => {
    const provider = providerFixture();
    const handler = createGatewayHandler({ serviceSecret: "service-secret", provider });
    const body = { category: "USDT-FUTURES", symbol: "SOXLUSDT", side: "buy", orderType: "market", qty: "1", clientOid: "cycle-1-decision-1" };

    const response = await handler(request("/v1/bitget/place-order", {
      method: "POST",
      headers: { authorization: "Bearer service-secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(200);
    expect(provider.call).toHaveBeenCalledWith("placeOrder", body);
  });

  it("sanitizes provider errors and does not leak credentials", async () => {
    const provider: GatewayProvider = {
      call: vi.fn(async () => { throw Object.assign(new Error("ACCESS-KEY=secret-value"), { code: "403" }); }),
    };
    const handler = createGatewayHandler({ serviceSecret: "service-secret", provider });

    const response = await handler(request("/v1/bitget/account-assets", {
      method: "POST",
      headers: { authorization: "Bearer service-secret", "content-type": "application/json" },
      body: "{}",
    }));
    const body = await response.json() as { provider?: { code?: string; message?: string } };

    expect(response.status).toBe(502);
    expect(body.provider).toEqual({ operation: "getAccountAssets", symbol: "ACCOUNT", code: "403", message: "ACCESS-KEY=REDACTED" });
    expect(JSON.stringify(body)).not.toContain("secret-value");
  });
});
