export const EVA_AGENT_NAME = "darwin-bitget" as const;
export const EVA_PROTOCOL_VERSION = "eva-agent/1" as const;
export const EVA_CAPABILITIES = ["market", "account", "history", "escalate"] as const;
export const EVA_EXECUTION_PROVIDERS = ["bitget"] as const;

export interface EvaIdentity {
  name: string;
  version: string;
  model: string;
}

export interface EvaConnectionConfig {
  apiUrl?: string;
  gatewayUrl?: string;
  agentId?: string;
  agentApiKey?: string;
  identity: EvaIdentity;
}

export interface EvaSocket {
  accept(): void;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: unknown) => void): void;
  onClose(listener: (code: number, reason: string) => void): void;
  onError(listener: () => void): void;
}

export interface EvaUpgradeResult {
  status: number;
  socket: EvaSocket | null;
}

export type EvaUpgrade = (request: Request) => Promise<EvaUpgradeResult>;

export interface EvaConnectionResult {
  authenticatedUpgrade: true;
  helloAccepted: true;
  connectionId: string;
  status: "ONLINE";
  heartbeatVerified: true;
  serverPingPong: boolean;
  cleanDisconnect: true;
  closeCode: number;
}
