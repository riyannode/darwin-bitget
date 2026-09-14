import { BitgetClient } from "../src/bitget/client.js";
import { loadConfig } from "../src/config.js";
import type { Action, Decision, Env, PositionSide } from "../src/types.js";
import { evaluateRiskGate } from "../src/trading/risk-gate.js";
import { buildExecutionRequest, executePaperOrder } from "../src/trading/execution.js";
import { reconcileExecution } from "../src/trading/reconcile.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function action(value: string | undefined): Exclude<Action, "HOLD"> {
  if (value === "OPEN_LONG" || value === "OPEN_SHORT" || value === "REDUCE" || value === "CLOSE") return value;
  throw new Error("PAPER_TEST_ACTION_INVALID");
}

function decision(actionValue: Exclude<Action, "HOLD">, symbol: string, side: PositionSide, cycleId: string, margin: string, leverage: string, reductionPct: string | null, evidenceTypes: string[]): Decision {
  return {
    decisionId: `paper-test-${crypto.randomUUID()}`,
    cycleId,
    action: actionValue,
    positionSide: side,
    symbol,
    marginAllocationPct: margin,
    leverage,
    reductionPct,
    confidence: 1,
    thesis: "EXPLICIT_PAPER_INTEGRATION_ORDER",
    strategyThesis: "EXPLICIT_PAPER_INTEGRATION_ORDER",
    supportingFactors: ["EXPLICIT_PAPER_INTEGRATION_ORDER"],
    riskFactors: ["PAPER_ONLY_BOUNDED_TEST"],
    evidenceUsed: evidenceTypes,
    lessonsUsed: [],
    createdAt: new Date().toISOString(),
  };
}

