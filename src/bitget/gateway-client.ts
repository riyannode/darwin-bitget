import type { GatewayFailureClass, ProviderErrorDetails } from "./client.js";

const GATEWAY_FAILURE_CLASS_VALUES: readonly GatewayFailureClass[] = [
  "GATEWAY_HTTP_502",
  "GATEWAY_TIMEOUT",
  "GATEWAY_UNREACHABLE",
  "GATEWAY_INVALID_RESPONSE",
  "PROVIDER_REJECTED",
  "PROVIDER_NOT_FOUND",
  "GATEWAY_INTERNAL_ERROR",
];

export const PRIVATE_BITGET_OPERATIONS = [
  "getAccountAssets",
  "getPositionInfo",
  "getOpenOrders",
  "getAccountInfo",
  "setLeverage",
  "placeOrder",
  "getOrderDetails",
  "getFillHistory",
  "getOrderHistory",
  "getPositionsHistory",
  "getFinancialRecords",
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
  getOrderHistory: "/v1/bitget/order-history",
  getPositionsHistory: "/v1/bitget/positions-history",
  getFinancialRecords: "/v1/bitget/financial-records",
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
    this.fetchImpl = fetchImpl.bind(globalThis);
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
      const rawBody = await response.text();
      const payload = parseJson(rawBody);
      if (!response.ok || !isGatewayResponse(payload)) {
        const provider = isRecord(payload) && isRecord(payload.provider) ? payload.provider : {};
        const symbol = typeof provider.symbol === "string" ? provider.symbol : typeof args.symbol === "string" ? args.symbol : "ACCOUNT";
        const classification = failureClassFromResponse(response.status, payload, rawBody);
        throw new BitgetGatewayError(operation, symbol, {
          classification,
          ...(typeof provider.code === "string" ? { code: provider.code } : {}),
          ...(typeof provider.message === "string" ? { message: sanitizeMessage(provider.message, this.serviceSecret) } : {}),
        });
      }
      return payload as BitgetGatewayResponse<T>;
    } catch (error) {
      if (error instanceof BitgetGatewayError) throw error;
      const classification: GatewayFailureClass = error instanceof Error && error.name === "AbortError"
        ? "GATEWAY_TIMEOUT"
        : error instanceof TypeError
          ? "GATEWAY_UNREACHABLE"
          : "GATEWAY_INVALID_RESPONSE";
      throw new BitgetGatewayError(operation, typeof args.symbol === "string" ? args.symbol : "ACCOUNT", { classification });
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

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function failureClassFromResponse(status: number, payload: unknown, rawBody: string): GatewayFailureClass {
  const payloadClass = isRecord(payload) && typeof payload.classification === "string" ? payload.classification : "";
  const provider = isRecord(payload) && isRecord(payload.provider) ? payload.provider : null;
  const providerClass = provider && typeof provider.classification === "string" ? provider.classification : "";
  if (isGatewayFailureClass(payloadClass)) return payloadClass;
  if (isGatewayFailureClass(providerClass)) return providerClass;
  if (status === 502) return "GATEWAY_HTTP_502";
  if (provider && (typeof provider.code === "string" || typeof provider.message === "string")) {
    return /order does not exist|not found/i.test(String(provider.message ?? "")) ? "PROVIDER_NOT_FOUND" : "PROVIDER_REJECTED";
  }
  if (status === 502) return "GATEWAY_HTTP_502";
  if (status === 504) return "GATEWAY_TIMEOUT";
  if (!rawBody.trim() || status >= 500) return "GATEWAY_INVALID_RESPONSE";
  return "GATEWAY_INVALID_RESPONSE";
}

function isGatewayFailureClass(value: string): value is GatewayFailureClass {
  return GATEWAY_FAILURE_CLASS_VALUES.includes(value as GatewayFailureClass);
}

function sanitizeMessage(value: string, serviceSecret: string): string {
  return value
    .split(serviceSecret).join("[REDACTED]")
    .replace(/(ACCESS-(?:KEY|SIGN|PASSPHRASE|TIMESTAMP)|apiKey|secretKey|passphrase|authorization)(\s*[=:]\s*)(?:bearer\s+)?[^,;\s]+/gi, "$1$2[REDACTED]")
    .replace(/\bbearer\s+[^,;\s]+/gi, "Bearer [REDACTED]")
    .slice(0, 240);
}
