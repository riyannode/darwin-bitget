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

PAPER scan eligibility comes from the Demo catalog. Public ticker/history endpoints may supply evidence, but a public-only symbol cannot become a new PAPER candidate. Existing provider positions remain eligible for management.

## Authority boundary

Qwen chooses strategy thesis, symbol, `OPEN_LONG`, `OPEN_SHORT`, `HOLD`, `REDUCE`, or `CLOSE`, margin allocation, leverage, and contextual exits. The backend does not encode a trading strategy. `src/trading/policy.ts` and `src/trading/risk-gate.ts` own PAPER-only authority, owner limits, provider validity, idempotency, and position/exposure checks.

The only financial write path is:

```text
decision → risk-gate.ts → execution.ts → official Bitget SDK
→ provider readback → reconcile.ts
```

At most one new entry is considered per cycle. Multiple existing-position exits may be validated and executed sequentially. If an exit is ambiguous or unresolved, remaining financial writes stop for that cycle. No blind retry is used.

## Live dashboard path

`/api/snapshot` performs a read-only provider portfolio readback for equity, margin, positions, and open orders. The dashboard refreshes it every 10 seconds. `PROVIDER_LIVE` with `stale=false` is current provider state; journal portfolio is explicit `JOURNAL_FALLBACK` only when readback fails. The Open Position page renders multiple provider positions and signed provider unrealized PnL/PnL percentage without modifying state.

The deployment script injects the current Git commit into `GIT_COMMIT_SHA`, returned through `/api/snapshot.commit`.

## Persistence

Durable Object SQLite stores cycles, journals, decision/execution records, experiences, lessons, lesson usage, policy, drawdown state, replay records, and activity events. The UI shows at most 25 recent decisions/trades; the paper-log export queries persisted history directly and is not truncated by that display limit.

## Judge Demo boundary

The Docker Judge Demo is a separate Node process under `demo/`. It uses local deterministic fixtures and the pure risk gate only. `JUDGE_DEMO=true` is required. It has no Bitget, Qwen, EVA, scheduler, Durable Object, or production-state access. Mutation endpoints fail with `DEMO_READ_ONLY`.
