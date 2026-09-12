import { BitgetRestClient, loadConfig as loadBitgetConfig } from "@bitget-ai/bitget-agent-sdk";
import type { AccountSnapshot, EvidenceBundle, ExecutionResult, ExecutionRequest, Instrument, MarketSnapshot, RuntimeConfig } from "../types.js";
import { classifyMarketRegime } from "../trading/market-regime.js";
import { parseAccount, parseDashboardPortfolio, parseFillSummary, parseHistoricalBars, parseInstruments, parsePositionHistorySummary, parsePositionSymbols, parseTicker, record } from "./types.js";

export function formatBitgetReadFailure(operation: string, symbol = "ACCOUNT"): string {
  return `BITGET_READ_FAILED_${operation}_${symbol}`;
}

export function buildOpenOrdersReadParams(category: string): Record<string, string> {
  return { category };
}

export function executableIntersection(publicInstruments: readonly Instrument[], demoInstruments: readonly Instrument[], category: string): Instrument[] {
  const valid = (instrument: Instrument) => instrument.category === category && instrument.status === "online" && instrument.symbolType === "stock";
  const publicSymbols = new Set(publicInstruments.filter(valid).map((instrument) => instrument.symbol));
  return demoInstruments.filter((instrument) => valid(instrument) && publicSymbols.has(instrument.symbol)
    && instrument.minOrderQty !== "" && instrument.minOrderAmount !== "" && instrument.leverageMax !== "");
}

export type BitgetHoldingMode = "hedge_mode" | "one_way_mode";

