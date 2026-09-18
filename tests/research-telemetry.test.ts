import { describe, expect, it } from "vitest";
import {
  ResearchExecutor,
  type ResearchExecutionTelemetryEvent,
} from "../src/research/executor.js";
import type { ResearchRequest } from "../src/types.js";

function makeRequest(symbol = "CRCLUSDT"): ResearchRequest {
  return { skill: "technical-analysis", symbol, purpose: "test" };
}

class FakeMcpClient {
  public connectAttempts = 0;
  public connectSuccesses = 0;
  public toolCalls = 0;
  public shouldFailConnect = false;
  public shouldFailTool = false;

  async connect(): Promise<void> {
    this.connectAttempts++;
    if (this.shouldFailConnect) throw new Error("CONNECT_ERROR: simulated failure");
    this.connectSuccesses++;
  }

  async callTool(_args: { name: string; arguments: Record<string, unknown> }): Promise<unknown> {
    this.toolCalls++;
    if (this.shouldFailTool) throw new Error("TOOL_ERROR: simulated tool failure");
    return { content: [{ type: "text", text: JSON.stringify({ verdict: "neutral", rsi: { rsi: 50, signal: "neutral" } }) }] };
  }

  async close(): Promise<void> {}
}

function makeFactory(client: FakeMcpClient) {
  return {
    connect: async () => {
      await client.connect();
      return client;
    },
  };
}

