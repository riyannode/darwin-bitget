import { routeAgentRequest } from "agents";
import { TraderAgent } from "./agent/agent.js";
import type { Env } from "./types.js";

export { TraderAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/snapshot" || url.pathname === "/api/control" || url.pathname === "/api/policy" || url.pathname === "/api/export/paper-log") {
      const id = env.TRADER_AGENT.idFromName("primary");
      const stub = env.TRADER_AGENT.get(id);
      const path = url.pathname === "/api/snapshot" ? "/snapshot" : url.pathname === "/api/policy" ? "/policy" : url.pathname === "/api/export/paper-log" ? "/export/paper-log" : "/control";
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
