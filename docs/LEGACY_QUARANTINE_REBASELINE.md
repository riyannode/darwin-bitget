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
4. The two reads agree on the open-position set (symbol **and** side), on every position quantity exactly, and on open-order count. Equity, available margin, and available balance are compared against a `0.1%` mark-price drift band rather than exact equality — see below.
5. No pending/open provider order exists for any approved symbol.
6. At least one requested identity is both active and provably legacy.

Any failure returns `409` with explicit blocker codes and writes only a `LEGACY_QUARANTINE_REBASELINE_REJECTED` event.

## Owner invocation

The owner names **exact identities**. The request is never interpreted as "everything currently quarantined"; an absent or empty `quarantines` array is rejected.

```text
POST /api/control
Authorization: Bearer <owner token>
Content-Type: application/json

{
  "action": "REBASELINE_LEGACY_EXECUTION_QUARANTINE",
  "quarantines": [
    {
      "symbol": "SPCXUSDT",
      "cycleId": "2026-10-01T00-00-00-000Z",
      "decisionId": "d3f1a2b4",
      "clientOrderId": "paper-20261001-d3f1a2b4"
    }
  ]
}
```

A successful response carries `status=REBASELINED`, the persisted `baseline`, the `archived` entries, `providerPositionSymbols`, `eligibleAgainSymbols`, `remainingActiveQuarantineSymbols`, `rejected`, and `riskLimitsUnchanged: true`.

## Only legacy identities are eligible

A quarantine is admitted only when all of the following hold. Anything else is reported in `rejected` with an explicit reason and nothing is freed implicitly.

| Check | Rejection reason |
|---|---|
| The exact identity is currently active | `IDENTITY_NOT_ACTIVE` |
| Not requested twice | `DUPLICATE_REQUEST` |
| `createdAt` parses | `CREATED_AT_UNPARSEABLE` |
| Older than the provider's recoverable history window (2h) | `STILL_RECOVERABLE_WITHIN_WINDOW` |
| The source journal exists for that cycle and decision | `JOURNAL_SOURCE_MISSING` |
| The source journal's decision symbol matches | `JOURNAL_SYMBOL_CONFLICT` |

The journal requirement is fail-closed. A quarantine must be backed by the journal entry that produced it, and that journal's decision symbol must be the quarantined symbol. A missing journal, an absent decision within the journal, or a journal read that fails is rejected as `JOURNAL_SOURCE_MISSING` rather than being treated as "no conflict". Without that, a quarantine whose origin cannot be proven would be freed on the strength of the quarantine row alone.

The window check is what keeps a **new** ambiguous order protected: bounded history search can still resolve anything created inside that window, so it stays quarantined and fail-closed. Only a quarantine the provider has genuinely stopped reporting — the exact condition that made it permanent — is eligible.

Quarantines the owner did not name are left completely untouched and keep blocking their own symbol. They appear in `remainingActiveQuarantineSymbols`.

## Snapshot comparison: exact where it matters, tolerant where it does not

Quantity and side are compared **exactly**, because only a fill changes them: if a position's quantity or side differs between the two reads, the account moved during the rebaseline and the operation aborts. Numeric formatting differences (`400` vs `400.0`) are normalized before comparison.

Equity, available margin, and available balance are compared against a `0.1%` band instead of exact equality. Those values move with mark price between two consecutive reads on any live market, so exact equality would reject a completely stable account. The band is far wider than a rounding tick and far narrower than a real exposure change, which moves equity by the traded notional. Open-order count must match exactly.

## Commit-time revalidation

The two provider reads are asynchronous, so agent and quarantine state can change while they run. Immediately before the atomic commit, inside the same transaction, the operation re-verifies:

- the agent is still `PAUSED` / `PAUSED` / idle (otherwise `AGENT_STATE_CHANGED`)
- the exact set of approved identities is still active — compared as sorted exact `symbol/cycleId/decisionId/clientOrderId` keys, **not** by array length (otherwise `LEGACY_QUARANTINE_STATE_CHANGED`)

A length-only check would accept a *different* quarantine set of the same size. Any mismatch aborts with nothing written.

## Post-rebaseline behavior

- A symbol with a live provider position (for example `SPCXUSDT`) returns to normal position management. `HOLD`, `CLOSE`, and `REDUCE` remain available; exposure-increasing actions still pass through every risk gate.
- An approved symbol with no position and no pending order (for example `CRCLUSDT`, `KORUUSDT`) becomes eligible again as an entry candidate.
- Any other quarantine stays active and keeps its symbol blocked.
- Startup journal seeding cannot re-activate an archived quarantine: `isLegacyExecutionQuarantineBaselined` matches the exact symbol/cycle/decision/clientOrderId identity against the archive before any re-seed, so the journal that produced the quarantine cannot resurrect it.

## Pre-submit versus ambiguous post-submit failures

`ExecutionResult.submitState` separates a proven pre-submit failure from an ambiguous post-submit failure:

- `NOT_SUBMITTED` — the failure happened in `getAccountInfo` or `setLeverage`, before `placeOrder`. No order exists, so the execution is a proven rejection and never becomes a quarantine.
- `AMBIGUOUS` — the write reached `placeOrder` and its outcome is unknown. It stays fail-closed and quarantined.
- Absent (legacy journals) — treated as ambiguous, so historical behavior is unchanged.

An ambiguous result triggers bounded confirmation: the order is re-read up to 3 times with a fixed 1.5s delay, which re-reads its fills and position-history financials through the existing read path. A confirmed order resolves to its real provider status; an unconfirmed read returns `null` and stays ambiguous. This never re-sends the order and never invents a fill.

## Verification

`npm run typecheck` and `npm run build` must pass. Verify against the deployed runtime before any production use: confirm the route exists on the deployed SHA, the agent reports `PAUSED`, `/api/execution-quarantines` shows no remaining active entry for the rebaselined symbols, and the `LEGACY_EXECUTION_QUARANTINE_BASELINED` event carries the expected evidence digest.