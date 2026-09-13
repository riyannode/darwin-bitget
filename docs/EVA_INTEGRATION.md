# EVA Integration

EVA is an optional external adversarial evaluator. The Docker Judge Demo does not call EVA and requires no EVA credentials. No EVA evaluation is started by the canonical Docker command.

When enabled in a deployed Worker, EVA credentials are backend-only runtime secrets. `EVA_AGENT_API_KEY` must never appear in source, `wrangler.jsonc`, real `.env.example` values, logs, exports, frontend code, or browser storage. EVA does not own Darwin's policy, execution, journal, or lesson state.

EVA feedback is bounded observable evidence. It cannot bypass `risk-gate.ts`, grant PAPER authority, change owner policy, or invoke unrestricted financial execution. The trader owns its lessons; EVA owns its weakness memory.
