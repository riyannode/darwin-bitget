# Legacy execution quarantine release

Owner-only, PAPER-only maintenance action that clears a legacy execution quarantine whose bounded
order-history search no longer terminates. It does not authorize a deployment, a scheduler resume,
or an order. Do not run it against a SHA that does not report this route.

## Root cause

`assessExecutionQuarantineHistory` can only reach `FOUND_EXACT` while the provider still returns the
old order, and it fails closed to `INCOMPLETE` once the order ages past the canceled-order retention
window. That quarantine has no terminal state bounded search can ever reach, so the symbol stays
blocked by `UNRESOLVED_PRIOR_EXECUTION` on every cycle. Repeating the search does not converge. The
fix is to stop requiring the old order's outcome and let the authoritative current provider state be
the operational truth.

## What it does and does not do

- Does: read provider positions and open orders twice; archive the approved quarantine as
  `LEGACY_RELEASED` with its original identity, reason and creation time preserved verbatim; clear
  only the approved quarantine rows; record one audit event.
- Does not: classify the historical order. The archive is never marked `FILLED`, `REJECTED` or
  `RECONCILED`, and `execution_quarantine_resolutions` is never written — that table means a
  provider-authoritative reconciliation of one order, and no such proof exists here.
- Does not: persist a second baseline. The provider's current position already is the operational
  state, so there is nothing else to store.
- Does not: delete journals or history, reset the database, resume the scheduler, submit an order,
  or relax any risk limit. Margin, leverage, drawdown, evidence freshness, quantity, instrument,
  duplicate-order and open-orders-readability gates are untouched.

## Preconditions (all must hold or it refuses)

1. `TRADING_MODE=PAPER` and `PAPER_ONLY=true`.
2. Agent is persistently `PAUSED`, `runtimeStatus=PAUSED`, no running cycle.
3. Both provider reads succeed and report a readable open-order list. An unreadable open-order list
   cannot prove the absence of a pending order, so it fails closed.
4. The two reads agree exactly on every open position's `symbol + side + quantity`. Mark price,
   equity and margin are deliberately **not** compared: they tick with the market between two reads
   and would reject a stable account. Quantity and side are compared exactly because only a fill
   changes them.
5. No pending provider order exists on any released symbol. Unrelated symbols are ignored.
6. At least one requested identity is both active and provably legacy — older than
   `LEGACY_QUARANTINE_RECOVERABLE_WINDOW_MS` (2h). A recent quarantine is still recoverable by
   bounded search, so it stays fail-closed.

Any failure returns `409` with explicit blocker codes and writes only a
`LEGACY_QUARANTINE_RELEASE_REJECTED` event. No partial write is possible: the archive append and the
quarantine clears happen inside one `transactionSync`.

## Owner invocation

The owner names **exact identities**. The request is never interpreted as "everything currently
quarantined"; an absent or empty `quarantines` array is rejected.

