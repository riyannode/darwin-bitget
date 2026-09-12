import { EVA_CAPABILITIES, EVA_PROTOCOL_VERSION, type EvaConnectionConfig, type EvaConnectionResult, type EvaSocket, type EvaUpgrade, type EvaUpgradeResult } from "./types.js";

const CONNECTION_TIMEOUT_MS = 10_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function parseMessage(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

function wrapSocket(socket: WebSocket): EvaSocket {
  return {
    accept: () => socket.accept(),
    send: (message) => socket.send(message),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (listener) => socket.addEventListener("message", (event) => listener(event.data)),
    onClose: (listener) => socket.addEventListener("close", (event) => listener(event.code, event.reason)),
    onError: (listener) => socket.addEventListener("error", () => listener()),
  };
}

async function upgrade(request: Request): Promise<EvaUpgradeResult> {
  const response = await fetch(request);
  return { status: response.status, socket: response.webSocket ? wrapSocket(response.webSocket) : null };
}

function closeError(code: number): string {
  if (code === 4400) return "EVA_IDENTITY_MISMATCH";
  if (code === 4401) return "EVA_AUTH_REJECTED";
  if (code === 4429) return "EVA_DUPLICATE_OR_RATE_LIMITED";
  if (code === 4408) return "EVA_HEARTBEAT_TIMEOUT";
  return `EVA_CONNECTION_CLOSED_${code}`;
}

function upgradeUrl(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  return url.toString();
}

export function createEvaHello(config: EvaConnectionConfig): Record<string, unknown> {
  if (!config.agentId) throw new Error("EVA_AGENT_ID_MISSING");
  return {
    type: "hello",
    agent_id: config.agentId,
    protocol: EVA_PROTOCOL_VERSION,
    capabilities: [...EVA_CAPABILITIES],
    agent: config.identity,
  };
}

export class EvaClient {
  public constructor(private readonly config: EvaConnectionConfig, private readonly connect: EvaUpgrade = upgrade) {}

  public async connectAndTest(): Promise<EvaConnectionResult> {
    const gatewayUrl = this.config.gatewayUrl?.trim();
    const agentId = this.config.agentId?.trim();
    const agentApiKey = this.config.agentApiKey?.trim();
    if (!gatewayUrl || !agentId || !agentApiKey) throw new Error("EVA_CREDENTIAL_MISSING");

    const request = new Request(upgradeUrl(gatewayUrl), { method: "GET", headers: { Upgrade: "websocket", Authorization: `Bearer ${agentApiKey}` } });
    const response = await this.connect(request);
    if (response.status !== 101 || !response.socket) throw new Error(`EVA_UPGRADE_${response.status}`);

    const socket = response.socket;
    const hello = createEvaHello({ ...this.config, agentId });
    socket.accept();

    return new Promise<EvaConnectionResult>((resolve, reject) => {
      let settled = false;
      let ready = false;
      let heartbeatVerified = false;
      let serverPingPong = false;
      let connectionId = "";
      const nonce = crypto.randomUUID();
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close(1000, "EVA_CONNECTION_TIMEOUT");
        reject(new Error("EVA_CONNECTION_TIMEOUT"));
      }, CONNECTION_TIMEOUT_MS);
      const fail = (code: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(code));
      };

      socket.onMessage((data) => {
        const message = asRecord(parseMessage(data));
        if (!message || typeof message.type !== "string") {
          fail("EVA_PROTOCOL_INVALID");
          return;
        }
        if (message.type === "ready") {
          if (message.status !== "ONLINE" || typeof message.connection_id !== "string") {
            fail("EVA_READY_INVALID");
            return;
          }
          ready = true;
          connectionId = message.connection_id;
          socket.send(JSON.stringify({ type: "ping", nonce }));
          return;
        }
        if (message.type === "ping") {
          const pong: Record<string, string> = { type: "pong" };
          if (typeof message.nonce === "string") pong.nonce = message.nonce;
          serverPingPong = true;
          socket.send(JSON.stringify(pong));
          return;
        }
        if (message.type === "pong" && message.nonce === nonce) {
          heartbeatVerified = true;
          socket.close(1000, "EVA_CONNECTION_TEST_COMPLETE");
        }
      });
      socket.onClose((code) => {
        if (settled) return;
        if (!ready || !heartbeatVerified) {
          fail(closeError(code));
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve({ authenticatedUpgrade: true, helloAccepted: true, connectionId, status: "ONLINE", heartbeatVerified: true, serverPingPong, cleanDisconnect: true, closeCode: code });
      });
      socket.onError(() => fail("EVA_CONNECTION_ERROR"));
      socket.send(JSON.stringify(hello));
    });
  }
}
