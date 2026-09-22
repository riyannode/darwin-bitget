import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { BitgetRestClient, loadConfig as loadBitgetConfig } from "@bitget-ai/bitget-agent-sdk";
import { z } from "zod";
import type { GatewayFailureClass } from "../../src/bitget/client.js";
import type { PrivateBitgetOperation } from "../../src/bitget/gateway-client.js";

export interface GatewayProvider {
  call(operation: PrivateBitgetOperation, args: Record<string, unknown>): Promise<{ endpoint: string; requestTime: string; data: unknown }>;
}

export type GatewayLogRecord = Record<string, string | number>;
export type GatewayLogger = (record: GatewayLogRecord) => void;

const emptyBody = z.object({}).strict();
const futuresCategory = z.enum(["USDT-FUTURES", "COIN-FUTURES", "USDC-FUTURES"]);
const tradeHistoryCategory = z.enum(["SPOT", "MARGIN", "USDT-FUTURES", "COIN-FUTURES", "USDC-FUTURES"]);
const financialCategory = z.enum(["SPOT", "MARGIN", "USDT-FUTURES", "COIN-FUTURES", "USDC-FUTURES", "OTHER"]);
const timestampField = z.string().regex(/^\d{1,20}$/);
const limitField = z.string().regex(/^\d{1,3}$/).refine((value) => Number(value) >= 1 && Number(value) <= 100, "limit must be between 1 and 100");
const categoryBody = z.object({ category: futuresCategory }).strict();
const setLeverageBody = z.object({
  category: z.enum(["USDT-FUTURES"]),
  symbol: z.string().regex(/^[A-Z0-9]{3,30}$/),
  leverage: z.string().regex(/^\d+(?:\.\d+)?$/),
  posSide: z.enum(["long", "short"]),
}).strict();
const placeOrderBody = z.object({
  category: z.enum(["USDT-FUTURES"]),
  symbol: z.string().regex(/^[A-Z0-9]{3,30}$/),
  side: z.enum(["buy", "sell"]),
  orderType: z.literal("market"),
  qty: z.string().regex(/^\d+(?:\.\d+)?$/),
  clientOid: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  posSide: z.enum(["long", "short"]).optional(),
  reduceOnly: z.enum(["yes", "no"]).optional(),
}).strict();
const orderDetailsBody = z.object({
  orderId: z.string().min(1).max(128).optional(),
  clientOid: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict().refine((value) => Boolean(value.orderId || value.clientOid), "orderId or clientOid is required");
const fillHistoryBody = z.object({
  category: tradeHistoryCategory,
  orderId: z.string().min(1).max(128).optional(),
  startTime: timestampField.optional(),
  endTime: timestampField.optional(),
  limit: limitField,
  cursor: z.string().min(1).max(256).optional(),
}).strict().refine((value) => Boolean(value.orderId || value.startTime || value.endTime), "orderId or time window is required");
const orderHistoryBody = z.object({
  category: tradeHistoryCategory,
  symbol: z.string().regex(/^[A-Z0-9]{3,30}$/).optional(),
  startTime: timestampField.optional(),
  endTime: timestampField.optional(),
  limit: limitField,
  cursor: z.string().min(1).max(256).optional(),
}).strict();
const positionsHistoryBody = z.object({
  category: futuresCategory,
  symbol: z.string().regex(/^[A-Z0-9]{3,30}$/).optional(),
  startTime: timestampField.optional(),
  endTime: timestampField.optional(),
  limit: limitField,
  cursor: z.string().min(1).max(256).optional(),
}).strict();
const financialRecordsBody = z.object({
  category: financialCategory,
  coin: z.string().regex(/^[A-Z0-9]{1,20}$/).optional(),
  type: z.string().min(1).max(64).optional(),
  startTime: timestampField.optional(),
  endTime: timestampField.optional(),
  limit: limitField,
  cursor: z.string().min(1).max(256).optional(),
}).strict();

const ACTIONS: Record<string, { operation: PrivateBitgetOperation; schema: z.ZodType<Record<string, unknown>> }> = {
  "account-assets": { operation: "getAccountAssets", schema: emptyBody },
  "position-info": { operation: "getPositionInfo", schema: categoryBody },
  "open-orders": { operation: "getOpenOrders", schema: categoryBody },
  "account-info": { operation: "getAccountInfo", schema: emptyBody },
  "set-leverage": { operation: "setLeverage", schema: setLeverageBody },
  "place-order": { operation: "placeOrder", schema: placeOrderBody },
  "order-details": { operation: "getOrderDetails", schema: orderDetailsBody },
  "fill-history": { operation: "getFillHistory", schema: fillHistoryBody },
  "order-history": { operation: "getOrderHistory", schema: orderHistoryBody },
  "positions-history": { operation: "getPositionsHistory", schema: positionsHistoryBody },
  "financial-records": { operation: "getFinancialRecords", schema: financialRecordsBody },
};

const MAX_BODY_BYTES = 32 * 1024;

export class BitgetGatewayProvider implements GatewayProvider {
  private readonly client: BitgetRestClient;

  public constructor(env: {
    BITGET_API_KEY?: string;
    BITGET_SECRET_KEY?: string;
    BITGET_PASSPHRASE?: string;
    BITGET_API_BASE_URL?: string;
  }) {
    const apiKey = env.BITGET_API_KEY?.trim();
    const secretKey = env.BITGET_SECRET_KEY?.trim();
    const passphrase = env.BITGET_PASSPHRASE?.trim();
    if (!apiKey || !secretKey || !passphrase) throw new Error("BITGET_GATEWAY_CREDENTIALS_REQUIRED");
    this.client = new BitgetRestClient(loadBitgetConfig({
      modules: "account,trade",
      baseUrl: env.BITGET_API_BASE_URL?.trim() || "https://api.bitget.com",
      apiKey,
      secretKey,
      passphrase,
      paperTrading: true,
      userAgent: "darwin-bitget-gateway/1.0",
    }));
  }

  public async call(operation: PrivateBitgetOperation, args: Record<string, unknown>): Promise<{ endpoint: string; requestTime: string; data: unknown }> {
    if (operation === "getAccountAssets" || operation === "getAccountInfo") return this.client.callOperation(operation, {});
    return this.client.callOperation(operation, args);
  }
}

export function createGatewayHandler(options: { serviceSecret: string; provider: GatewayProvider; logger?: GatewayLogger }): (request: Request) => Promise<Response> {
  if (!options.serviceSecret) throw new Error("GATEWAY_SERVICE_SECRET_REQUIRED");
  const logger = options.logger ?? ((record: GatewayLogRecord) => console.info(JSON.stringify(record)));
  return async (request) => {
    if (request.method === "GET" && new URL(request.url).pathname === "/healthz") return json({ ok: true, mode: "PAPER", demo: true });
    if (request.method !== "POST") return json({ error: "NOT_FOUND" }, 404);

    const path = new URL(request.url).pathname;
    const match = path.match(/^\/v1\/bitget\/([a-z-]+)$/);
    const actionName = match?.[1];
    if (!actionName || !ACTIONS[actionName]) return json({ error: "NOT_FOUND" }, 404);
    const action = ACTIONS[actionName];
    const requestId = request.headers.get("x-request-id")?.match(/^[A-Za-z0-9._:-]{1,80}$/)?.[0] ?? crypto.randomUUID();
    const startedAt = new Date().toISOString();
    let symbol = "ACCOUNT";
    const emit = (record: GatewayLogRecord): void => {
      try {
        logger(record);
      } catch {
        // Observability must never change gateway behavior.
      }
    };
    emit({ event: "GATEWAY_REQUEST_START", requestId, operation: action.operation, symbol, startedAt });
    const finish = (status: string, httpStatus: number, provider?: { code?: string; message?: string }): void => {
      emit({
        event: "GATEWAY_REQUEST_END",
        requestId,
        operation: action.operation,
        symbol,
        status,
        httpStatus,
        durationMs: Math.max(0, Date.now() - Date.parse(startedAt)),
        ...(provider?.code ? { providerCode: provider.code } : {}),
        ...(provider?.message ? { providerMessage: provider.message } : {}),
      });
    };
    if (!constantTimeEqual(request.headers.get("authorization") ?? "", `Bearer ${options.serviceSecret}`)) {
      finish("AUTH_REJECTED", 401);
      return json({ error: "UNAUTHORIZED" }, 401);
    }
    let body: unknown;
    try {
      const contentLength = Number(request.headers.get("content-length") ?? "0");
      if (contentLength > MAX_BODY_BYTES) {
        finish("INVALID_REQUEST", 413);
        return json({ error: "BODY_TOO_LARGE" }, 413);
      }
      body = await request.json();
    } catch {
      finish("INVALID_REQUEST", 400);
      return json({ error: "INVALID_JSON" }, 400);
    }
    const parsed = action.schema.safeParse(body);
    if (!parsed.success) {
      finish("INVALID_REQUEST", 400);
      return json({ error: "INVALID_REQUEST" }, 400);
    }
    if (typeof parsed.data.symbol === "string") symbol = parsed.data.symbol;

    try {
      const result = await options.provider.call(action.operation, parsed.data);
      finish("SUCCESS", 200);
      return json(result);
    } catch (error) {
      const provider = sanitizeProviderError(error, action.operation, symbol);
      const classification = classifyGatewayError(error, provider);
      const httpStatus = providerFailure(classification) ? 424 : 502;
      finish(classification, httpStatus, provider);
      return json({ error: `BITGET_GATEWAY_FAILED_${action.operation}`, classification, provider }, httpStatus);
    }
  };
}

export function startGatewayServer(options: { serviceSecret: string; provider: GatewayProvider; host: string; port: number }) {
  const handler = createGatewayHandler(options);
  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
      const url = `http://${request.headers.host ?? `${options.host}:${options.port}`}${request.url ?? "/"}`;
      const init: RequestInit = { method: request.method ?? "GET", headers };
      if (body.length) init.body = new TextDecoder().decode(body);
      const webRequest = new Request(url, init);
      const webResponse = await handler(webRequest);
      response.statusCode = webResponse.status;
      webResponse.headers.forEach((value, key) => response.setHeader(key, value));
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "GATEWAY_INTERNAL_ERROR" }));
    }
  });
  server.listen(options.port, options.host);
  return server;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function sanitizeProviderError(error: unknown, operation: PrivateBitgetOperation, symbol: string): { operation: string; symbol: string; code?: string; message?: string } {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const details = value.details && typeof value.details === "object" ? value.details as Record<string, unknown> : {};
  const code = text(details.code ?? value.code);
  const message = sanitizeMessage(text(details.message ?? value.message ?? error));
  return { operation, symbol, ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

function classifyGatewayError(error: unknown, provider: { code?: string; message?: string }): GatewayFailureClass {
  const textValue = `${provider.message ?? ""} ${error instanceof Error ? error.message : ""}`;
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(textValue)) return "GATEWAY_TIMEOUT";
  if (/order does not exist|not found/i.test(provider.message ?? "")) return "PROVIDER_NOT_FOUND";
  if (provider.code || provider.message) return "PROVIDER_REJECTED";
  return "GATEWAY_INTERNAL_ERROR";
}

function providerFailure(classification: GatewayFailureClass): boolean {
  return classification === "PROVIDER_NOT_FOUND" || classification === "PROVIDER_REJECTED";
}

function sanitizeMessage(value: string): string {
  return value
    .replace(/(ACCESS-(?:KEY|SIGN|PASSPHRASE|TIMESTAMP)|apiKey|secretKey|passphrase|authorization)(\s*[=:]\s*)(?:bearer\s+)?[^,;\s]+/gi, "$1$2REDACTED")
    .replace(/\bbearer\s+[^,;\s]+/gi, "Bearer REDACTED")
    .slice(0, 240);
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const serviceSecret = process.env.GATEWAY_SERVICE_SECRET?.trim();
  if (!serviceSecret) throw new Error("GATEWAY_SERVICE_SECRET_REQUIRED");
  const provider = new BitgetGatewayProvider(process.env);
  startGatewayServer({ serviceSecret, provider, host: process.env.HOST?.trim() || "127.0.0.1", port: Number(process.env.PORT || 18080) });
}
