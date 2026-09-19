const $ = (id) => document.getElementById(id);
const text = (value, fallback = "—") => value === undefined || value === null || value === "" ? fallback : String(value);
const money = (value) => value === undefined || value === null || value === "" || value === "UNAVAILABLE" ? "—" : `$${value}`;
const signedMoney = (value) => { if (value === undefined || value === null || value === "" || value === "UNAVAILABLE") return "—"; const raw = String(value); return raw.startsWith("-") ? `-$${raw.slice(1)}` : raw.startsWith("+") ? `+$${raw.slice(1)}` : `$${raw}`; };
const percent = (value) => { if (value === undefined || value === null || value === "") return "—"; const numeric = Number(value); return Number.isFinite(numeric) ? `${numeric.toFixed(4)}%` : "—"; };
const pnlClass = (value) => { const numeric = Number(String(value).replace(/[$%]/g, "")); return numeric > 0 ? "pnl-positive" : numeric < 0 ? "pnl-negative" : ""; };
const when = (value) => { if (!value) return "—"; const raw = String(value); const date = /^\d{11,}$/.test(raw) ? new Date(Number(raw)) : new Date(raw); return Number.isNaN(date.getTime()) ? raw : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };
const list = (values) => Array.isArray(values) && values.length ? values.join(" · ") : "—";
let snapshot = {
  agent: { status: "UNAVAILABLE", runtimeMode: "AUTONOMOUS", currentStage: "STATE_READ_FAILED", lastScan: null, nextScan: null, model: "—", paperMode: true },
  portfolio: null,
  portfolioFreshness: { source: "UNAVAILABLE", observedAt: new Date().toISOString(), stale: true, errorCode: "LIVE_PORTFOLIO_REQUIRED" },
  performance: { totalPnl: "UNAVAILABLE", winRate: "UNAVAILABLE", dailyDrawdown: "UNAVAILABLE", totalTrades: null, openTrades: null, closedTrades: null, wins: null, losses: null, breakeven: null, dailyPnl: {} },
  performanceAccounting: { baselineEquity: null, baselineObservedAt: null, currentEquity: null, currentEquityObservedAt: null, netExternalInflows: "UNAVAILABLE", netPnlSinceBaseline: "UNAVAILABLE", closedEpisodeRealizedPnl: "UNAVAILABLE", openEpisodePartialRealizedPnl: "UNAVAILABLE", verifiedRealizedPnl: "UNAVAILABLE", unrealizedPnl: "UNAVAILABLE", wins: 0, losses: 0, breakeven: 0, classifiedClosedTrades: 0, winRatePct: "UNAVAILABLE", peakEquity: null, peakEquityObservedAt: null, currentDrawdownPct: "UNAVAILABLE", maxDrawdownPct: "UNAVAILABLE", source: "UNAVAILABLE", externalFlowStatus: "UNVERIFIED_ZERO_FLOW_INVARIANT", baselineSource: "UNAVAILABLE", initializationReason: "UNAVAILABLE", competitionStartVerified: false, unrealizedPnlSource: "UNAVAILABLE" },
  trades: [],
  latestDecision: null,
  decisions: [],
  latestCyclePlan: null,
  latestCycleStatus: null,
  cyclePlans: [],
  latestDiscovery: null,
  executionEvidence: null,
  scheduler: { completedCycles: 0, averageDurationMs: 0, maxDurationMs: 0, inProgressCount: 0, staleCount: 0, failureCount: 0, timeoutCount: 0 },
  learning: { reflection: null, lessons: [], lessonsUsed: [], backtest: null, recentExperiences: [] },
  riskControls: { paperOnly: true, maxSinglePositionMarginPct: "—", maxLeverage: "—", maxDailyDrawdownPct: "—", drawdownCooldownMinutes: 0, scanIntervalMinutes: 0, emergencyStop: false, drawdownBlocked: false, drawdownCode: "", cooldownUntil: null, temporaryScanIntervalExpiresAt: null },
  activity: [],
  lastPolicyUpdate: null,
};
let livePortfolio = null;
let liveFreshness = snapshot.portfolioFreshness;
let loadedPages = new Set();
let pageLoadedAt = new Map();
let tradeFilter = "ALL";
let ownerToken = "";
let positionContexts = {};
let positionContextsLoadedAt = 0;
let selectedTradeId = null;
let currentPage = "dashboard";
const judgeDemo = window.location.pathname === "/demo";
const initialDemoBanner = $("judge-demo-banner"); if (initialDemoBanner) initialDemoBanner.hidden = !judgeDemo;

function detail(label, value, wide = false) {
  const node = document.createElement("div");
  if (wide) node.className = "wide";
  const title = document.createElement("span"); title.className = "label"; title.textContent = label;
  const content = document.createElement("span"); content.className = "value"; content.textContent = text(value);
  node.append(title, content); return node;
}

function reasoningSection(title, reasoning, unavailableText) {
  const section = document.createElement("section");
  const heading = document.createElement("h3"); heading.textContent = title; section.append(heading);
  if (!reasoning) { const empty = document.createElement("p"); empty.className = "subtle"; empty.textContent = unavailableText; section.append(empty); return section; }
  [detail("THESIS", reasoning.thesis, true), detail("STRATEGY THESIS", reasoning.strategyThesis, true), detail("ENTRY PRICE", money(reasoning.entryPrice)), detail("ENTRY TIME", when(reasoning.entryTime)), detail("EXPERIENCE ID", reasoning.experienceId), detail("SUPPORTING FACTORS", list(reasoning.supportingFactors), true), detail("RISKS CONSIDERED", list(reasoning.riskFactors), true), detail("EVIDENCE USED", list(reasoning.evidenceUsed), true), detail("LESSONS USED", list(reasoning.lessonsUsed), true), detail("CONFIDENCE", reasoning.confidence), detail("DECISION / CYCLE", `${reasoning.decisionId} / ${reasoning.cycleId}`), detail("DECISION TIME", when(reasoning.createdAt))].forEach((item) => section.append(item));
  return section;
}

