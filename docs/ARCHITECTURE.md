# Architecture

DARWIN Bitget is a Cloudflare Worker with a Durable Object agent and a static frontend. The Durable Object owns cycle state, SQLite audit records, scheduler state, policy, lessons, experiences, and export queries. The frontend is an observation surface with no manual trade controls.

## Runtime flow

```text
Executable Demo universe → lightweight scan → bounded entry shortlist
                         ↘
Open provider positions → management evidence
                         ↘
                  Qwen CycleDecisionPlan
                  ├ positionActions[]
                  └ entryActions[]
                         ↓
              deterministic plan validation
                         ↓
          CLOSE → REDUCE → OPEN sequential planner
                         ↓
              risk check → PAPER write → readback
                         ↓
                    reconciliation
                         ↓
          refreshed provider portfolio → next action
                         ↓
                 journal / learning / export
```

The full executable Demo universe is still scanned every cycle. `openPositionSymbols` own position-management evidence. `selectedEntryCandidateSymbols` own new-entry evidence. These sets may share a provider fetch for efficiency, but they are not one semantic decision pool.

Private authenticated Bitget operations travel through the stable-egress path:

```text
Cloudflare Worker → authenticated narrow gateway request → Cloudflare Tunnel
→ stable-egress gateway → Bitget Demo PAPER API
```

Public market operations may remain direct because they do not require private Bitget credentials. The Worker never stores `BITGET_API_KEY`, `BITGET_SECRET_KEY`, or `BITGET_PASSPHRASE`; it stores only the gateway service secret plus backend-only Qwen, owner-control, and optional EVA secrets.

## Cycle decision contract

`CycleDecisionPlan` has two bounded arrays:

- `positionActions`: one `HOLD`, `REDUCE`, or `CLOSE` decision for every currently open provider symbol + side. Existing positions may be managed even outside `supportedUniverse`.
- `entryActions`: optional `OPEN_LONG` or `OPEN_SHORT` decisions using current deep evidence for supported-universe candidates.

`MAX_TOTAL_ACTIONS_PER_CYCLE = 5` is enforced by the Zod output schema and deterministic contextual validation. The backend rejects over-cap, missing, duplicate, nonexistent-position, unsupported-entry, and stale-evidence intent. It never silently truncates financial intent. A zero-write plan is valid.

Because every open provider position requires one management action, a live account with more than five open positions cannot be represented by this bounded contract. DARWIN fails before model financial planning with `OPEN_POSITION_COUNT_EXCEEDS_PLAN_LIMIT`, records a visible `PLAN_REJECTED` event, performs no financial write, and does not omit positions or raise the cap. The symbols may still be scanned and used for management evidence before the guard is evaluated.

The new mandate/decision contracts are `darwin-mandate-v5` and `darwin-decision-v3`. Reflection and backtest prompt versions remain unchanged.

## Authority boundary

Qwen proposes rationale, evidence references, position management, and new entries. Qwen is not financial authority. Deterministic TypeScript owns plan validation, supported-universe and open-position checks, owner policy, risk gates, idempotency, execution ordering, provider readback, reconciliation, and write count.

For each non-HOLD action the planner refreshes evidence, evaluates the risk gate, constructs one bounded request, persists idempotency, submits once, reads the provider result back, reconciles, and refreshes account/positions/open-orders before the next financial action. Financial writes are never parallelized. The order is `CLOSE → REDUCE → OPEN_LONG/OPEN_SHORT`; HOLD creates no financial write. Any ambiguous/unresolved result or reconciliation other than `MATCHED` stops all remaining financial writes without a blind retry.

## Persistence and compatibility

New journals persist `cyclePlan`, `executionRecords`, and `discovery` metadata. Historical journals still use `decision`, `exitDecisions`, `executionResult`, `reconciliationResult`, and `exitExecutions`. `src/storage/journal-normalizer.ts` owns the compatibility seam: legacy journals and new cycle plans normalize into the same cycle/action representation for dashboard, paper-log export, and learning association. Historical data is not destructively migrated.

Each action keeps its own decision ID, cycle ID, symbol, side, evidence, execution, reconciliation, and experience association. HOLD remains explainable but does not create a fake closed-trade outcome. Closed-trade metrics use verified lifecycle experiences only.

## Live dashboard path

`/api/live/portfolio` is the provider-only live portfolio path for equity, margin, positions, and open orders. The browser refreshes it approximately every 10 seconds. `/api/snapshot` is the slower Durable Object runtime-state read, refreshed approximately every 60 seconds. The dashboard shows a grouped Cycle Plan with Position Management and New Entry Actions plus compact Market Discovery evidence.

## Judge Demo boundary

The Docker Judge Demo is a separate Node process under `demo/`. It uses local deterministic fixtures and the pure risk gate only. `JUDGE_DEMO=true` is required. It has no Bitget, Qwen, EVA, scheduler, Durable Object, or production-state access. Mutation endpoints fail with `DEMO_READ_ONLY`. The `hold` fixture shows `CRCLUSDT LONG → HOLD` alongside `NVDAUSDT → OPEN_LONG` as recorded replay evidence; it submits no order.
