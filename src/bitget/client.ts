import { BitgetRestClient, loadConfig as loadBitgetConfig } from "@bitget-ai/bitget-agent-sdk";
import type { EvidenceBundle, ExecutionResult, ExecutionRequest, Instrument, MarketSnapshot, RuntimeConfig } from "../types.js";
import { classifyMarketRegime } from "../trading/market-regime.js";
import { parseAccount, parseFillSummary, parseHistoricalBars, parseInstruments, parsePositionHistorySummary, parsePositionSymbols, parseTicker, record } from "./types.js";

export function formatBitgetReadFailure(operation: string, symbol = "ACCOUNT"): string {
  return `BITGET_READ_FAILED_${operation}_${symbol}`;
}

export function buildOpenOrdersReadParams(category: string): Record<string, string> {
  return { category };
}

export class BitgetClient {
  private readonly client: BitgetRestClient;
  private readonly category: string;

  public constructor(config: RuntimeConfig) {
    const credentials = {
      ...(config.bitgetApiKey ? { apiKey: config.bitgetApiKey } : {}),
      ...(config.bitgetSecretKey ? { secretKey: config.bitgetSecretKey } : {}),
      ...(config.bitgetPassphrase ? { passphrase: config.bitgetPassphrase } : {}),
    };
    this.category = config.bitgetCategory;
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
    const instruments = await this.getInstruments();
    return instruments.filter((instrument) => (
      instrument.category.toUpperCase() === this.category
      && instrument.symbolType.toLowerCase() === "stock"
      && instrument.isRwa.toUpperCase() === "YES"
      && instrument.status.toLowerCase() === "online"
      && instrument.minOrderQty !== ""
      && instrument.minOrderAmount !== ""
      && instrument.leverageMax !== ""
    ));
  }

  public async getOpenPositionSymbols(): Promise<string[]> {
    const result = await this.callRead<unknown>("getPositionInfo", { category: this.category });
    return parsePositionSymbols(result.data);
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
      const instrument = instruments.find((candidate) => candidate.symbol === symbol);
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
    try {
      if (request.tradeSide === "open") {
        await this.client.callOperation<unknown>("setLeverage", {
          category: this.category,
          symbol: request.symbol,
          leverage: request.leverage,
          posSide: request.positionSide.toLowerCase(),
        });
      }
      const result = await this.client.callOperation<unknown>("placeOrder", {
        category: this.category,
        symbol: request.symbol,
        side: request.providerSide,
        orderType: "market",
        qty: request.quantity,
        posSide: request.positionSide.toLowerCase(),
        reduceOnly: request.tradeSide === "close" ? "yes" : "no",
        clientOid: request.clientOrderId,
      });
      const response = record(result.data);
      return this.readOrder(request, {
        providerOrderId: this.text(response.orderId),
        clientOrderId: this.text(response.clientOid, request.clientOrderId),
        submittedAt,
      });
    } catch (error) {
      return this.readUnknownOrder(request, submittedAt, error);
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
    } catch {
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
        providerMessage: error instanceof Error ? "PROVIDER_WRITE_UNKNOWN" : "PROVIDER_WRITE_UNKNOWN",
      };
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
      executedQuantity: this.text(response.baseVolume ?? response.filledQty ?? response.fillQty, "0"),
      status: this.normalizeStatus(response.status ?? response.state),
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

  private normalizeStatus(value: unknown): ExecutionResult["status"] {
    const status = this.text(value).toLowerCase();
    if (["new", "partially_filled", "filled", "canceled", "cancelled", "rejected"].includes(status)) return status as ExecutionResult["status"];
    return "unknown";
  }

  private text(value: unknown, fallback = ""): string {
    return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
  }
}