export interface ProviderErrorDetails {
  code?: string;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function sanitizeProviderMessage(value: string): string {
  return value.replace(/(ACCESS-(?:KEY|SIGN|PASSPHRASE|TIMESTAMP)|apiKey|secretKey|passphrase)([=:])[^,\s]+/gi, "$1$2REDACTED").slice(0, 240);
}

function parseHoldingMode(value: unknown): BitgetHoldingMode {
  const response = record(value);
  const mode = textValue(response.holdMode);
  if (mode === "hedge_mode" || mode === "one_way_mode") return mode;
  throw new Error("POSITION_MODE_UNKNOWN");
}

export function buildPaperOrderParams(request: ExecutionRequest, holdingMode: BitgetHoldingMode, category: string): Record<string, string> {
  const params: Record<string, string> = {
    category,
    symbol: request.symbol,
    side: request.providerSide,
    orderType: "market",
    qty: request.quantity,
    clientOid: request.clientOrderId,
  };
  if (holdingMode === "hedge_mode") params.posSide = request.positionSide.toLowerCase();
  if (holdingMode === "one_way_mode" && request.tradeSide === "close") params.reduceOnly = "yes";
  return params;
}

export function normalizeBitgetOrderStatus(value: unknown): ExecutionResult["status"] {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (["new", "partially_filled", "filled", "canceled", "cancelled", "rejected"].includes(status)) return status as ExecutionResult["status"];
  return "unknown";
}

export function extractProviderError(error: unknown): ProviderErrorDetails {
  const record = isRecord(error) ? error : null;
  const code = textValue(record?.code) || textValue(record?.type);
  const message = sanitizeProviderMessage(error instanceof Error ? error.message : textValue(record?.message) || textValue(record?.msg));
  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

export function buildUnresolvedExecution(
  request: ExecutionRequest,
  submittedAt: string,
  writeError: unknown,
  readbackError?: unknown,
): ExecutionResult {
  const writeDetails = extractProviderError(writeError);
  const readbackDetails = extractProviderError(readbackError);
  return {
    provider: "bitget",
    clientOrderId: request.clientOrderId,
    symbol: request.symbol,
    action: request.action,
    positionSide: request.positionSide,
    providerSide: request.providerSide,
    tradeSide: request.tradeSide,
    marginAllocated: request.marginAllocated,
    leverage: request.leverage,
    positionNotional: request.positionNotional,
    requestedQuantity: request.quantity,
    executedQuantity: "0",
    status: "unknown",
    submittedAt,
    readBackAt: new Date().toISOString(),
    ...(writeDetails.code ? { providerCode: writeDetails.code } : {}),
    providerMessage: writeDetails.message ?? "PROVIDER_WRITE_UNKNOWN",
    ...(readbackDetails.code ? { providerReadbackCode: readbackDetails.code } : {}),
    ...(readbackDetails.message ? { providerReadbackMessage: readbackDetails.message } : {}),
  };
}

export class BitgetClient {
  private readonly client: BitgetRestClient;
  private readonly category: string;
  private readonly baseUrl: string;
  private demoInstruments: Instrument[] = [];
  private readonly secrets: string[];

  public constructor(config: RuntimeConfig) {
    const credentials = {
      ...(config.bitgetApiKey ? { apiKey: config.bitgetApiKey } : {}),
      ...(config.bitgetSecretKey ? { secretKey: config.bitgetSecretKey } : {}),
      ...(config.bitgetPassphrase ? { passphrase: config.bitgetPassphrase } : {}),
    };
    this.category = config.bitgetCategory;
    this.baseUrl = config.bitgetApiBaseUrl;
    this.secrets = [config.bitgetApiKey, config.bitgetSecretKey, config.bitgetPassphrase].filter((value): value is string => Boolean(value));
    const bitgetConfig = loadBitgetConfig({
      modules: "account,trade,market",
      baseUrl: config.bitgetApiBaseUrl,
      paperTrading: true,
      userAgent: "bitget-autonomous-trader/0.1.0",
      ...credentials,
    });
    this.client = new BitgetRestClient(bitgetConfig);
  }

  public async getInstruments(): Promise<Instrument[]> {
    const result = await this.callRead<unknown>("getInstruments", { category: this.category });
    return parseInstruments(result.data);
  }

  public async getTradableInstruments(): Promise<Instrument[]> {
    this.demoInstruments = [];
    const url = new URL("/api/v3/market/instruments", this.baseUrl);
    url.searchParams.set("category", this.category);
    const response = await fetch(url, { headers: { paptrading: "1" }, signal: AbortSignal.timeout(15_000) });
    const envelope = record(await response.json());
    if (!response.ok || envelope.code !== "00000") throw new Error("DEMO_UNIVERSE_UNAVAILABLE");
    this.demoInstruments = parseInstruments(envelope.data);
    return executableIntersection(await this.getInstruments(), this.demoInstruments, this.category);
  }

  public async getOpenPositionSymbols(): Promise<string[]> {
    const result = await this.callRead<unknown>("getPositionInfo", { category: this.category });
    return parsePositionSymbols(result.data);
  }

  public async getDashboardPortfolio(): Promise<AccountSnapshot> {
    const observedAt = new Date().toISOString();
    const [accountResult, positionsResult, openOrdersResult] = await Promise.all([
      this.callRead<unknown>("getAccountAssets", {}),
      this.callRead<unknown>("getPositionInfo", { category: this.category }),
      this.callRead<unknown>("getOpenOrders", buildOpenOrdersReadParams(this.category)),
    ]);
    return parseDashboardPortfolio(accountResult.data, positionsResult.data, openOrdersResult.data, observedAt);
  }

  public async collectLightweightScan(instruments: readonly Instrument[]): Promise<MarketSnapshot[]> {
    const observedAt = new Date().toISOString();
    const result = await this.callRead<unknown>("getTickers", { category: this.category });
    return instruments.map((instrument) => parseTicker(result.data, instrument.symbol, observedAt));
  }

  public async getHistoricalBars(symbol: string, limit = 48) {
    const result = await this.callRead<unknown>("getKlineCandlestickHistory", {
      category: this.category,
      symbol,
      interval: "15m",
      limit: String(Math.min(Math.max(limit, 1), 100)),
    });
    return parseHistoricalBars(result.data);
  }

  public async getMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
    const observedAt = new Date().toISOString();
    const result = await this.callRead<unknown>("getTickers", { category: this.category, symbol });
    return parseTicker(result.data, symbol, observedAt);
  }

  public async collectEvidence(symbols: readonly string[]): Promise<EvidenceBundle[]> {
    const instruments = await this.getInstruments();
    const selected = symbols.map((symbol) => {
      const instrument = this.demoInstruments.find((candidate) => candidate.symbol === symbol) ?? instruments.find((candidate) => candidate.symbol === symbol);
      if (!instrument) throw new Error("SYMBOL_NOT_ALLOWED");
      return instrument;
    });
    const accountResult = await this.callRead<unknown>("getAccountAssets", {});
    const positionsResult = await this.callRead<unknown>("getPositionInfo", { category: this.category });
    const openOrdersResult = await this.callRead<unknown>("getOpenOrders", buildOpenOrdersReadParams(this.category));
    return Promise.all(selected.map(async (instrument) => {
      const market = await this.getMarketSnapshot(instrument.symbol);
      const historicalBars = await this.getHistoricalBars(instrument.symbol);
      const observedAt = new Date().toISOString();
      const accountPayload = {
        account: accountResult.data,
        positions: positionsResult.data,
        openOrders: openOrdersResult.data,
      };
      const account = parseAccount(accountPayload, instrument, market, observedAt);
      return {
          market,
          account,
          instrument,
          historicalBars,
          marketRegime: classifyMarketRegime(market, historicalBars),
          evidence: [
          { source: "bitget", observedAt: market.observedAt, type: "TICKER", symbol: instrument.symbol, payload: market },
          { source: "bitget", observedAt, type: "ACCOUNT_ASSETS", symbol: instrument.symbol, payload: accountResult.data },
          { source: "bitget", observedAt, type: "POSITIONS", symbol: instrument.symbol, payload: positionsResult.data },
          { source: "bitget", observedAt, type: "OPEN_ORDERS", symbol: instrument.symbol, payload: openOrdersResult.data },
          { source: "bitget", observedAt, type: "INSTRUMENT", symbol: instrument.symbol, payload: instrument },
          { source: "bitget", observedAt, type: "HISTORICAL_BARS", symbol: instrument.symbol, payload: historicalBars },
        ],
      };
    }));
  }

  public async placePaperOrder(request: ExecutionRequest): Promise<ExecutionResult> {
    const submittedAt = new Date().toISOString();
    let operation = "getAccountInfo";
    try {
      const accountInfo = await this.client.callOperation<unknown>("getAccountInfo", {});
      const holdingMode = parseHoldingMode(accountInfo.data);
      if (request.tradeSide === "open") {
        operation = "setLeverage";
        await this.client.callOperation<unknown>("setLeverage", {
          category: this.category,
          symbol: request.symbol,
          leverage: request.leverage,
          posSide: request.positionSide.toLowerCase(),
        });
      }
      operation = "placeOrder";
      const result = await this.client.callOperation<unknown>("placeOrder", buildPaperOrderParams(request, holdingMode, this.category));
      const response = record(result.data);
      operation = "getOrderDetails";
      return await this.readOrder(request, {
        providerOrderId: this.text(response.orderId),
        clientOrderId: this.text(response.clientOid, request.clientOrderId),
        submittedAt,
      });
    } catch (error) {
      const result = await this.readUnknownOrder(request, submittedAt, error);
      const redact = (message: string | undefined) => message === undefined ? undefined : this.secrets.reduce((safe, secret) => safe.split(secret).join("REDACTED"), sanitizeProviderMessage(message));
      return { ...result, providerOperation: operation, ...(result.providerMessage ? { providerMessage: redact(result.providerMessage)! } : {}), ...(result.providerReadbackMessage ? { providerReadbackMessage: redact(result.providerReadbackMessage)! } : {}) };
    }
  }

  private async callRead<T>(operation: string, params: Record<string, string>): Promise<{ data: T }> {
    try {
      return await this.client.callOperation<T>(operation, params);
    } catch {
      throw new Error(formatBitgetReadFailure(operation, params.symbol));
    }
  }

  private async readUnknownOrder(request: ExecutionRequest, submittedAt: string, error: unknown): Promise<ExecutionResult> {
    try {
      const result = await this.client.callOperation<unknown>("getOrderDetails", { clientOid: request.clientOrderId });
      const response = record(result.data);
      return this.readOrder(request, {
        providerOrderId: this.text(response.orderId),
        clientOrderId: this.text(response.clientOid, request.clientOrderId),
        submittedAt,
      });
    } catch (readbackError) {
      return buildUnresolvedExecution(request, submittedAt, error, readbackError);
    }
  }

  private async readOrder(request: ExecutionRequest, reference: { providerOrderId: string; clientOrderId: string; submittedAt: string }): Promise<ExecutionResult> {
    const result = await this.client.callOperation<unknown>("getOrderDetails", { orderId: reference.providerOrderId, clientOid: reference.clientOrderId });
    const response = record(result.data);
    const baseExecution: ExecutionResult = {
      provider: "bitget",
      providerOrderId: reference.providerOrderId,
      clientOrderId: reference.clientOrderId,
      symbol: this.text(response.symbol, request.symbol),
      action: request.action,
      positionSide: this.text(response.posSide, request.positionSide.toLowerCase()).toUpperCase() === "SHORT" ? "SHORT" as const : "LONG" as const,
      providerSide: this.text(response.side, request.providerSide) as "buy" | "sell",
      tradeSide: request.tradeSide,
      marginAllocated: request.marginAllocated,
      leverage: request.leverage,
      positionNotional: request.positionNotional,
      requestedQuantity: request.quantity,
      executedQuantity: this.text(response.cumExecQty ?? response.baseVolume ?? response.filledQty ?? response.fillQty, "0"),
      status: normalizeBitgetOrderStatus(response.orderStatus ?? response.status ?? response.state),
      submittedAt: reference.submittedAt,
      readBackAt: new Date().toISOString(),
      ...(this.text(response.avgPrice, this.text(response.priceAvg, this.text(response.fillPrice))) ? { averageFillPrice: this.text(response.avgPrice, this.text(response.priceAvg, this.text(response.fillPrice))) } : {}),
      ...(this.text(response.fee, this.text(response.feeAmount)) ? { fees: this.text(response.fee, this.text(response.feeAmount)) } : {}),
      ...(this.text(response.fundingFee, this.text(response.funding)) ? { funding: this.text(response.fundingFee, this.text(response.funding)) } : {}),
      ...(this.text(response.realizedPnl, this.text(response.realizedProfit, this.text(response.totalProfits))) ? { realizedPnl: this.text(response.realizedPnl, this.text(response.realizedProfit, this.text(response.totalProfits))) } : {}),
      ...(this.text(response.realizedPnlPct, this.text(response.profitRate)) ? { realizedPnlPct: this.text(response.realizedPnlPct, this.text(response.profitRate)) } : {}),
      ...(this.text(response.liquidationPrice) ? { liquidationDistance: this.text(response.liquidationPrice) } : {}),
    };
    let enriched = baseExecution;
    let readbackFailure = false;
    if (baseExecution.status === "filled" || baseExecution.status === "partially_filled") {
      try {
        const fills = await this.client.callOperation<unknown>("getFillHistory", { category: this.category, orderId: reference.providerOrderId, limit: "100" });
        const summary = parseFillSummary(fills.data);
        enriched = {
          ...enriched,
          ...(!enriched.averageFillPrice && summary.averageFillPrice ? { averageFillPrice: summary.averageFillPrice } : {}),
          ...(summary.executedQuantity ? { executedQuantity: summary.executedQuantity } : {}),
          ...(!enriched.realizedPnl && summary.realizedPnl ? { realizedPnl: summary.realizedPnl } : {}),
          ...(!enriched.fees && summary.fees ? { fees: summary.fees } : {}),
        };
      } catch {
        readbackFailure = true;
      }
      if (request.tradeSide === "close" && !enriched.realizedPnl) {
        try {
          const history = await this.client.callOperation<unknown>("getPositionsHistory", { category: this.category, symbol: request.symbol, limit: "20" });
          const summary = parsePositionHistorySummary(history.data);
          enriched = {
            ...enriched,
            ...(!enriched.averageFillPrice && summary.averageClosePrice ? { averageFillPrice: summary.averageClosePrice } : {}),
            ...(!enriched.realizedPnl && summary.realizedPnl ? { realizedPnl: summary.realizedPnl } : {}),
            ...(!enriched.fees && summary.fees ? { fees: summary.fees } : {}),
            ...(!enriched.funding && summary.funding ? { funding: summary.funding } : {}),
          };
        } catch {
          readbackFailure = true;
        }
      }
    }
    const providerCode = this.text(response.code);
    const providerMessage = this.text(response.msg);
    return { ...enriched, ...(providerCode ? { providerCode } : {}), ...(providerMessage ? { providerMessage } : {}), ...(readbackFailure && !enriched.realizedPnl ? { providerMessage: "REALIZED_PNL_READBACK_UNAVAILABLE" } : {}) };
  }

  private text(value: unknown, fallback = ""): string {
    return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
  }
}
