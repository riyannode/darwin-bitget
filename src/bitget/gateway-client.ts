import type { ProviderErrorDetails } from "./client.js";

export const PRIVATE_BITGET_OPERATIONS = [
  "getAccountAssets",
  "getPositionInfo",
  "getOpenOrders",
  "getAccountInfo",
  "setLeverage",
  "placeOrder",
  "getOrderDetails",
  "getFillHistory",
  "getPositionsHistory",
] as const;

export type PrivateBitgetOperation = (typeof PRIVATE_BITGET_OPERATIONS)[number];

const ROUTES: Record<PrivateBitgetOperation, string> = {
  getAccountAssets: "/v1/bitget/account-assets",
  getPositionInfo: "/v1/bitget/position-info",
  getOpenOrders: "/v1/bitget/open-orders",
  getAccountInfo: "/v1/bitget/account-info",
  setLeverage: "/v1/bitget/set-leverage",
  placeOrder: "/v1/bitget/place-order",
  getOrderDetails: "/v1/bitget/order-details",
  getFillHistory: "/v1/bitget/fill-history",
  getPositionsHistory: "/v1/bitget/positions-history",
};

export interface BitgetGatewayResponse<T> {
  data: T;
  endpoint: string;
  requestTime: string;
}

export class BitgetGatewayError extends Error {
  public readonly operation: string;
  public readonly symbol: string;
  public readonly details: ProviderErrorDetails;

  public constructor(operation: string, symbol: string, details: ProviderErrorDetails) {
    super(`BITGET_GATEWAY_FAILED_${operation}_${symbol}`);
    this.name = "BitgetGatewayError";
    this.operation = operation;
    this.symbol = symbol;
    this.details = details;
  }
}

export class BitgetGatewayClient {
  private readonly baseUrl: string;
  private readonly serviceSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(baseUrl: string, serviceSecret: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.serviceSecret = serviceSecret;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  public routeFor(operation: PrivateBitgetOperation): string {
    const route = ROUTES[operation];
    if (!route) throw new Error("BITGET_OPERATION_NOT_ALLOWED");
    return route;
  }

  public async call<T>(operation: PrivateBitgetOperation, args: Record<string, unknown>): Promise<BitgetGatewayResponse<T>> {
    const route = this.routeFor(operation);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.serviceSecret}`, "content-type": "application/json", "user-agent": "darwin-bitget-worker-gateway/1.0" },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok || !isGatewayResponse(payload)) {
        const provider = isRecord(payload) && isRecord(payload.provider) ? payload.provider : {};
        const symbol = typeof provider.symbol === "string" ? provider.symbol : typeof args.symbol === "string" ? args.symbol : "ACCOUNT";
        throw new BitgetGatewayError(operation, symbol, {
          ...(typeof provider.code === "string" ? { code: provider.code } : {}),
          ...(typeof provider.message === "string" ? { message: sanitizeMessage(provider.message, this.serviceSecret) } : {}),
        });
      }
      return payload as BitgetGatewayResponse<T>;
    } catch (error) {
      if (error instanceof BitgetGatewayError) throw error;
      const message = error instanceof Error && error.name === "AbortError" ? "BITGET_GATEWAY_TIMEOUT" : error instanceof Error ? sanitizeMessage(error.message, this.serviceSecret) : "BITGET_GATEWAY_REQUEST_FAILED";
      throw new BitgetGatewayError(operation, typeof args.symbol === "string" ? args.symbol : "ACCOUNT", { message });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGatewayResponse(value: unknown): value is BitgetGatewayResponse<unknown> {
  return isRecord(value) && typeof value.endpoint === "string" && typeof value.requestTime === "string" && "data" in value;
}

function sanitizeMessage(value: string, serviceSecret: string): string {
  return value
    .split(serviceSecret).join("[REDACTED]")
    .replace(/(ACCESS-(?:KEY|SIGN|PASSPHRASE|TIMESTAMP)|apiKey|secretKey|passphrase|authorization)([=:])[^,\s]+/gi, "$1$2[REDACTED]")
    .slice(0, 240);
}
