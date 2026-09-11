# Architecture

`src/agent/agent.ts` is the Cloudflare Durable Object cycle runner. It schedules a 15-minute cycle, reads dynamic Bitget perpetual-futures metadata, performs a lightweight scan, asks Qwen for a bounded shortlist, collects deep evidence, and asks Qwen for the final structured decision with futures action, position side, margin allocation, and leverage.

The only financial write path is:

```text
decision → risk-gate.ts → execution.ts → Bitget SDK → readback → reconcile.ts
```

The mandate is editable in `src/agent/mandate.ts`. Owner policy is editable in `src/trading/policy.ts`. The mandate changes behavior; policy changes authority. Learning and optional EVA evaluation cannot bypass the gate.

Durable Object SQLite stores cycles, journals, experiences, lessons, lesson usage, active owner policy, idempotency keys, daily drawdown state, bounded replay records, and dashboard activity events. The Worker serves the static dashboard from `public/`, exposes a public read-only snapshot, and protects policy/control mutations with the `OWNER_CONTROL_TOKEN` secret.

An opening fill creates an open experience. Later position-aware decisions may reduce or close it. Verified close readback uses order details plus official fill/history readback when needed; provider-reported realized PnL produces the closed experience that Qwen reflects on. The resulting lesson is persisted and its later retrieval/application is measured. Provider/local position discrepancies are persisted as events and never silently resolved in favor of local state. Drawdown cooldown blocks financial writes but continues reflection and bounded replay.

Only the explicit `/api/control` and `/api/policy` routes mutate owner state and they require `OWNER_CONTROL_TOKEN`. Agent callable decorators are not used for mutation methods, so the generic Agents route cannot bypass the owner boundary.

The public snapshot performs a bounded scheduler health check: if the single recurring cycle schedule is missing or its recorded next scan is stale, it replaces the schedule and advances `nextScanAt`. Provider failures are recorded by the cycle and do not terminate future scheduled attempts.
