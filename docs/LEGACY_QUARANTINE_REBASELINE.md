# Legacy execution quarantine rebaseline

Owner-approved, PAPER-only procedure that closes a legacy execution quarantine whose bounded order-history search no longer terminates. It does not authorize a deployment, a scheduler resume, or an order. Do not run it against a production SHA that does not report this route.

## Root cause

`assessExecutionQuarantineHistory` can only reach `FOUND_EXACT` while the provider still returns the old order, and it fails closed to `INCOMPLETE` once the order ages past the canceled-order retention window. The legacy quarantine therefore has no terminal state that bounded search can ever reach, and the symbol stays blocked by `UNRESOLVED_PRIOR_EXECUTION` on every cycle. Repeating the search does not converge. The fix is to stop requiring the old order's outcome and make the authoritative current provider state the operational truth.

## What it does and does not do

- Does: read the current provider positions, open orders, and account twice; store that as the operational baseline; archive the old quarantine as `LEGACY_BASELINED` with its original identity, reason, execution status, and reconciliation codes preserved verbatim; record an audit event with snapshot evidence and an evidence digest.
- Does not: classify the old order. The archive is never marked `FILLED`, `REJECTED`, or `RECONCILED`. `execution_quarantine_resolutions` is not written, because that table means a provider-authoritative reconciliation of one order, and no such proof exists here.
- Does not: delete history, reset the database, resume the scheduler, submit an order, or relax any risk limit. Margin, leverage, daily drawdown, evidence freshness, quantity, instrument, duplicate-order, and open-orders-readability gates are untouched.

## Preconditions (all must hold or it refuses)

1. `TRADING_MODE=PAPER` and `PAPER_ONLY=true`.
2. Agent is persistently `PAUSED`, `runtimeStatus=PAUSED`, no running cycle.
3. Two independent provider reads of account + positions + open orders both succeed.
4. The two reads agree on the open-position fingerprint, open-order count, portfolio equity, and available margin.
5. No pending/open provider order exists for any currently quarantined symbol.
6. At least one legacy quarantine is currently active.

Any failure returns `409` with explicit blocker codes and writes only a `LEGACY_QUARANTINE_REBASELINE_REJECTED` event.

## Owner invocation

```text
POST /api/control
Authorization: Bearer <owner token>
Content-Type: application/json

{"action":"REBASELINE_LEGACY_EXECUTION_QUARANTINE"}
```

The body accepts no other field. A successful response carries `status=REBASELINED`, the persisted `baseline`, the `archived` entries, `providerPositionSymbols`, `eligibleAgainSymbols`, and `riskLimitsUnchanged: true`.

## Post-rebaseline behavior

- A symbol with a live provider position (for example `SPCXUSDT`) returns to normal position management. `HOLD`, `CLOSE`, and `REDUCE` remain available; exposure-increasing actions still pass through every risk gate.
- A quarantined symbol with no position and no pending order (for example `CRCLUSDT`, `KORUUSDT`) becomes eligible again as an entry candidate.
- Startup journal seeding cannot re-activate an archived quarantine: `isLegacyExecutionQuarantineBaselined` matches the exact symbol/cycle/decision/clientOrderId identity against the archive before any re-seed, so the journal that produced the quarantine cannot resurrect it.

## Pre-submit versus ambiguous post-submit failures

`ExecutionResult.submitState` separates a proven pre-submit failure from an ambiguous post-submit failure:

- `NOT_SUBMITTED` — the failure happened in `getAccountInfo` or `setLeverage`, before `placeOrder`. No order exists, so the execution is a proven rejection and never becomes a quarantine.
- `AMBIGUOUS` — the write reached `placeOrder` and its outcome is unknown. It stays fail-closed and quarantined.
- Absent (legacy journals) — treated as ambiguous, so historical behavior is unchanged.

An ambiguous result triggers bounded confirmation: the order is re-read up to 3 times with a fixed 1.5s delay, which re-reads its fills and position-history financials through the existing read path. A confirmed order resolves to its real provider status; an unconfirmed read returns `null` and stays ambiguous. This never re-sends the order and never invents a fill.

## Verification

`npm run typecheck` and `npm run build` must pass. Verify against the deployed runtime before any production use: confirm the route exists on the deployed SHA, the agent reports `PAUSED`, `/api/execution-quarantines` shows no remaining active entry for the rebaselined symbols, and the `LEGACY_EXECUTION_QUARANTINE_BASELINED` event carries the expected evidence digest.