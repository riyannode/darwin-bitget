# Architecture

DARWIN Bitget is a Cloudflare Worker with a Durable Object agent and a static frontend. The Durable Object owns cycle state, SQLite audit records, scheduler state, policy, lessons, experiences, and export queries. The frontend is an observation surface and has no manual trade controls.

## Runtime flow

```text
Demo executable universe → lightweight market scan → Qwen shortlist
→ deep evidence → Qwen decision / exit decisions
→ deterministic risk gate → Bitget Demo PAPER write
→ provider readback → reconciliation → journal / experience
→ reflection / lesson evolution
```

Private authenticated Bitget operations travel through the stable-egress path:

```text
Cloudflare Worker → authenticated narrow gateway request → Cloudflare Tunnel
→ stable-egress gateway → Bitget Demo PAPER API
```

Public market operations may remain direct because they do not require private
Bitget credentials. The Worker never stores `BITGET_API_KEY`,
`BITGET_SECRET_KEY`, or `BITGET_PASSPHRASE`; it stores only the gateway service
secret plus its backend-only Qwen, owner-control, and optional EVA secrets.

PAPER scan eligibility comes from the Demo catalog. Public ticker/history endpoints may supply evidence, but a public-only symbol cannot become a new PAPER candidate. Existing provider positions remain eligible for management.

## Authority boundary

Qwen chooses strategy thesis, symbol, `OPEN_LONG`, `OPEN_SHORT`, `HOLD`, `REDUCE`, or `CLOSE`, margin allocation, leverage, and contextual exits. The `darwin-mandate-v4` contract requires each decision to expose its rationale, supporting evidence, risks/invalidation, and evidence limitations. The backend does not encode a trading strategy. `src/trading/policy.ts` and `src/trading/risk-gate.ts` own PAPER-only authority, owner limits, provider validity, idempotency, and position/exposure checks.

The only financial write path is:

```text
decision → risk-gate.ts → execution.ts → official Bitget SDK
→ provider readback → reconcile.ts
```

At most one new entry is considered per cycle. Multiple existing-position exits may be validated and executed sequentially. If an exit is ambiguous or unresolved, remaining financial writes stop for that cycle. No blind retry is used.

## Live dashboard path

`/api/live/portfolio` is the provider-only live portfolio path for equity, margin,
positions, and open orders. The browser refreshes it approximately every 10
seconds. It does not use the Durable Object hot-path reads. If the account or
position provider read fails, the UI shows provider state as unavailable and does
not show journal portfolio fallback.

`/api/snapshot` is the slower Durable Object runtime-state read, refreshed
approximately every 60 seconds. It carries decision, scheduler, risk, and bounded
activity state; it is not the live portfolio polling path. The browser loads the
bounded journal, trade-history, learning, and policy endpoints lazily when their
pages are opened. The Open Position page renders multiple provider positions and
signed provider unrealized PnL/PnL percentage without modifying state.

The deployment script injects the current Git commit into `GIT_COMMIT_SHA`, returned through `/api/snapshot.commit`.

## Persistence

Durable Object SQLite stores cycles, journals, decision/execution records, experiences, lessons, lesson usage, policy, drawdown state, replay records, and activity events. The UI shows at most 25 recent decisions/trades; the paper-log export queries persisted history directly and is not truncated by that display limit.

## Judge Demo boundary

The Docker Judge Demo is a separate Node process under `demo/`. It uses local deterministic fixtures and the pure risk gate only. `JUDGE_DEMO=true` is required. It has no Bitget, Qwen, EVA, scheduler, Durable Object, or production-state access. Mutation endpoints fail with `DEMO_READ_ONLY`.