function renderAgent() {
  const agent = snapshot.agent;
  $("agent-status").textContent = agent.status;
  $("agent-stage").textContent = `Stage ${text(agent.currentStage)}`;
  $("agent-mode").textContent = `${agent.runtimeMode} / ${agent.paperMode ? "PAPER" : "UNKNOWN"}`;
  $("agent-model").textContent = text(agent.model);
  $("sidebar-model").textContent = text(agent.model);
  $("last-scan").textContent = when(agent.lastScan);
  $("next-scan").textContent = when(agent.nextScan);
  $("top-status").replaceChildren(); const dot = document.createElement("i"); $("top-status").append(dot, document.createTextNode(` ${agent.status}`));
  const statusColor = agent.status === "ERROR" ? "var(--danger)" : agent.status === "COOLDOWN" || agent.status === "PAUSED" ? "var(--warning)" : "var(--accent)";
  $("top-status").style.color = statusColor;
  const cooldown = $("cooldown-notice"); cooldown.hidden = !snapshot.riskControls.drawdownBlocked; if (!cooldown.hidden) cooldown.textContent = `TRADING COOLDOWN · FINANCIAL WRITES PAUSED · RESUMES ${when(snapshot.riskControls.cooldownUntil)} · ${agent.currentStage === "COOLDOWN" ? "LEARNING / REPLAY CONTINUES" : "OBSERVATION CONTINUES"}`;
}

function renderPerformance() {
  const performance = snapshot.performance;
  const accounting = snapshot.performanceAccounting ?? {};
  const values = [["EQUITY CHANGE FROM FIRST RECORDED SNAPSHOT", money(accounting.netPnlSinceBaseline ?? performance.totalPnl)], ["WIN RATE — CLOSED TRADES WITH VERIFIED PNL", accounting.winRatePct && accounting.winRatePct !== "UNAVAILABLE" ? `${accounting.winRatePct}%` : "—"], ["TODAY'S EQUITY DROP FROM DAILY START", percent(performance.dailyDrawdown)], ["CURRENT DROP FROM PEAK EQUITY", percent(accounting.currentDrawdownPct)], ["CLOSED TRADES WITH VERIFIED PNL", accounting.classifiedClosedTrades ?? performance.closedTrades ?? "—"], ["OPEN TRADES TRACKED BY DARWIN", performance.openTrades ?? "—"], ["OPEN POSITIONS ON BITGET", (judgeDemo ? snapshot.portfolio : livePortfolio)?.positions?.length ?? 0]];
  const breakdown = [["CLOSED TRADES REALIZED PNL", accounting.closedEpisodeRealizedPnl], ["PARTIAL-CLOSE PNL FROM OPEN TRADES", accounting.openEpisodePartialRealizedPnl], ["TOTAL VERIFIED REALIZED PNL", accounting.verifiedRealizedPnl]];
  const node = $("performance"); node.replaceChildren();
  const card = (label, value, signed = false) => { const item = document.createElement("div"); item.className = "summary-card"; const title = document.createElement("small"); title.textContent = label; const content = document.createElement("strong"); content.textContent = signed ? signedMoney(value) : text(value); if (signed) content.className = pnlClass(value); item.append(title, content); return item; };
  values.forEach(([label, value]) => node.append(card(label, value)));
  breakdown.forEach(([label, value]) => node.append(card(label, value, true)));
  const audit = document.createElement("small"); audit.className = "subtle"; audit.style.whiteSpace = "pre-line"; audit.textContent = `Source: ${judgeDemo ? "Recorded PAPER replay" : "Bitget PAPER"} · Updated: ${when(accounting.currentEquityObservedAt)}\nStarting reference: first recorded equity snapshot (${money(accounting.baselineEquity)})\nCompetition start verified: ${accounting.competitionStartVerified === true ? "Yes" : "No"} · External account flows verified: ${accounting.externalFlowStatus === "VERIFIED" ? "Yes" : "No"}`; node.append(audit);
}