async function run(): Promise<void> {
  if (process.env.PAPER_INTEGRATION !== "1") {
    console.log("PAPER_INTEGRATION_NOT_RUN");
    return;
  }
  if (process.env.PAPER_CONFIRM_ORDER !== "YES") throw new Error("PAPER_CONFIRM_ORDER_REQUIRED");
  if (process.env.PAPER_TEST_LIFECYCLE !== "1") throw new Error("PAPER_TEST_LIFECYCLE_REQUIRED");
  const selectedAction = action(process.env.PAPER_TEST_ACTION || "OPEN_LONG");
  if (selectedAction !== "OPEN_LONG" && selectedAction !== "OPEN_SHORT") throw new Error("PAPER_TEST_LIFECYCLE_REQUIRES_OPEN");
  const selectedSide = selectedAction === "OPEN_LONG" ? "LONG" : "SHORT";
  const env: Omit<Env, "TRADER_AGENT"> = {
    TRADING_MODE: "PAPER",
    AGENT_MODE: "AUTONOMOUS",
    PAPER_ONLY: "true",
    BITGET_CATEGORY: process.env.BITGET_CATEGORY || "USDT-FUTURES",
    BITGET_GATEWAY_URL: required("BITGET_GATEWAY_URL"),
    BITGET_GATEWAY_SERVICE_SECRET: required("BITGET_GATEWAY_SERVICE_SECRET"),
    ...(process.env.MAX_SINGLE_POSITION_MARGIN_PCT ? { MAX_SINGLE_POSITION_MARGIN_PCT: process.env.MAX_SINGLE_POSITION_MARGIN_PCT } : {}),
    ...(process.env.MAX_LEVERAGE ? { MAX_LEVERAGE: process.env.MAX_LEVERAGE } : {}),
    ...(process.env.MAX_DAILY_DRAWDOWN_PCT ? { MAX_DAILY_DRAWDOWN_PCT: process.env.MAX_DAILY_DRAWDOWN_PCT } : {}),
    ...(process.env.DRAWDOWN_COOLDOWN_MINUTES ? { DRAWDOWN_COOLDOWN_MINUTES: process.env.DRAWDOWN_COOLDOWN_MINUTES } : {}),
    ...(process.env.SCAN_INTERVAL_MINUTES ? { SCAN_INTERVAL_MINUTES: process.env.SCAN_INTERVAL_MINUTES } : {}),
    ...(process.env.EMERGENCY_STOP ? { EMERGENCY_STOP: process.env.EMERGENCY_STOP } : {}),
    ...(process.env.EVIDENCE_MAX_AGE_SECONDS ? { EVIDENCE_MAX_AGE_SECONDS: process.env.EVIDENCE_MAX_AGE_SECONDS } : {}),
  };
  const config = loadConfig(env);
  const symbol = required("PAPER_TEST_SYMBOL");
  const client = new BitgetClient(config);
  const instruments = await client.getTradableInstruments();
  const instrument = instruments.find((candidate) => candidate.symbol === symbol);
  if (!instrument) throw new Error("SYMBOL_NOT_ALLOWED");
  const [bundle] = await client.collectEvidence([symbol]);
  if (!bundle) throw new Error("NO_ACCOUNT_EVIDENCE");
  const openCycleId = crypto.randomUUID();
  const openDecision = decision(selectedAction, symbol, selectedSide, openCycleId, process.env.PAPER_TEST_MARGIN_PCT?.trim() || "5", process.env.PAPER_TEST_LEVERAGE?.trim() || "1", null, bundle.evidence.map((evidence) => evidence.type));
  const openRisk = evaluateRiskGate(config, { decision: openDecision, instrument, account: bundle.account, market: bundle.market, evidenceObservedAt: bundle.market.observedAt, openOrderSymbols: bundle.account.openOrderSymbols, supportedUniverse: instruments.map((candidate) => candidate.symbol), emergencyStop: config.ownerPolicy.emergencyStop, dailyDrawdownBlocked: false });
  if (openRisk.status !== "PASS") throw new Error(`PAPER_INTEGRATION_BLOCKED:${openRisk.codes.join(",")}`);
  const openRequest = buildExecutionRequest(openDecision, bundle, openCycleId);
  const openExecution = await executePaperOrder(client, openRequest);
  const [afterOpen] = await client.collectEvidence([symbol]);
  const openedPosition = afterOpen?.account.positions.find((position) => position.symbol === symbol && position.positionSide === selectedSide);
  const openReconciliation = reconcileExecution(openRequest, openExecution, undefined, openedPosition);
  if (openReconciliation.status !== "MATCHED" || openExecution.status !== "filled" || !openedPosition) throw new Error("PAPER_INTEGRATION_OPEN_UNVERIFIED");
  const closeCycleId = crypto.randomUUID();
  const closeDecision = decision("CLOSE", symbol, selectedSide, closeCycleId, "0", openedPosition.leverage, null, afterOpen?.evidence.map((evidence) => evidence.type) ?? []);
  const closeRisk = evaluateRiskGate(config, { decision: closeDecision, instrument, account: afterOpen?.account ?? bundle.account, market: afterOpen?.market ?? bundle.market, evidenceObservedAt: afterOpen?.market.observedAt ?? bundle.market.observedAt, openOrderSymbols: afterOpen?.account.openOrderSymbols ?? [], supportedUniverse: instruments.map((candidate) => candidate.symbol), emergencyStop: config.ownerPolicy.emergencyStop, dailyDrawdownBlocked: false });
  if (closeRisk.status !== "PASS") throw new Error(`PAPER_INTEGRATION_CLOSE_BLOCKED:${closeRisk.codes.join(",")}`);
  const closeRequest = buildExecutionRequest(closeDecision, afterOpen ?? bundle, closeCycleId);
  const closeExecution = await executePaperOrder(client, closeRequest);
  const [afterClose] = await client.collectEvidence([symbol]);
  const remainingPosition = afterClose?.account.positions.find((position) => position.symbol === symbol && position.positionSide === selectedSide);
  const closeReconciliation = reconcileExecution(closeRequest, closeExecution, openedPosition, remainingPosition);
  if (closeReconciliation.status !== "MATCHED" || closeExecution.status !== "filled" || remainingPosition) throw new Error("PAPER_INTEGRATION_CLOSE_UNVERIFIED");
  if (!closeExecution.realizedPnl || !/^-?\d+(?:\.\d+)?$/.test(closeExecution.realizedPnl)) throw new Error("PAPER_INTEGRATION_REALIZED_PNL_UNAVAILABLE");
  console.log(JSON.stringify({ status: "PAPER_LIFECYCLE_VERIFIED", symbol, openAction: selectedAction, closeAction: "CLOSE", clientOrderIds: [openExecution.clientOrderId, closeExecution.clientOrderId], providerOrderIds: [openExecution.providerOrderId ?? "", closeExecution.providerOrderId ?? ""], openReconciliation: openReconciliation.status, closeReconciliation: closeReconciliation.status, realizedPnl: closeExecution.realizedPnl }));
}

run().catch((error: unknown) => {
  const code = error instanceof Error ? error.message.split(":", 1)[0] : "PAPER_INTEGRATION_FAILED";
  console.error(code);
  process.exitCode = 1;
});
