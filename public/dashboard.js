const $ = (id) => document.getElementById(id);
const text = (value, fallback = "—") => value === undefined || value === null || value === "" ? fallback : String(value);
const money = (value) => value === undefined || value === null || value === "" ? "—" : `$${value}`;
const when = (value) => value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const list = (values) => Array.isArray(values) && values.length ? values.join(" · ") : "—";
let snapshot = null;
let tradeFilter = "ALL";
let ownerToken = "";

function detail(label, value, wide = false) {
  const node = document.createElement("div");
  if (wide) node.className = "wide";
  const title = document.createElement("span"); title.className = "label"; title.textContent = label;
  const content = document.createElement("span"); content.className = "value"; content.textContent = text(value);
  node.append(title, content); return node;
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
  const values = [["TOTAL PNL", money(performance.totalPnl)], ["WIN RATE", `${performance.winRate}%`], ["DRAWDOWN", `${performance.dailyDrawdown}%`], ["TOTAL TRADES", performance.totalTrades], ["OPEN POSITIONS", snapshot.portfolio?.positions?.length ?? 0]];
  const node = $("performance"); node.replaceChildren();
  values.forEach(([label, value]) => { const card = document.createElement("div"); card.className = "summary-card"; const title = document.createElement("small"); title.textContent = label; const content = document.createElement("strong"); content.textContent = text(value); card.append(title, content); node.append(card); });
}