function renderCalendar() {
  const node = $("calendar"); node.replaceChildren();
  ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].forEach((label) => { const item = document.createElement("span"); item.className = "day-label"; item.textContent = label; node.append(item); });
  const now = new Date(); const year = now.getUTCFullYear(); const month = now.getUTCMonth(); const first = new Date(Date.UTC(year, month, 1)); const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); const offset = (first.getUTCDay() + 6) % 7; $("calendar-month").textContent = now.toLocaleString([], { month: "short", year: "numeric", timeZone: "UTC" });
  for (let index = 0; index < 42; index += 1) { const day = index - offset + 1; const item = document.createElement("span"); if (day > 0 && day <= days) { const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`; const value = snapshot.performance.dailyPnl[key]; item.textContent = value ? `${day}\n${value.pnl >= 0 ? "+" : ""}${value.pnl}\n${value.trades} trade${value.trades === 1 ? "" : "s"}` : String(day); item.style.whiteSpace = "pre-line"; if (value?.pnl > 0) item.className = "profit"; if (value?.pnl < 0) item.className = "loss"; if (value?.pnl === "0" || value?.pnl === 0) item.className = "zero"; } node.append(item); }
}

function renderPortfolio() {
  const portfolio = judgeDemo ? snapshot.portfolio : livePortfolio;
  const freshness = judgeDemo ? { source: "RECORDED_PROVIDER_REPLAY", observedAt: snapshot.portfolioFreshness.observedAt, stale: true } : liveFreshness; const freshnessNode = $("portfolio-freshness"); freshnessNode.textContent = freshness ? `${freshness.source === "PROVIDER_LIVE" ? "Source: Bitget PAPER" : freshness.source === "RECORDED_PROVIDER_REPLAY" ? "Source: Recorded PAPER replay" : "Source: unavailable"} · Updated: ${when(freshness.observedAt)}` : "—"; freshnessNode.style.color = freshness?.stale ? "var(--warning)" : "var(--accent)";
  const node = $("portfolio"); node.replaceChildren(); [["ACCOUNT EQUITY", money(portfolio?.portfolioEquity)], ["AVAILABLE MARGIN", money(portfolio?.availableMargin)], ["ACCOUNT MARGIN USED", money(portfolio?.accountMarginUsed)], ["INITIAL MARGIN", money(portfolio?.initialMargin)], ["TOTAL POSITION MARGIN", money(portfolio?.positionMargin)], ["OPEN POSITIONS UNREALIZED PNL", signedMoney(portfolio?.unrealizedPnl)], ["OPEN POSITIONS REALIZED PNL", signedMoney(portfolio?.positionRealizedPnl)], ["FUNDING", signedMoney(portfolio?.funding)], ["FEES", signedMoney(portfolio?.fees)], ["CASH DIVIDEND", signedMoney(portfolio?.cashDividend)], ["OPEN POSITIONS ON BITGET", portfolio?.positions?.length ?? 0]].forEach(([label, value]) => { const item = document.createElement("div"); const title = document.createElement("span"); title.className = "label"; title.textContent = label; const content = document.createElement("strong"); content.textContent = text(value); if (label.includes("PNL") || label === "FUNDING" || label === "FEES" || label === "CASH DIVIDEND") content.className = pnlClass(value); item.append(title, content); node.append(item); });
}

function renderOpenPositions() {
  const node = $("open-positions");
  const freshness = judgeDemo ? { source: "RECORDED_PROVIDER_REPLAY", observedAt: snapshot.portfolioFreshness.observedAt, stale: true } : liveFreshness;
  const freshnessNode = $("open-position-freshness");
  freshnessNode.textContent = judgeDemo ? "Source: Recorded PAPER replay · Not live provider state" : freshness ? `${freshness.source === "PROVIDER_LIVE" ? "Source: Bitget PAPER" : "Source: unavailable"} · Updated: ${when(freshness.observedAt)}` : "—";
  freshnessNode.style.color = freshness?.stale || freshness?.source !== "PROVIDER_LIVE" ? "var(--warning)" : "var(--accent)";
  const openKeys = new Set([...node.querySelectorAll("details[data-stable-key]")].filter((item) => item.open).map((item) => item.dataset.stableKey));
  const positions = (judgeDemo ? snapshot.portfolio : livePortfolio)?.positions ?? [];
  node.replaceChildren();
  node.className = positions.length ? "position-cards" : "position-cards empty";
  if (!positions.length) { node.textContent = "No open provider positions."; return; }
  positions.forEach((position) => {
    const key = `${position.symbol}:${position.positionSide}`;
    const card = document.createElement("details");
    card.className = "position-card";
    card.dataset.stableKey = key;
    card.open = openKeys.has(key);
    const summary = document.createElement("summary");
    summary.className = "position-summary";
    const identity = document.createElement("strong");
    identity.textContent = `${position.symbol} / ${position.positionSide}`;
    const metrics = document.createElement("span");
    metrics.className = "position-summary-metrics";
    const pnl = document.createElement("span");
    pnl.className = pnlClass(position.unrealizedPnl);
    pnl.textContent = `Unrealized PnL: ${signedMoney(position.unrealizedPnl)}`;
    const pnlPct = document.createElement("span");
    pnlPct.className = pnlClass(position.unrealizedPnlPct);
    pnlPct.textContent = percent(position.unrealizedPnlPct);
    const mark = document.createElement("span");
    mark.textContent = `Mark: ${money(position.markPrice)}`;
    metrics.append(pnl, pnlPct, mark);
    summary.append(identity, metrics);
    const content = document.createElement("div");
    content.className = "detail-grid position-details";
    [["SYMBOL", position.symbol], ["SIDE", position.positionSide], ["ENTRY", money(position.entryPrice)], ["MARK", money(position.markPrice)], ["QTY", position.quantity], ["MARGIN", money(position.marginAllocated)], ["LEVERAGE", `${position.leverage}x`], ["NOTIONAL", money(position.notional)], ["UNREALIZED PNL", signedMoney(position.unrealizedPnl)], ["REALIZED PNL", signedMoney(position.realizedPnl)], ["FUNDING", signedMoney(position.funding)], ["FEES", signedMoney(position.fees)], ["UNREALIZED PNL %", percent(position.unrealizedPnlPct)], ["LIQUIDATION PRICE", money(position.liquidationPrice)], ["OPENED AT", when(position.openedAt)], ["UPDATED AT", when(position.updatedAt)]].forEach(([label, value]) => { const item = detail(label, value); if (label.startsWith("UNREALIZED")) item.querySelector(".value").className = `value ${pnlClass(value)}`; content.append(item); });
    const context = positionContexts[`${position.symbol}:${position.positionSide}`];
    const reasoning = document.createElement("div"); reasoning.className = "position-reasoning";
    reasoning.append(reasoningSection("WHY THIS POSITION WAS OPENED", context?.entryReasoning, "Provider position present; verified DARWIN entry context unavailable."), reasoningSection("CURRENT MANAGEMENT", context?.latestManagement, "No persisted DARWIN management decision available."));
    card.append(summary, content, reasoning);
    node.append(card);
  });
}

function appendDecisionDetails(node, decision, positionNotional, executionRecord) {
  const execution = executionRecord?.executionResult;
  const after = executionRecord?.positionAfter;
  [detail("MARGIN", `${decision.marginAllocationPct}%`), detail("ADDITIONAL MARGIN", decision.additionalMarginPct ? `${decision.additionalMarginPct}%` : "—"), detail("TARGET SIDE", decision.targetPositionSide ?? "—"), detail("LEVERAGE", `${execution?.leverage ?? decision.leverage}x`), detail("CONFIDENCE", decision.confidence), detail("POSITION NOTIONAL", money(positionNotional ?? after?.notional ?? (decision.action === "HOLD" ? "0" : undefined))), detail("RESULTING MARGIN", money(after?.marginAllocated)), detail("THESIS", decision.thesis, true), detail("STRATEGY THESIS", decision.strategyThesis, true), detail("SUPPORTING FACTORS", list(decision.supportingFactors), true), detail("RISK FACTORS", list(decision.riskFactors), true), detail("EVIDENCE USED", list(decision.evidenceUsed), true), detail("LESSONS USED", list(decision.lessonsUsed), true)].forEach((item) => node.append(item));
}

function renderDecisionPanel(prefix, decision, positionNotional) {
  const id = (suffix) => prefix ? `${prefix}-${suffix}` : suffix;
  const action = $(id("decision-action"));
  const summary = $(id("decision-summary"));
  const details = $(id("decision-details"));
  const node = $(id("decision"));
  action.textContent = decision?.action ?? "—";
  summary.replaceChildren();
  node.replaceChildren();
  summary.className = decision ? "detail-grid" : "detail-grid empty";
  details.hidden = !decision;
  if (!decision) { summary.textContent = "No Qwen decision recorded yet."; return; }
  [detail("SYMBOL / SIDE", `${decision.symbol} / ${decision.positionSide ?? "—"}`), detail("TIMESTAMP", when(decision.createdAt))].forEach((item) => summary.append(item));
  appendDecisionDetails(node, decision, positionNotional);
}

function renderActionSection(title, actions, records = []) {
  const section = document.createElement("section");
  const heading = document.createElement("h3"); heading.textContent = title; section.append(heading);
  if (!actions?.length) { const empty = document.createElement("p"); empty.className = "subtle"; empty.textContent = title === "NEW ENTRY ACTIONS" || title === "NEW ENTRIES" ? "No new entry justified this cycle." : "No position management actions recorded."; section.append(empty); return section; }
  actions.forEach((action) => { const item = document.createElement("details"); item.className = "history-item"; const summary = document.createElement("summary"); summary.append(detail("SYMBOL / SIDE", `${action.symbol} / ${action.positionSide ?? "—"}`), detail("ACTION", action.action), detail("CONFIDENCE", action.confidence)); const content = document.createElement("div"); content.className = "detail-grid history-content"; const actionRecords = records.filter((record) => record.parentDecisionId === action.decisionId || record.decision?.decisionId === action.decisionId); appendDecisionDetails(content, action, undefined, actionRecords.find((record) => record.decision?.action === "INCREASE") ?? actionRecords[0]); if (action.action === "REVERSE") { const close = actionRecords.find((record) => record.decision?.action === "CLOSE"); const open = actionRecords.find((record) => record.decision?.action === "OPEN_LONG" || record.decision?.action === "OPEN_SHORT"); content.append(detail("PREVIOUS SIDE", action.positionSide), detail("TARGET SIDE", action.targetPositionSide), detail("CLOSE VERIFICATION", close?.reconciliationResult?.status ?? close?.riskGateResult?.status ?? "NOT RUN"), detail("OPPOSITE ENTRY RESULT", open?.reconciliationResult?.status ?? open?.riskGateResult?.status ?? "NOT RUN")); } item.append(summary, content); section.append(item); });
  return section;
}

function renderCycleStatus(prefix) {
  const node = $(prefix === "dashboard" ? "dashboard-cycle-status" : "journal-cycle-status");
  if (!node) return;
  node.replaceChildren();
  const status = snapshot.latestCycleStatus;
  if (!status) { node.className = "cycle-status empty"; node.textContent = "No cycle status recorded yet."; return; }
  node.className = `cycle-status ${status.status.toLowerCase()}`;
  const title = document.createElement("strong");
  title.textContent = status.status === "FAILED" ? (status.hasPersistedPlan ? "CYCLE FAILED AFTER PLAN CREATION" : "CYCLE FAILED BEFORE DECISION") : status.status === "RUNNING" ? "ANALYZING / IN PROGRESS" : "CYCLE COMPLETED";
  node.append(title, detail("STATUS", status.status), detail("CYCLE ID", status.cycleId), detail("STARTED", when(status.startedAt)));
  if (status.failureCode) node.append(detail("FAILURE", status.failureCode));
  if (status.failurePath) node.append(detail("PATH", status.failurePath));
  if (status.failureIssue) node.append(detail("ISSUE", status.failureIssue));
}

function renderCyclePlan(prefix, plan, discovery) {
  renderCycleStatus(prefix);
  const node = $(prefix === "dashboard" ? "dashboard-cycle-plan" : "cycle-plan");

  if (!node) return;
  node.replaceChildren();
  if (!plan) { node.className = "stack empty"; node.textContent = "No valid cycle plan recorded yet."; return; }
  node.className = "cycle-plan stack";
  node.append(renderActionSection("POSITION MANAGEMENT", plan.positionActions, plan.records ?? []), renderActionSection("NEW ENTRY ACTIONS", plan.entryActions, plan.records ?? []));
  const discoveryNode = $(prefix === "dashboard" ? "dashboard-market-discovery" : "market-discovery");
  if (discoveryNode) {
    discoveryNode.replaceChildren();
    discoveryNode.append(detail("UNIVERSE SCANNED", discovery?.scannedUniverseCount ?? "—"), detail("ENTRY CANDIDATES", list(discovery?.selectedEntryCandidateSymbols), true), detail("EXISTING POSITIONS MANAGED", list(discovery?.managedExistingPositionSymbols), true), detail("TOTAL PROPOSED ACTIONS", (plan.positionActions?.length ?? 0) + (plan.entryActions?.length ?? 0)), detail("FINANCIAL WRITES", discovery?.financialWritesPerformed ?? 0));
  }
}

function renderDecision() {
  const hasCyclePlan = Boolean(snapshot.latestCyclePlan);
  document.querySelectorAll("[data-legacy-decision-panel]").forEach((panel) => { panel.hidden = hasCyclePlan; });
  if (!hasCyclePlan) {
    const decision = snapshot.latestDecision;
    renderDecisionPanel("", decision, snapshot.executionEvidence?.positionNotional);
    renderDecisionPanel("dashboard", decision, snapshot.executionEvidence?.positionNotional);
  }
  renderCyclePlan("dashboard", snapshot.latestCyclePlan, snapshot.latestDiscovery);
}

function renderDecisionHistory() {
  const node = $("decision-history");
  const cycles = Array.isArray(snapshot.cyclePlans) ? snapshot.cyclePlans.slice(0, 25) : [];
  const openKeys = new Set([...node.querySelectorAll("details[data-stable-key]")].filter((item) => item.open).map((item) => item.dataset.stableKey));
  node.replaceChildren();
  node.className = cycles.length ? "decision-history" : "decision-history empty";
  if (!cycles.length) { node.textContent = "No decisions recorded yet."; return; }
  cycles.forEach((cycle) => {
    const item = document.createElement("details");
    item.className = "history-item";
    item.dataset.stableKey = cycle.cycleId || "RUN_UNKNOWN";
    item.open = openKeys.has(item.dataset.stableKey);
    const summary = document.createElement("summary");
    const status = cycle.status ?? "COMPLETED";
    const actionCount = cycle.hasPersistedPlan ? cycle.plan.positionActions.length + cycle.plan.entryActions.length : "UNAVAILABLE";
    summary.append(detail("CYCLE ID", cycle.cycleId || "RUN_UNKNOWN"), detail("TIMESTAMP", when(cycle.startedAt)), detail("STATUS", status), detail("ACTIONS", actionCount));
    const content = document.createElement("div");
    content.className = "detail-grid history-content";
    if (status === "FAILED") {
      content.append(detail("STATUS", cycle.hasPersistedPlan ? "CYCLE FAILED AFTER PLAN CREATION" : "CYCLE FAILED BEFORE DECISION"), detail("DECISION PLAN", cycle.hasPersistedPlan ? "Persisted plan retained as failed-cycle audit evidence." : "Decision plan not produced."));
      if (cycle.failureCode) content.append(detail("FAILURE", cycle.failureCode));
      if (cycle.failurePath) content.append(detail("PATH", cycle.failurePath));
      if (cycle.failureIssue) content.append(detail("ISSUE", cycle.failureIssue));
      if (cycle.hasPersistedPlan) content.append(renderActionSection("FAILED-CYCLE AUDIT EVIDENCE — POSITION MANAGEMENT", cycle.plan.positionActions, cycle.records ?? []), renderActionSection("FAILED-CYCLE AUDIT EVIDENCE — NEW ENTRIES", cycle.plan.entryActions, cycle.records ?? []));
    } else if (status === "RUNNING") {
      content.textContent = "ANALYZING / IN PROGRESS";
    } else if (cycle.hasValidPlan) {
      content.append(renderActionSection("POSITION MANAGEMENT", cycle.plan.positionActions, cycle.records ?? []), renderActionSection("NEW ENTRIES", cycle.plan.entryActions, cycle.records ?? []));
    } else {
      content.textContent = "No valid cycle plan recorded.";
    }
    item.append(summary, content);
    node.append(item);
  });
}

function renderLearning() {
  const learning = snapshot.learning; const node = $("learning"); node.replaceChildren(); node.className = "stack";
  if (learning.reflection) node.append(detail("RECENT REFLECTION", learning.reflection.lesson, true), detail("OUTCOME", learning.reflection.outcome), detail("LESSONS USED", list(learning.lessonsUsed), true)); else { node.className = "stack empty"; node.textContent = "No reflection recorded yet."; }
  learning.lessons.slice(0, 3).forEach((lesson) => { const item = document.createElement("div"); item.className = "lesson"; item.textContent = `${lesson.source} · ${lesson.status} · ${lesson.lesson}`; node.append(item); });
}

function renderRecentTrades() {
  const node = $("recent-trades"); node.replaceChildren(); node.className = snapshot.trades.length ? "recent-trades" : "recent-trades empty";
  if (!snapshot.trades.length) { node.textContent = "No recent trades"; return; }
  snapshot.trades.slice(0, 7).forEach((trade) => { const row = document.createElement("div"); row.className = "recent-row"; const time = document.createElement("small"); time.textContent = when(trade.timestamp); const main = document.createElement("span"); const symbol = document.createElement("strong"); symbol.textContent = trade.symbol; const action = document.createElement("small"); action.className = "action"; action.textContent = trade.action; main.append(symbol, action); const result = document.createElement("span"); result.textContent = trade.status; row.append(time, main, result); node.append(row); });
}

function renderLatestTrade() {
  const trade = snapshot.trades.find((candidate) => candidate.tradeId === selectedTradeId) ?? snapshot.trades[0];
  const summary = $("latest-trade-summary");
  const node = $("latest-trade");
  summary.replaceChildren();
  node.replaceChildren();
  $("latest-trade-status").textContent = trade?.status ?? "—";
  $("latest-trade-details").hidden = !trade;
  summary.className = trade ? "detail-grid" : "detail-grid empty";
  if (!trade) { summary.textContent = "No verified PAPER trade recorded yet."; return; }
  [detail("TIME", when(trade.timestamp)), detail("SYMBOL / SIDE", `${trade.symbol} / ${trade.positionSide ?? "—"}`), detail("ACTION", trade.action), detail("STATUS", trade.status)].forEach((item) => summary.append(item));
  [detail("MARGIN", `${trade.marginAllocationPct}% / ${money(trade.marginAllocated)}`), detail("LEVERAGE", `${trade.leverage}x`), detail("POSITION NOTIONAL", money(trade.positionNotional)), detail("ENTRY", trade.entry), detail("EXIT", trade.exit), detail("REALIZED PNL", money(trade.realizedPnl)), detail("ORDER REFERENCE", trade.orderReference)].forEach((item) => node.append(item));
  node.append(reasoningSection("WHY THIS TRADE WAS OPENED", trade.entryReasoning, "Verified opening exists; structured entry reasoning unavailable."));
  if (trade.exitReasoning) node.append(reasoningSection("WHY THIS TRADE WAS CLOSED", trade.exitReasoning, "Structured close reasoning unavailable."));
  if (trade.managementEvents?.length) {
    const lifecycle = document.createElement("section");
    const heading = document.createElement("h3"); heading.textContent = "POSITION LIFECYCLE"; lifecycle.append(heading);
    trade.managementEvents.forEach((event) => lifecycle.append(reasoningSection(event.action, event, "Management reasoning unavailable.")));
    node.append(lifecycle);
  }
  [detail("PROVIDER CODE", snapshot.executionEvidence?.providerCode), detail("PROVIDER MESSAGE", snapshot.executionEvidence?.providerMessage, true), detail("READBACK CODE", snapshot.executionEvidence?.providerReadbackCode), detail("READBACK MESSAGE", snapshot.executionEvidence?.providerReadbackMessage, true)].forEach((item) => node.append(item));
}

function renderActivity() {
  const node = $("activity"); node.replaceChildren(); node.className = snapshot.activity.length ? "activity" : "activity empty";
  if (!snapshot.activity.length) { node.textContent = "No events recorded yet."; return; }
  snapshot.activity.forEach((event) => { const item = document.createElement("div"); item.className = "activity-item"; const type = document.createElement("span"); type.className = "activity-type"; type.textContent = event.type; const time = document.createElement("span"); time.className = "activity-time"; time.textContent = when(event.createdAt); item.append(type, time); node.append(item); });
}

function renderTradeTable() {
  const node = $("trade-table"); node.replaceChildren(); const trades = snapshot.trades.filter((trade) => tradeFilter === "ALL" || (tradeFilter === "OPEN" && (trade.status === "OPEN" || trade.status === "PARTIALLY_REDUCED")) || (tradeFilter === "CLOSED" && trade.status === "CLOSED") || (tradeFilter === "WIN" && Number(trade.realizedPnl) > 0) || (tradeFilter === "LOSS" && Number(trade.realizedPnl) < 0));
  trades.forEach((trade) => { const row = document.createElement("tr"); row.tabIndex = 0; row.addEventListener("click", () => { selectedTradeId = trade.tradeId; renderLatestTrade(); }); [when(trade.timestamp), trade.symbol, trade.action, `${trade.marginAllocationPct}% / ${money(trade.marginAllocated)}`, `${trade.leverage}x`, money(trade.positionNotional), trade.entry, trade.exit, money(trade.realizedPnl), trade.status].forEach((value, index) => { const cell = document.createElement("td"); cell.textContent = text(value); if (index === 2) cell.className = "table-action"; row.append(cell); }); node.append(row); });
}

function renderLessons() {
  const node = $("lesson-table"); node.replaceChildren(); snapshot.learning.lessons.forEach((lesson) => { const row = document.createElement("tr"); [lesson.lesson, lesson.source, `${lesson.symbolScope} / ${lesson.marketRegime}`, lesson.confidence, lesson.timesRetrieved, lesson.timesApplied, lesson.successfulApplications, lesson.failedApplications, lesson.status, when(lesson.createdAt)].forEach((value) => { const cell = document.createElement("td"); cell.textContent = text(value); row.append(cell); }); node.append(row); });
  const replay = snapshot.learning.backtest; const card = $("replay-card"); card.replaceChildren(); card.hidden = !replay; if (replay) { const heading = document.createElement("div"); heading.className = "panel-heading"; const title = document.createElement("h2"); title.textContent = "BACKTEST / REPLAY"; const badge = document.createElement("span"); badge.className = "pill"; badge.textContent = "BOUNDED"; heading.append(title, badge); card.append(heading, detail("TRIGGER", replay.trigger), detail("ALTERNATIVES", replay.hypotheses.length), detail("RESULT", replay.selectedLesson, true)); }
}

function renderPolicy() {
  const policy = snapshot.riskControls; const node = $("policy"); node.replaceChildren(); [["PAPER_ONLY", policy.paperOnly], ["MAX_SINGLE_POSITION_MARGIN_PCT", `${policy.maxSinglePositionMarginPct}% / hard 30%`], ["MAX_LEVERAGE", `${policy.maxLeverage}x / hard 5x`], ["MAX_DAILY_DRAWDOWN_PCT", `${policy.maxDailyDrawdownPct}% / hard 20%`], ["DRAWDOWN_COOLDOWN_MINUTES", `${policy.drawdownCooldownMinutes}m`], ["SCAN_INTERVAL_MINUTES", `${policy.scanIntervalMinutes}m`], ["EMERGENCY_STOP", policy.emergencyStop]].forEach(([label, value]) => { const item = document.createElement("div"); const title = document.createElement("span"); title.className = "label"; title.textContent = label; const content = document.createElement("strong"); content.textContent = text(value); item.append(title, content); node.append(item); });
  const editor = $("policy-editor"); editor.replaceChildren();
  if (judgeDemo) { editor.hidden = true; return; }
  editor.hidden = false;
  [["MAX_LEVERAGE", "maxLeverage", policy.maxLeverage, "1–5"], ["MAX_SINGLE_POSITION_MARGIN_PCT", "maxSinglePositionMarginPct", policy.maxSinglePositionMarginPct, "1–30"], ["MAX_DAILY_DRAWDOWN_PCT", "maxDailyDrawdownPct", policy.maxDailyDrawdownPct, "1–20"], ["DRAWDOWN_COOLDOWN_MINUTES", "drawdownCooldownMinutes", policy.drawdownCooldownMinutes, "5–1440"], ["SCAN_INTERVAL_MINUTES", "scanIntervalMinutes", policy.scanIntervalMinutes, ">0"]].forEach(([label, key, value, range]) => { const item = document.createElement("label"); item.className = "policy-input"; const title = document.createElement("span"); title.className = "label"; title.textContent = `${label} (${range})`; const input = document.createElement("input"); input.name = key; input.value = String(value); input.inputMode = "decimal"; input.dataset.policyField = key; item.append(title, input); editor.append(item); });
  const auth = document.createElement("label"); auth.className = "policy-input policy-token"; const authTitle = document.createElement("span"); authTitle.className = "label"; authTitle.textContent = "OWNER CONTROL TOKEN"; const authInput = document.createElement("input"); authInput.type = "password"; authInput.placeholder = "Bearer token"; authInput.value = ownerToken; authInput.addEventListener("input", () => { ownerToken = authInput.value; }); auth.append(authTitle, authInput); editor.append(auth);
  const save = document.createElement("button"); save.className = "button button-primary"; save.textContent = "Save Policy"; save.addEventListener("click", savePolicy); editor.append(save);
  const version = document.createElement("span"); version.className = "subtle"; version.textContent = `Last update: ${when(snapshot.lastPolicyUpdate?.createdAt)} · ${snapshot.version} · ${snapshot.commit} · ${snapshot.environment}`; editor.append(version);
}

function render() { renderAgent(); renderPerformance(); renderCalendar(); renderPortfolio(); renderOpenPositions(); renderDecision(); renderCyclePlan("journal", snapshot.latestCyclePlan, snapshot.latestDiscovery); renderDecisionHistory(); renderLearning(); renderRecentTrades(); renderLatestTrade(); renderActivity(); renderTradeTable(); renderLessons(); renderPolicy(); const banner = $("judge-demo-banner"); banner.hidden = !judgeDemo; if (judgeDemo) { document.querySelectorAll("[data-action]").forEach((button) => { button.hidden = true; button.disabled = true; }); document.querySelectorAll(".label").forEach((node) => { if (node.textContent === "LIVE READBACK") node.textContent = "RECORDED REPLAY"; }); banner.dataset.scenario = snapshot.demo?.title ?? "DETERMINISTIC REPLAY"; $("judge-demo-result").textContent = `RISK GATE ${snapshot.demoRiskGate?.status ?? "—"}${snapshot.demoRiskGate?.codes?.length ? ` · ${snapshot.demoRiskGate.codes.join(" / ")}` : ""}`; } }

async function requestJson(path) { const response = await fetch(path, { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP_${response.status}`); return response.json(); }
async function refreshSnapshot() {
  try {
    const scenario = new URLSearchParams(window.location.search).get("scenario");
    const path = judgeDemo && scenario ? `/api/snapshot?scenario=${encodeURIComponent(scenario)}` : "/api/snapshot";
    const data = await requestJson(path);
    const retained = {
      trades: loadedPages.has("trade-history") ? snapshot.trades : data.trades,
      decisions: loadedPages.has("journal") ? snapshot.decisions : data.decisions,
      cyclePlans: loadedPages.has("journal") ? snapshot.cyclePlans : data.cyclePlans,
      learning: loadedPages.has("learning-page") ? snapshot.learning : data.learning,
      riskControls: loadedPages.has("policy-page") ? snapshot.riskControls : data.riskControls,
    };
    livePortfolio = data.portfolio ?? null;
    liveFreshness = data.portfolioFreshness ?? { source: "UNAVAILABLE", observedAt: new Date().toISOString(), stale: true, errorCode: "LIVE_PORTFOLIO_REQUIRED" };
    snapshot = { ...snapshot, ...data, ...retained, portfolio: data.portfolio, portfolioFreshness: data.portfolioFreshness };
    if (!liveFreshness.stale) $("error").hidden = true;
    render();
  } catch (error) {
    snapshot.agent = { ...snapshot.agent, status: "UNAVAILABLE", currentStage: "STATE_READ_FAILED" };
    const banner = $("error"); banner.textContent = `Agent runtime: STATE_READ_FAILED${error instanceof Error ? ` (${error.message})` : ""}. Provider data is independent.`; banner.hidden = false; render();
  }
}
async function loadPositionContexts() {
  if (judgeDemo || Date.now() - positionContextsLoadedAt < 60000) return;
  const positions = (livePortfolio || snapshot.portfolio)?.positions ?? [];
  const entries = await Promise.all(positions.map(async (position) => {
    const key = `${position.symbol}:${position.positionSide}`;
    try { const data = await requestJson(`/api/position-context?symbol=${encodeURIComponent(position.symbol)}&positionSide=${encodeURIComponent(position.positionSide)}`); return [key, data.context] ; } catch { return [key, null]; }
  }));
  positionContexts = Object.fromEntries(entries);
  positionContextsLoadedAt = Date.now();
  renderOpenPositions();
}
async function loadPage(page) {
  if (page === "open-position") { await loadPositionContexts(); return; }
  if (judgeDemo || (loadedPages.has(page) && Date.now() - (pageLoadedAt.get(page) ?? 0) < 60000)) return;
  const endpoints = { journal: "/api/agent-journal?limit=25", "trade-history": "/api/trade-history?limit=25", "learning-page": "/api/learning?limit=25", "policy-page": "/api/policy" };
  const endpoint = endpoints[page]; if (!endpoint) return;
  try {
    const data = await requestJson(endpoint);
    if (page === "journal") { snapshot.decisions = data.decisions ?? []; snapshot.cyclePlans = data.cycles ?? data.cyclePlans ?? []; const validCycle = snapshot.cyclePlans.find((cycle) => cycle.status === "COMPLETED" && cycle.hasValidPlan); const persistedPlan = validCycle?.plan ?? data.latestValidCyclePlan?.plan ?? snapshot.latestCyclePlan; snapshot.latestCyclePlan = persistedPlan ?? null; snapshot.latestDiscovery = validCycle?.discovery ?? data.latestValidCyclePlan?.discovery ?? snapshot.latestDiscovery; if (!snapshot.latestCyclePlan) snapshot.latestDecision = null; }
    if (page === "trade-history") snapshot.trades = data.trades ?? [];
    if (page === "learning-page") snapshot.learning = data.learning ?? snapshot.learning;
    if (page === "policy-page") { snapshot.riskControls = data.riskControls ?? snapshot.riskControls; snapshot.lastPolicyUpdate = data.lastPolicyUpdate ?? null; }
    loadedPages.add(page); pageLoadedAt.set(page, Date.now()); render();
  } catch (error) {
    const banner = $("error"); banner.textContent = `Page read failed: ${error instanceof Error ? error.message : "UNKNOWN"}`; banner.hidden = false;
  }
}
function invalidatePageData() { loadedPages.clear(); pageLoadedAt.clear(); positionContextsLoadedAt = 0; }
async function selectPage(page) { currentPage = page; document.querySelectorAll(".page").forEach((item) => { item.hidden = item.id !== `page-${page}`; }); document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === page)); const labels = { dashboard: "Dashboard", journal: "Agent Journal", "trade-history": "Trade History", "open-position": "Open Positions", "learning-page": "Learning", "policy-page": "Policy" }; $("page-title").textContent = labels[page] ?? "Dashboard"; await loadPage(page); }
function authHeaders() { return ownerToken ? { "authorization": `Bearer ${ownerToken}` } : {}; }
async function control(action) { if (action === "EMERGENCY_STOP" && !window.confirm("Enable the deterministic emergency stop?")) return; try { const response = await fetch("/api/control", { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify({ action }) }); if (!response.ok) throw new Error(`HTTP_${response.status}`); invalidatePageData(); snapshot = { ...snapshot, ...(await response.json()), portfolio: livePortfolio, portfolioFreshness: liveFreshness }; render(); } catch (error) { const banner = $("error"); banner.textContent = error instanceof Error ? error.message : "CONTROL_FAILED"; banner.hidden = false; } }
async function savePolicy() { const status = $("policy-status"); const values = Object.fromEntries([...document.querySelectorAll("[data-policy-field]")].map((input) => [input.dataset.policyField, input.value])); values.drawdownCooldownMinutes = Number(values.drawdownCooldownMinutes); values.scanIntervalMinutes = Number(values.scanIntervalMinutes); try { const response = await fetch("/api/policy", { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify(values) }); if (!response.ok) throw new Error(`HTTP_${response.status}`); invalidatePageData(); snapshot = { ...snapshot, ...(await response.json()), portfolio: livePortfolio, portfolioFreshness: liveFreshness }; status.textContent = "POLICY_UPDATED"; render(); } catch (error) { status.textContent = error instanceof Error ? error.message : "POLICY_UPDATE_FAILED"; } }
function downloadPaperLog(format) { const link = document.createElement("a"); link.href = `/api/export/paper-log?format=${encodeURIComponent(format)}`; link.download = `darwin-paper-log-full.${format}`; document.body.append(link); link.click(); link.remove(); }

document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => control(button.dataset.action)));
document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => selectPage(button.dataset.page)));
document.querySelectorAll("[data-page-link]").forEach((button) => button.addEventListener("click", () => selectPage(button.dataset.pageLink)));
document.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", () => downloadPaperLog(button.dataset.export)));
document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => { tradeFilter = button.dataset.filter; document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item.dataset.filter === tradeFilter)); renderTradeTable(); }));
selectPage("dashboard"); void refreshSnapshot(); if (!judgeDemo) window.setInterval(() => { void refreshSnapshot(); }, 10000);
