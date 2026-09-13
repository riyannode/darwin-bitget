import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_SCENARIOS, buildDemoSnapshot, normalizeScenario } from "./fixtures.js";

if (process.env.JUDGE_DEMO !== "true") {
  throw new Error("JUDGE_DEMO_REQUIRED");
}

const port = Number(process.env.PORT ?? "3000");
const root = fileURLToPath(new URL("..", import.meta.url));
const publicRoot = join(root, "public");

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function demoBlocked(response: ServerResponse): void {
  json(response, 403, { error: "DEMO_READ_ONLY", mode: "JUDGE_DEMO", financialWrites: false });
}

function csv(snapshot: ReturnType<typeof buildDemoSnapshot>): string {
  const decision = snapshot.latestDecision;
  const execution = snapshot.executionEvidence;
  const fields = ["source", "scenario", "cycleId", "decision", "symbol", "riskGate", "executionStatus", "reconciliation", "orderReference"];
  const values = ["RECORDED_REPLAY", snapshot.demo.scenario, decision?.cycleId, decision?.action, decision?.symbol, snapshot.demoRiskGate.status, execution?.executionStatus, execution?.reconciliationStatus, execution?.orderReference];
  const quote = (value: unknown): string => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return `${fields.join(",")}\n${values.map(quote).join(",")}\n`;
}

async function staticFile(pathname: string, response: ServerResponse): Promise<void> {
  const requested = pathname === "/" || pathname === "/demo" ? "/index.html" : pathname;
  const candidate = normalize(join(publicRoot, requested.replace(/^\/+/, "")));
  if (!candidate.startsWith(`${publicRoot}${sep}`) && candidate !== publicRoot) {
    json(response, 400, { error: "INVALID_PATH" });
    return;
  }
  try {
    const data = await fs.readFile(candidate);
    const contentType = extname(candidate) === ".css" ? "text/css; charset=utf-8" : extname(candidate) === ".js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    response.end(data);
  } catch {
    json(response, 404, { error: "NOT_FOUND" });
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/health" && request.method === "GET") {
    json(response, 200, { status: "ok", mode: "JUDGE_DEMO", financialWrites: false, externalCalls: false });
    return;
  }
  if (url.pathname === "/api/demo/scenarios" && request.method === "GET") {
    json(response, 200, { mode: "JUDGE_DEMO", scenarios: DEMO_SCENARIOS });
    return;
  }
  if (url.pathname === "/api/snapshot" && request.method === "GET") {
    json(response, 200, buildDemoSnapshot(normalizeScenario(url.searchParams.get("scenario"))));
    return;
  }
  if (url.pathname === "/api/export/paper-log" && request.method === "GET") {
    const snapshot = buildDemoSnapshot(normalizeScenario(url.searchParams.get("scenario")));
    if (url.searchParams.get("format") === "csv") {
      response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=darwin-judge-replay.csv", "cache-control": "no-store" });
      response.end(csv(snapshot));
      return;
    }
    json(response, 200, { exportGeneratedAt: new Date().toISOString(), source: "RECORDED_REPLAY", finalCompetitionLog: false, note: "This is judge-demo evidence, not the production competition PAPER log.", snapshot });
    return;
  }
  if (url.pathname.startsWith("/api/") && request.method !== "GET") {
    demoBlocked(response);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    json(response, 404, { error: "NOT_FOUND" });
    return;
  }
  await staticFile(url.pathname, response);
}

createServer((request, response) => { void handle(request, response).catch(() => json(response, 500, { error: "DEMO_SERVER_ERROR" })); }).listen(port, "0.0.0.0", () => {
  process.stdout.write(`DARWIN JUDGE DEMO listening on ${port}\n`);
});