function renderCalendar() {
  const node = $("calendar"); node.replaceChildren();
  ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].forEach((label) => { const item = document.createElement("span"); item.className = "day-label"; item.textContent = label; node.append(item); });
  const now = new Date(); const year = now.getFullYear(); const month = now.getMonth(); const first = new Date(year, month, 1); const days = new Date(year, month + 1, 0).getDate(); const offset = (first.getDay() + 6) % 7; $("calendar-month").textContent = now.toLocaleString([], { month: "short", year: "numeric" });
  for (let index = 0; index < 42; index += 1) { const day = index - offset + 1; const item = document.createElement("span"); if (day > 0 && day <= days) { const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`; const value = snapshot.performance.dailyPnl[key]; item.textContent = value ? `${day}\n${value.pnl >= 0 ? "+" : ""}${value.pnl}` : String(day); item.style.whiteSpace = "pre-line"; if (value?.pnl > 0) item.className = "profit"; if (value?.pnl < 0) item.className = "loss"; } node.append(item); }
}

function renderPortfolio() {
  const portfolio = snapshot.portfolio;
  const node = $("portfolio"); node.replaceChildren(); [["ACCOUNT EQUITY", money(portfolio?.portfolioEquity)], ["AVAILABLE MARGIN", money(portfolio?.availableMargin)], ["MARGIN USED", money(portfolio?.marginUsage)], ["UNREALIZED PNL", money(portfolio?.unrealizedPnl)], ["REALIZED PNL", money(portfolio?.realizedPnl)], ["OPEN POSITIONS", portfolio?.positions?.length ?? 0]].forEach(([label, value]) => { const item = document.createElement("div"); const title = document.createElement("span"); title.className = "label"; title.textContent = label; const content = document.createElement("strong"); content.textContent = text(value); item.append(title, content); node.append(item); });
  const positions = $("positions"); positions.replaceChildren(); positions.className = portfolio?.positions?.length ? "positions-list" : "positions-list empty";
  if (!portfolio?.positions?.length) { positions.textContent = "No position readback yet."; return; }
  portfolio.positions.forEach((position) => { const row = document.createElement("div"); row.className = "position-row"; [["SYMBOL / SIDE", `${position.symbol} / ${position.positionSide}`], ["NOTIONAL", money(position.notional)], ["MARGIN", money(position.marginAllocated)], ["LEVERAGE", `${position.leverage}x`], ["UNREALIZED PNL", money(position.unrealizedPnl)]].forEach(([label, value]) => { const item = document.createElement("span"); const title = document.createElement("small"); title.className = "label"; title.textContent = label; const content = document.createElement("strong"); content.textContent = text(value); item.append(title, content); row.append(item); }); positions.append(row); });
}

function appendDecisionDetails(node, decision, positionNotional) {
  [detail("MARGIN", `${decision.marginAllocationPct}%`), detail("LEVERAGE", `${decision.leverage}x`), detail("CONFIDENCE", decision.confidence), detail("POSITION NOTIONAL", money(positionNotional ?? (decision.action === "HOLD" ? "0" : undefined))), detail("STRATEGY THESIS", decision.strategyThesis, true), detail("SUPPORTING FACTORS", list(decision.supportingFactors), true), detail("RISK FACTORS", list(decision.riskFactors), true), detail("LESSONS USED", list(decision.lessonsUsed), true)].forEach((item) => node.append(item));
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

function renderDecision() {
  const decision = snapshot.latestDecision;
  renderDecisionPanel("", decision, snapshot.executionEvidence?.positionNotional);
  renderDecisionPanel("dashboard", decision, snapshot.executionEvidence?.positionNotional);
}

function renderDecisionHistory() {
  const node = $("decision-history");
  const decisions = Array.isArray(snapshot.decisions) ? snapshot.decisions.slice(0, 25) : snapshot.latestDecision ? [snapshot.latestDecision] : [];
  node.replaceChildren();
  node.className = decisions.length ? "decision-history" : "decision-history empty";
  if (!decisions.length) { node.textContent = "No decisions recorded yet."; return; }
  decisions.forEach((decision) => {
    const item = document.createElement("details");
    item.className = "history-item";
    const summary = document.createElement("summary");
    summary.append(detail("RUN ID", decision.cycleId || decision.decisionId || "RUN_UNKNOWN"), detail("TIMESTAMP", when(decision.createdAt)), detail("ACTION", decision.action), detail("SYMBOL", decision.symbol));
    const content = document.createElement("div");
    content.className = "detail-grid history-content";
    appendDecisionDetails(content, decision);
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
  const trade = snapshot.trades[0];
  const summary = $("latest-trade-summary");
  const node = $("latest-trade");
  summary.replaceChildren();
  node.replaceChildren();
  $("latest-trade-status").textContent = trade?.status ?? "—";
  $("latest-trade-details").hidden = !trade;
  summary.className = trade ? "detail-grid" : "detail-grid empty";
  if (!trade) { summary.textContent = "No verified PAPER trade recorded yet."; return; }
  [detail("TIME", when(trade.timestamp)), detail("SYMBOL / SIDE", `${trade.symbol} / ${trade.positionSide ?? "—"}`), detail("ACTION", trade.action), detail("STATUS", trade.status)].forEach((item) => summary.append(item));
  [detail("MARGIN", `${trade.marginAllocationPct}% / ${money(trade.marginAllocated)}`), detail("LEVERAGE", `${trade.leverage}x`), detail("POSITION NOTIONAL", money(trade.positionNotional)), detail("ENTRY", trade.entry), detail("EXIT", trade.exit), detail("REALIZED PNL", money(trade.realizedPnl)), detail("ORDER REFERENCE", trade.orderReference), detail("STRATEGY THESIS", trade.thesis, true), detail("PROVIDER CODE", snapshot.executionEvidence?.providerCode), detail("PROVIDER MESSAGE", snapshot.executionEvidence?.providerMessage, true), detail("READBACK CODE", snapshot.executionEvidence?.providerReadbackCode), detail("READBACK MESSAGE", snapshot.executionEvidence?.providerReadbackMessage, true)].forEach((item) => node.append(item));
}

function renderActivity() {
  const node = $("activity"); node.replaceChildren(); node.className = snapshot.activity.length ? "activity" : "activity empty";
  if (!snapshot.activity.length) { node.textContent = "No events recorded yet."; return; }
  snapshot.activity.forEach((event) => { const item = document.createElement("div"); item.className = "activity-item"; const type = document.createElement("span"); type.className = "activity-type"; type.textContent = event.type; const time = document.createElement("span"); time.className = "activity-time"; time.textContent = when(event.createdAt); item.append(type, time); node.append(item); });
}

function renderTradeTable() {
  const node = $("trade-table"); node.replaceChildren(); const trades = snapshot.trades.filter((trade) => tradeFilter === "ALL" || (tradeFilter === "OPEN" && (trade.status === "OPEN" || trade.status === "PARTIALLY_REDUCED")) || (tradeFilter === "CLOSED" && trade.status === "CLOSED") || (tradeFilter === "WIN" && Number(trade.realizedPnl) > 0) || (tradeFilter === "LOSS" && Number(trade.realizedPnl) < 0));
  trades.forEach((trade) => { const row = document.createElement("tr"); [when(trade.timestamp), trade.symbol, trade.action, `${trade.marginAllocationPct}% / ${money(trade.marginAllocated)}`, `${trade.leverage}x`, money(trade.positionNotional), trade.entry, trade.exit, money(trade.realizedPnl), trade.status].forEach((value, index) => { const cell = document.createElement("td"); cell.textContent = text(value); if (index === 2) cell.className = "table-action"; row.append(cell); }); node.append(row); });
}

function renderLessons() {
  const node = $("lesson-table"); node.replaceChildren(); snapshot.learning.lessons.forEach((lesson) => { const row = document.createElement("tr"); [lesson.lesson, lesson.source, `${lesson.symbolScope} / ${lesson.marketRegime}`, lesson.confidence, lesson.timesRetrieved, lesson.timesApplied, lesson.successfulApplications, lesson.failedApplications, lesson.status, when(lesson.createdAt)].forEach((value) => { const cell = document.createElement("td"); cell.textContent = text(value); row.append(cell); }); node.append(row); });
  const replay = snapshot.learning.backtest; const card = $("replay-card"); card.replaceChildren(); card.hidden = !replay; if (replay) { const heading = document.createElement("div"); heading.className = "panel-heading"; const title = document.createElement("h2"); title.textContent = "BACKTEST / REPLAY"; const badge = document.createElement("span"); badge.className = "pill"; badge.textContent = "BOUNDED"; heading.append(title, badge); card.append(heading, detail("TRIGGER", replay.trigger), detail("ALTERNATIVES", replay.hypotheses.length), detail("RESULT", replay.selectedLesson, true)); }
}

function renderPolicy() {
  const policy = snapshot.riskControls; const node = $("policy"); node.replaceChildren(); [["PAPER_ONLY", policy.paperOnly], ["MAX_SINGLE_POSITION_MARGIN_PCT", `${policy.maxSinglePositionMarginPct}% / hard 30%`], ["MAX_LEVERAGE", `${policy.maxLeverage}x / hard 5x`], ["MAX_DAILY_DRAWDOWN_PCT", `${policy.maxDailyDrawdownPct}% / hard 20%`], ["DRAWDOWN_COOLDOWN_MINUTES", `${policy.drawdownCooldownMinutes}m`], ["SCAN_INTERVAL_MINUTES", `${policy.scanIntervalMinutes}m`], ["EMERGENCY_STOP", policy.emergencyStop]].forEach(([label, value]) => { const item = document.createElement("div"); const title = document.createElement("span"); title.className = "label"; title.textContent = label; const content = document.createElement("strong"); content.textContent = text(value); item.append(title, content); node.append(item); });
  const editor = $("policy-editor"); editor.replaceChildren();
  [["MAX_LEVERAGE", "maxLeverage", policy.maxLeverage, "1–5"], ["MAX_SINGLE_POSITION_MARGIN_PCT", "maxSinglePositionMarginPct", policy.maxSinglePositionMarginPct, "1–30"], ["MAX_DAILY_DRAWDOWN_PCT", "maxDailyDrawdownPct", policy.maxDailyDrawdownPct, "1–20"], ["DRAWDOWN_COOLDOWN_MINUTES", "drawdownCooldownMinutes", policy.drawdownCooldownMinutes, "5–1440"], ["SCAN_INTERVAL_MINUTES", "scanIntervalMinutes", policy.scanIntervalMinutes, ">0"]].forEach(([label, key, value, range]) => { const item = document.createElement("label"); item.className = "policy-input"; const title = document.createElement("span"); title.className = "label"; title.textContent = `${label} (${range})`; const input = document.createElement("input"); input.name = key; input.value = String(value); input.inputMode = "decimal"; input.dataset.policyField = key; item.append(title, input); editor.append(item); });
  const auth = document.createElement("label"); auth.className = "policy-input policy-token"; const authTitle = document.createElement("span"); authTitle.className = "label"; authTitle.textContent = "OWNER CONTROL TOKEN"; const authInput = document.createElement("input"); authInput.type = "password"; authInput.placeholder = "Bearer token"; authInput.value = ownerToken; authInput.addEventListener("input", () => { ownerToken = authInput.value; }); auth.append(authTitle, authInput); editor.append(auth);
  const save = document.createElement("button"); save.className = "button button-primary"; save.textContent = "Save Policy"; save.addEventListener("click", savePolicy); editor.append(save);
  const version = document.createElement("span"); version.className = "subtle"; version.textContent = `Last update: ${when(snapshot.lastPolicyUpdate?.createdAt)} · ${snapshot.version} · ${snapshot.commit} · ${snapshot.environment}`; editor.append(version);
}

function render() { renderAgent(); renderPerformance(); renderCalendar(); renderPortfolio(); renderDecision(); renderDecisionHistory(); renderLearning(); renderRecentTrades(); renderLatestTrade(); renderActivity(); renderTradeTable(); renderLessons(); renderPolicy(); $("error").hidden = true; }

function selectPage(page) { document.querySelectorAll(".page").forEach((item) => { item.hidden = item.id !== `page-${page}`; }); document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === page)); const labels = { dashboard: "Dashboard", journal: "Agent Journal", "trade-history": "Trade History", "learning-page": "Learning", "policy-page": "Policy" }; $("page-title").textContent = labels[page] ?? "Dashboard"; }

async function refresh() { try { const response = await fetch("/api/snapshot", { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP_${response.status}`); snapshot = await response.json(); render(); } catch (error) { const banner = $("error"); banner.textContent = error instanceof Error ? error.message : "SNAPSHOT_FAILED"; banner.hidden = false; } }
function authHeaders() { return ownerToken ? { "authorization": `Bearer ${ownerToken}` } : {}; }
async function control(action) { if (action === "EMERGENCY_STOP" && !window.confirm("Enable the deterministic emergency stop?")) return; try { const response = await fetch("/api/control", { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify({ action }) }); if (!response.ok) throw new Error(`HTTP_${response.status}`); snapshot = await response.json(); render(); } catch (error) { const banner = $("error"); banner.textContent = error instanceof Error ? error.message : "CONTROL_FAILED"; banner.hidden = false; } }
async function savePolicy() { const status = $("policy-status"); const values = Object.fromEntries([...document.querySelectorAll("[data-policy-field]")].map((input) => [input.dataset.policyField, input.value])); values.drawdownCooldownMinutes = Number(values.drawdownCooldownMinutes); values.scanIntervalMinutes = Number(values.scanIntervalMinutes); try { const response = await fetch("/api/policy", { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify(values) }); if (!response.ok) throw new Error(`HTTP_${response.status}`); snapshot = await response.json(); status.textContent = "POLICY_UPDATED"; render(); } catch (error) { status.textContent = error instanceof Error ? error.message : "POLICY_UPDATE_FAILED"; } }
function downloadPaperLog(format) { const link = document.createElement("a"); link.href = `/api/export/paper-log?format=${encodeURIComponent(format)}`; link.download = `darwin-paper-log.${format}`; document.body.append(link); link.click(); link.remove(); }

document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => control(button.dataset.action)));
document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => selectPage(button.dataset.page)));
document.querySelectorAll("[data-page-link]").forEach((button) => button.addEventListener("click", () => selectPage(button.dataset.pageLink)));
document.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", () => downloadPaperLog(button.dataset.export)));
document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => { tradeFilter = button.dataset.filter; document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item.dataset.filter === tradeFilter)); renderTradeTable(); }));
selectPage("dashboard"); refresh(); window.setInterval(refresh, 10000);