```text
POST /api/control
Authorization: Bearer <owner token>
Content-Type: application/json

{
  "action": "RELEASE_LEGACY_EXECUTION_QUARANTINE",
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

Get the exact identities from the owner diagnostics endpoint before invoking. Do not guess them.

Response `200`:

```json
{
  "status": "RELEASED",
  "releaseId": "legacy-release-...",
  "releasedAt": "2026-10-11T00:00:00.000Z",
  "archived": [{ "status": "LEGACY_RELEASED", "symbol": "SPCXUSDT", "reason": "EXECUTION_UNKNOWN" }],
  "providerPositionSymbols": ["SPCXUSDT"],
  "eligibleAgainSymbols": ["CRCLUSDT"],
  "remainingActiveQuarantineSymbols": ["KORUUSDT"],
  "rejected": [],
  "riskLimitsUnchanged": true
}
```

`eligibleAgainSymbols` are the released symbols with no live provider position, so they may become
entry candidates again. A released symbol that still holds a provider position stays under normal
position management. Every symbol in `remainingActiveQuarantineSymbols` keeps blocking.

## Only legacy identities are eligible

A quarantine is admitted only when all of the following hold. Anything else is reported in
`rejected` with an explicit reason, and nothing is freed implicitly.

| Check | Rejection reason |
|---|---|
| The exact identity is currently active | `IDENTITY_NOT_ACTIVE` |
| Not requested twice | `DUPLICATE_REQUEST` |
| Older than the provider's recoverable history window (2h) | `STILL_RECOVERABLE_WITHIN_WINDOW` |

An unparseable `createdAt` is treated as still recoverable, so a quarantine the system cannot date is
never released.

The window check is what keeps a **new** ambiguous order protected: bounded history search can still
resolve anything created inside that window, so it stays quarantined and fail-closed. Only a
quarantine the provider has genuinely stopped reporting — the exact condition that made it
permanent — is eligible.

Quarantines the owner did not name are left completely untouched and keep blocking their own symbol.
They appear in `remainingActiveQuarantineSymbols`.

## Snapshot comparison: exact where it matters, tolerant where it does not

Quantity and side are compared **exactly**, because only a fill changes them: if a position's
quantity or side differs between the two reads, the account moved during the operation and it aborts
with `PROVIDER_SNAPSHOT_UNSTABLE`.

Equity, available margin, available balance, entry price and mark price are not compared at all.
Those values move with mark price between two consecutive reads on any live market, so comparing
them — even with a tolerance band — would reject a completely stable account. Only a fill changes
quantity and side, so comparing those is both sufficient and free of false rejections.

## Commit-time revalidation

The two provider reads are asynchronous, so agent and quarantine state can change while they run.
Immediately before the atomic commit, inside the same transaction, the operation re-verifies:

- the agent is still `PAUSED` / `PAUSED` / idle (otherwise `AGENT_STATE_CHANGED`)
- the exact set of approved identities is still active — compared as sorted exact
  `symbol/cycleId/decisionId/clientOrderId` keys, **not** by array length (otherwise
  `LEGACY_QUARANTINE_STATE_CHANGED`)

A length-only check would accept a *different* quarantine set of the same size. Any mismatch aborts
with nothing written: `clearExecutionQuarantine` returning `false` throws inside the transaction
rather than returning, because returning would not roll back the archive write that already ran.

## Post-release behavior

- A symbol with a live provider position (for example `SPCXUSDT`) returns to normal position
  management. `HOLD`, `CLOSE` and `REDUCE` remain available; exposure-increasing actions still pass
  through every risk gate.
- An approved symbol with no position and no pending order (for example `CRCLUSDT`, `KORUUSDT`)
  becomes eligible again as an entry candidate.
- Any other quarantine stays active and keeps its symbol blocked.
- Startup journal seeding cannot re-activate an archived quarantine:
  `isLegacyExecutionQuarantineReleased` matches the exact symbol/cycle/decision/clientOrderId
  identity against the archive before any re-seed, so the journal that produced the quarantine cannot
  resurrect it.

## Pre-submit versus ambiguous post-submit failures

`ExecutionResult.submitState` separates a proven pre-submit failure from an ambiguous post-submit
failure:

- `NOT_SUBMITTED` — the failure happened in `getAccountInfo` or `setLeverage`, before `placeOrder`.
  No order exists, so the execution returns `rejected` **without any order readback** and never
  becomes a quarantine.
- `AMBIGUOUS` — the write reached `placeOrder` and its outcome is unknown. It stays fail-closed and
  quarantined.
- Absent (legacy journals) — treated as ambiguous, so historical behavior is unchanged.

An ambiguous result triggers bounded confirmation under the original `clientOid`: the existing
readback runs once, then up to two further lookups with a fixed 1.5s delay, re-reading the order,
its fills and its position-history financials through the existing `readOrder` path —
`AMBIGUOUS_ORDER_LOOKUP_BUDGET = 3` order lookups in total. A confirmed order resolves to its real
provider status; an unconfirmed read returns `null` and stays ambiguous. This never re-sends the
order, never invents a fill, and adds no background polling.

## Cost

| Path | Extra provider calls |
| --- | --- |
| Normal scan / trading cycle | 0 |
| Normal order submit + readback | 0 (unchanged) |
| Pre-submit failure | −1 (the order readback is skipped entirely) |
| Ambiguous post-submit execution | +2 at most, 3 order lookups in total |
| This maintenance action | 6, only on explicit owner invocation while paused |

No new LLM calls, no new scheduler, no new table or migration.

## Verification

`npm run typecheck` and `npm run build` must pass. Verify against the deployed runtime before any
production use: confirm the route exists on the deployed SHA, the agent reports `PAUSED`,
`/api/execution-quarantines` shows no remaining active entry for the released symbols, and the
`LEGACY_EXECUTION_QUARANTINE_RELEASED` event lists the released identities.
