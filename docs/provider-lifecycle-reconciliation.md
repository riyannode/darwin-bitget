# Provider lifecycle reconciliation

`POST /api/control` accepts the owner-authenticated action below to repair one local lifecycle from already-synced provider ledger evidence:

```json
{
  "action": "REPAIR_PROVIDER_CLOSED_LIFECYCLE",
  "experienceId": "<local experience ID>",
  "providerPositionHistoryId": "<provider position-history ID>"
}
```

The action is PAUSED-only. It reads current provider positions, then requires the exact local entry decision to resolve through the idempotency record to a DARWIN provider order/client OID; opening fills must match the history opening identity and quantity. Position history must match symbol/side, have positive and equal open/close quantities, and have complete financial values. Every closing fill in the history interval must join to an exact provider order/client OID and be DARWIN-attributed; the exact decimal sum must equal the provider close quantity. Current provider position presence, missing identity, unexplained quantity, or contradictory evidence rejects the repair.

The successful lifecycle is recorded with `origin: DARWIN` only after exact opening and closing order/client-OID joins and DARWIN attribution for every required fill; the original position-history row's separate origin observation is retained in the audit event. A successful repair preserves the experience and entry decision IDs, reasoning, lessons, and journal bytes. The experience's authoritative realized result is the provider `netProfit`; the replaced local estimate is retained as `legacyLocalRealizedPnl`. The position context is marked `CLOSED` while retaining its entry reasoning and management events. One audit event and both read-model updates are committed in a SQLite-backed Durable Object `transactionSync`. The event key is deterministic; repeat invocation returns `ALREADY_RECONCILED` without provider reads or database writes.

This is a manual control repair only. It does not submit provider writes, create a synthetic close decision, modify journals, update the performance aggregate, or invoke provider sync/backfill. No production repair is performed by this change.
