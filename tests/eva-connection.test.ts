import { describe, expect, it } from "vitest";
import { EvaClient, createEvaHello } from "../src/eva/client.js";
import { EVA_CAPABILITIES, EVA_PROTOCOL_VERSION, type EvaConnectionConfig, type EvaSocket } from "../src/eva/types.js";

type EvaMessage = Record<string, unknown>;
type SendHandler = (socket: FakeSocket, message: EvaMessage) => void;

class FakeSocket implements EvaSocket {
  public readonly sent: EvaMessage[] = [];
  public accepted = false;
  private messageListener: ((data: unknown) => void) | undefined;
  private closeListener: ((code: number, reason: string) => void) | undefined;
  private errorListener: (() => void) | undefined;

  public constructor(private readonly onSend: SendHandler) {}

  public accept(): void {
    this.accepted = true;
  }

  public send(message: string): void {
    const parsed = JSON.parse(message) as EvaMessage;
    this.sent.push(parsed);
    this.onSend(this, parsed);
  }

  public close(code = 1000, reason = ""): void {
    this.closeListener?.(code, reason);
  }

  public onMessage(listener: (data: unknown) => void): void {
    this.messageListener = listener;
  }

  public onClose(listener: (code: number, reason: string) => void): void {
    this.closeListener = listener;
  }

  public onError(listener: () => void): void {
    this.errorListener = listener;
  }

  public emitMessage(message: EvaMessage): void {
    this.messageListener?.(JSON.stringify(message));
  }

  public emitClose(code: number): void {
    this.closeListener?.(code, "");
  }

  public emitError(): void {
    this.errorListener?.();
  }
}

const config: EvaConnectionConfig = {
  gatewayUrl: "wss://api.evalabs.my.id/v1/agent/connect",
  agentId: "agt_test",
  agentApiKey: "test-agent-key",
  identity: { name: "darwin-bitget", version: "0.2.0", model: "qwen3.8-max" },
};

function ready(socket: FakeSocket): void {
  socket.emitMessage({ type: "ready", connection_id: "conn_test", status: "ONLINE" });
}

describe("EVA connection-only client", () => {
  it("creates the exact registered hello payload", () => {
    expect(createEvaHello(config)).toEqual({ type: "hello", agent_id: "agt_test", protocol: EVA_PROTOCOL_VERSION, capabilities: [...EVA_CAPABILITIES], agent: config.identity });
  });

  it("attaches Authorization during the Cloudflare upgrade and verifies ready, ping/pong, and disconnect", async () => {
    let capturedRequest: Request | undefined;
    const socket = new FakeSocket((current, message) => {
      if (message.type === "hello") ready(current);
      if (message.type === "ping") {
        current.emitMessage({ type: "ping", nonce: "server-nonce" });
        current.emitMessage({ type: "pong", nonce: message.nonce });
      }
    });
    const client = new EvaClient(config, async (request) => {
      capturedRequest = request;
      return { status: 101, socket };
    });

    const result = await client.connectAndTest();

    expect(capturedRequest?.url).toBe("https://api.evalabs.my.id/v1/agent/connect");
    expect(capturedRequest?.headers.get("authorization")).toBe("Bearer test-agent-key");
    expect(socket.accepted).toBe(true);
    expect(socket.sent[0]).toEqual(createEvaHello(config));
    expect(socket.sent).toContainEqual({ type: "pong", nonce: "server-nonce" });
    expect(result).toMatchObject({ authenticatedUpgrade: true, helloAccepted: true, connectionId: "conn_test", status: "ONLINE", heartbeatVerified: true, serverPingPong: true, cleanDisconnect: true, closeCode: 1000 });
    expect(JSON.stringify(result)).not.toContain("test-agent-key");
  });

  it("fails closed when the credential is missing", async () => {
    const { agentApiKey: _agentApiKey, ...missingCredentialConfig } = config;
    const client = new EvaClient(missingCredentialConfig, async () => ({ status: 101, socket: null }));
    await expect(client.connectAndTest()).rejects.toThrow("EVA_CREDENTIAL_MISSING");
  });

  it.each([[4401, "EVA_AUTH_REJECTED"], [4400, "EVA_IDENTITY_MISMATCH"], [4429, "EVA_DUPLICATE_OR_RATE_LIMITED"]] as const)("maps gateway close %i without retry", async (closeCode, errorCode) => {
    const socket = new FakeSocket((current, message) => { if (message.type === "hello") current.emitClose(closeCode); });
    const client = new EvaClient(config, async () => ({ status: 101, socket }));
    await expect(client.connectAndTest()).rejects.toThrow(errorCode);
  });

  it("fails on a non-upgrade response without exposing credentials", async () => {
    const client = new EvaClient(config, async () => ({ status: 401, socket: null }));
    await expect(client.connectAndTest()).rejects.toThrow("EVA_UPGRADE_401");
  });
});
