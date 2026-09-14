import { routeAgentRequest } from "agents";
import { TraderAgent } from "./agent/agent.js";
import type { Env } from "./types.js";
import { BitgetClient, BitgetReadError } from "./bitget/client.js";
import { loadConfig } from "./config.js";

export { TraderAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/universe" && request.method === "GET") {
      try {
        const instruments = await new BitgetClient(loadConfig(env)).getTradableInstruments();
        return Response.json({ source: "DEMO_INTERSECTION", count: instruments.length, symbols: instruments.map((instrument) => instrument.symbol), commit: env.GIT_COMMIT_SHA }, { headers: { "Cache-Control": "no-store" } });
      } catch {
        return Response.json({ error: "DEMO_UNIVERSE_UNAVAILABLE" }, { status: 503 });
      }
    }
    if (url.pathname === "/api/live/portfolio" && request.method === "GET") {
      try {
        const portfolio = await new BitgetClient(loadConfig(env)).getDashboardPortfolio();
        return Response.json({ source: "PROVIDER_LIVE", portfolio, observedAt: portfolio.observedAt, ...(portfolio.openOrdersReadFailure ? { degraded: true, errors: { openOrders: portfolio.openOrdersReadFailure } } : {}) }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        const code = error instanceof Error && /^[A-Za-z0-9_-]{1,120}$/.test(error.message) ? error.message : "PROVIDER_READ_FAILED";
        const readFailure = error instanceof BitgetReadError ? { operation: error.operation, symbol: error.symbol, ...(error.details.classification ? { classification: error.details.classification } : {}), ...(error.details.code ? { code: error.details.code } : {}), ...(error.details.message ? { message: error.details.message } : {}) } : undefined;
        return Response.json({ source: "PROVIDER_LIVE", error: code, ...(readFailure ? { provider: readFailure } : {}) }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }
    if (url.pathname === "/api/snapshot" || url.pathname === "/api/position-context" || url.pathname === "/api/agent-journal" || url.pathname === "/api/trade-history" || url.pathname === "/api/learning" || url.pathname === "/api/control" || url.pathname === "/api/policy" || url.pathname === "/api/export/paper-log" || url.pathname === "/api/eva/connection-test") {
      const id = env.TRADER_AGENT.idFromName("primary");
      const stub = env.TRADER_AGENT.get(id);
      const path = url.pathname === "/api/snapshot" ? "/snapshot" : url.pathname === "/api/position-context" ? "/position-context" : url.pathname === "/api/agent-journal" ? "/agent-journal" : url.pathname === "/api/trade-history" ? "/trade-history" : url.pathname === "/api/learning" ? "/learning" : url.pathname === "/api/policy" ? "/policy" : url.pathname === "/api/export/paper-log" ? "/export/paper-log" : url.pathname === "/api/eva/connection-test" ? "/eva/connection-test" : "/control";
      const agentUrl = new URL(request.url);
      agentUrl.pathname = path;
      return stub.fetch(new Request(agentUrl, request));
    }
    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }
    const response = await routeAgentRequest(request, env);
    return response ?? new Response("NOT_FOUND", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
