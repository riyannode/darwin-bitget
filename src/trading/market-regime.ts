import type { HistoricalBar, MarketRegime, MarketSnapshot } from "../types.js";

function numbers(values: string[]): number[] {
  return values.map(Number).filter((value) => Number.isFinite(value));
}

function average(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

export function classifyMarketRegime(market: MarketSnapshot, sourceBars: readonly HistoricalBar[]): MarketRegime {
  const bars = [...sourceBars].sort((left, right) => left.observedAt.localeCompare(right.observedAt)).slice(-48);
  const closes = numbers(bars.map((bar) => bar.close));
  if (closes.length < 4) return "UNKNOWN";
  const returns = closes.slice(1).map((close, index) => {
    const previous = closes[index];
    return previous && previous > 0 ? (close / previous - 1) * 100 : Number.NaN;
  }).filter((value) => Number.isFinite(value));
  const first = closes[0];
  const last = closes[closes.length - 1];
  if (!first || !last) return "UNKNOWN";
  const totalReturn = (last / first - 1) * 100;
  const meanReturn = average(returns);
  const variance = average(returns.map((value) => (value - meanReturn) ** 2));
  const volatility = Math.sqrt(variance);
  const ranges = bars.map((bar) => {
    const high = Number(bar.high);
    const low = Number(bar.low);
    const close = Number(bar.close);
    return close > 0 ? ((high - low) / close) * 100 : Number.NaN;
  }).filter((value) => Number.isFinite(value));
  const averageRange = average(ranges);
  const recentRange = ranges[ranges.length - 1] ?? averageRange;
  const positiveShare = returns.length ? returns.filter((value) => value > 0).length / returns.length : 0;
  const negativeShare = returns.length ? returns.filter((value) => value < 0).length / returns.length : 0;
  const tickerChange = Number(market.priceChange24h) * 100;
  if (recentRange > averageRange * 1.75 && recentRange > 1.5) return "VOLATILITY_EXPANSION";
  if (Math.abs(totalReturn) >= 2 && positiveShare >= 0.62) return "TRENDING_UP";
  if (Math.abs(totalReturn) >= 2 && negativeShare >= 0.62) return "TRENDING_DOWN";
  if (Math.abs(totalReturn) < 1 && volatility < 0.5 && Math.abs(tickerChange) < 3) return "RANGE_LOW_VOL";
  if (Math.abs(totalReturn) < 2 || volatility < 1.5) return "RANGE_HIGH_VOL";
  return "UNKNOWN";
}