describe("ResearchExecutor telemetry", () => {
  it("requests=[] reports no MCP activity", async () => {
    const events: ResearchExecutionTelemetryEvent[] = [];
    const client = new FakeMcpClient();
    const executor = new ResearchExecutor(makeFactory(client) as never, {
      telemetry: (e: ResearchExecutionTelemetryEvent) => events.push(e),
    });

    const result = await executor.execute([]);
    expect(result).toEqual([]);
    expect(client.connectAttempts).toBe(0);
    expect(client.connectSuccesses).toBe(0);
    expect(client.toolCalls).toBe(0);
    expect(events).toEqual([]);
  });

  it("accepted request reports connect attempt and success", async () => {
    const events: ResearchExecutionTelemetryEvent[] = [];
    const client = new FakeMcpClient();
    const executor = new ResearchExecutor(makeFactory(client) as never, {
      telemetry: (e: ResearchExecutionTelemetryEvent) => events.push(e),
    });

    const result = await executor.execute([makeRequest()]);
    expect(result.length).toBe(1);
    expect(result[0]?.status).toBe("AVAILABLE");
    expect(client.connectAttempts).toBe(1);
    expect(client.connectSuccesses).toBe(1);
    expect(client.toolCalls).toBe(1);

    const connectAttempts = events.filter((e) => e.type === "MCP_CONNECT_ATTEMPT");
    const connectSuccesses = events.filter((e) => e.type === "MCP_CONNECT_SUCCESS");
    const toolAttempts = events.filter((e) => e.type === "MCP_TOOL_ATTEMPT");
    const toolResults = events.filter((e) => e.type === "MCP_TOOL_RESULT");

    expect(connectAttempts).toHaveLength(1);
    expect(connectSuccesses).toHaveLength(1);
    expect(toolAttempts).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ type: "MCP_TOOL_RESULT", status: "AVAILABLE" });
  });

  it("failed connect emits MCP_CONNECT_FAILED with bounded code", async () => {
    const events: ResearchExecutionTelemetryEvent[] = [];
    const client = new FakeMcpClient();
    client.shouldFailConnect = true;
    const executor = new ResearchExecutor(makeFactory(client) as never, {
      telemetry: (e: ResearchExecutionTelemetryEvent) => events.push(e),
    });

    const result = await executor.execute([makeRequest()]);
    expect(result.length).toBe(1);
    expect(result[0]?.status).toBe("UNAVAILABLE");

    const connectAttempts = events.filter((e) => e.type === "MCP_CONNECT_ATTEMPT");
    const connectFailures = events.filter((e) => e.type === "MCP_CONNECT_FAILED");
    const connectSuccesses = events.filter((e) => e.type === "MCP_CONNECT_SUCCESS");

    expect(connectAttempts).toHaveLength(1);
    expect(connectFailures).toHaveLength(1);
    expect(connectSuccesses).toHaveLength(0);
    expect(connectFailures[0]).toMatchObject({ type: "MCP_CONNECT_FAILED", code: "CONNECT_ERROR" });
  });

  it("failed tool emits MCP_TOOL_FAILED with bounded code", async () => {
    const events: ResearchExecutionTelemetryEvent[] = [];
    const client = new FakeMcpClient();
    client.shouldFailTool = true;
    const executor = new ResearchExecutor(makeFactory(client) as never, {
      telemetry: (e: ResearchExecutionTelemetryEvent) => events.push(e),
    });

    const result = await executor.execute([makeRequest()]);
    expect(result.length).toBe(1);
    expect(result[0]?.status).toBe("UNAVAILABLE");

    const toolAttempts = events.filter((e) => e.type === "MCP_TOOL_ATTEMPT");
    const toolFailures = events.filter((e) => e.type === "MCP_TOOL_FAILED");
    const toolResults = events.filter((e) => e.type === "MCP_TOOL_RESULT");

    expect(toolAttempts).toHaveLength(1);
    expect(toolFailures).toHaveLength(1);
    expect(toolResults).toHaveLength(0);
    expect(toolFailures[0]).toMatchObject({ type: "MCP_TOOL_FAILED", code: "TOOL_ERROR" });
  });

  it("cache hit emits CACHE_HIT and makes zero MCP calls", async () => {
    const events: ResearchExecutionTelemetryEvent[] = [];
    const client = new FakeMcpClient();
    const executor = new ResearchExecutor(makeFactory(client) as never, {
      telemetry: (e: ResearchExecutionTelemetryEvent) => events.push(e),
    });

    // First call populates cache
    await executor.execute([makeRequest()]);
    expect(client.toolCalls).toBe(1);

    // Clear events from first call
    events.length = 0;

    // Second call should hit cache
    const result2 = await executor.execute([makeRequest()]);
    expect(result2.length).toBe(1);
    expect(result2[0]?.status).toBe("AVAILABLE");

    const cacheHits = events.filter((e) => e.type === "CACHE_HIT");
    const connectAttempts = events.filter((e) => e.type === "MCP_CONNECT_ATTEMPT");
    const toolAttempts = events.filter((e) => e.type === "MCP_TOOL_ATTEMPT");

    expect(cacheHits).toHaveLength(1);
    expect(cacheHits[0]).toMatchObject({ type: "CACHE_HIT", skill: "technical-analysis", symbol: "CRCLUSDT" });
    expect(connectAttempts).toHaveLength(0);
    expect(toolAttempts).toHaveLength(0);
    expect(client.connectAttempts).toBe(1); // unchanged from first call
    expect(client.toolCalls).toBe(1); // unchanged from first call
  });

  it("cache-only request makes zero MCP connections", async () => {
    const events: ResearchExecutionTelemetryEvent[] = [];
    const client = new FakeMcpClient();
    const executor = new ResearchExecutor(makeFactory(client) as never, {
      telemetry: (e: ResearchExecutionTelemetryEvent) => events.push(e),
    });

    // First call
    await executor.execute([makeRequest("CRCLUSDT")]);
    expect(client.toolCalls).toBe(1);

    // Second call with different symbol - no cache hit
    const result2 = await executor.execute([makeRequest("COINUSDT")]);
    expect(result2.length).toBe(1);
    expect(client.toolCalls).toBe(2);

    // Third call for CRCLUSDT should be cached
    events.length = 0;
    const result3 = await executor.execute([makeRequest("CRCLUSDT")]);
    expect(result3.length).toBe(1);
    expect(client.toolCalls).toBe(2); // unchanged

    const cacheHits = events.filter((e) => e.type === "CACHE_HIT");
    expect(cacheHits).toHaveLength(1);
  });

  it("telemetry callback failure cannot break research", async () => {
    const client = new FakeMcpClient();
    const executor = new ResearchExecutor(makeFactory(client) as never, {
      telemetry: () => {
        throw new Error("TELEMETRY_BROKEN");
      },
    });

    // Should not throw despite telemetry failure
    const result = await executor.execute([makeRequest()]);
    expect(result.length).toBe(1);
    expect(result[0]?.status).toBe("AVAILABLE");
    expect(client.connectAttempts).toBe(1);
    expect(client.toolCalls).toBe(1);
  });

  it("no raw MCP payload appears in telemetry", async () => {
    const events: ResearchExecutionTelemetryEvent[] = [];
    const client = new FakeMcpClient();
    const executor = new ResearchExecutor(makeFactory(client) as never, {
      telemetry: (e: ResearchExecutionTelemetryEvent) => events.push(e),
    });

    await executor.execute([makeRequest()]);

    for (const event of events) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("verdict");
      expect(serialized).not.toContain("rsi");
      expect(serialized).not.toContain("neutral");
    }
  });

  it("no Qwen raw output appears in telemetry", async () => {
    const events: ResearchExecutionTelemetryEvent[] = [];
    const client = new FakeMcpClient();
    const executor = new ResearchExecutor(makeFactory(client) as never, {
      telemetry: (e: ResearchExecutionTelemetryEvent) => events.push(e),
    });

    await executor.execute([makeRequest()]);

    for (const event of events) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("requests");
      expect(serialized).not.toContain("prompt");
    }
  });

  it("ResearchEvidence output identical with/without telemetry", async () => {
    const client1 = new FakeMcpClient();
    const client2 = new FakeMcpClient();

    const executor1 = new ResearchExecutor(makeFactory(client1) as never, {
      telemetry: () => { /* telemetry */ },
    });
    const executor2 = new ResearchExecutor(makeFactory(client2) as never);

    const result1 = await executor1.execute([makeRequest()]);
    const result2 = await executor2.execute([makeRequest()]);

    expect(result1.length).toBe(result2.length);
    expect(result1[0]?.skill).toBe(result2[0]?.skill);
    expect(result1[0]?.status).toBe(result2[0]?.status);
    expect(result1[0]?.scope).toBe(result2[0]?.scope);
    expect(result1[0]?.facts).toEqual(result2[0]?.facts);
    expect(result1[0]?.limitations).toEqual(result2[0]?.limitations);
  });

  it("executeWithTelemetry with undefined falls back to execute", async () => {
    const client = new FakeMcpClient();
    const executor = new ResearchExecutor(makeFactory(client) as never);

    const result = await executor.executeWithTelemetry([makeRequest()], undefined);
    expect(result.length).toBe(1);
    expect(result[0]?.status).toBe("AVAILABLE");
  });

  it("executeWithTelemetry with callback uses it", async () => {
    const events: ResearchExecutionTelemetryEvent[] = [];
    const client = new FakeMcpClient();
    const executor = new ResearchExecutor(makeFactory(client) as never);

    const result = await executor.executeWithTelemetry([makeRequest()], (e: ResearchExecutionTelemetryEvent) => events.push(e));
    expect(result.length).toBe(1);
    expect(events.some((e) => e.type === "MCP_CONNECT_ATTEMPT")).toBe(true);
    expect(events.some((e) => e.type === "MCP_TOOL_RESULT")).toBe(true);
  });
});
