import { evaFeedbackSchema, type EvaFeedback, type EvaScenario } from "./types.js";

export class EvaClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  public async evaluate(scenario: EvaScenario, decision: unknown): Promise<EvaFeedback> {
    if (!this.baseUrl) throw new Error("EVA_NOT_CONFIGURED");
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/evaluate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ scenario, decision }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("EVA_REQUEST_FAILED");
    return evaFeedbackSchema.parse(await response.json());
  }
}
