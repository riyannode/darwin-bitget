# Provider lifecycle reconciliation

`POST /api/control` accepts the owner-authenticated action below to repair one local lifecycle from already-synced provider ledger evidence:

```json
{
  "action": "REPAIR_PROVIDER_CLOSED_LIFECYCLE",
  "experienceId": "<local experience ID>",
  "providerPositionHistoryId": "<provider position-history ID>"
}
```

The action is PAUSED-only. It reads current provider positions, then resolves the exact local entry decision through the idempotency record to the exact DARWIN provider order/client OID and its fills; this identity join discovers opening fills independently of the position-history time window. Opening fill and derived local entry timestamps are chronology checks only (bounded to five seconds around the provider opening time), not identity. After identity is proven, provider position-history time is authoritative. Opening fills must sum exactly to provider open quantity. Position history must match symbol/side, have positive and equal open/close quantities, and have complete financial values. Every closing fill in the history interval must join to an exact provider order/client OID and be DARWIN-attributed; the exact decimal sum must equal the provider close quantity. Current provider position presence, missing identity, unexplained quantity, or contradictory evidence rejects the repair.

The successful lifecycle is recorded with `origin: DARWIN` only after exact opening and closing order/client-OID joins and DARWIN attribution for every required fill; the original position-history row's separate origin observation is retained in the audit event. A successful repair preserves the experience and entry decision IDs, reasoning, lessons, and journal bytes. The experience's authoritative realized result is the provider `netProfit`; the replaced local estimate is retained as `legacyLocalRealizedPnl`. The position context is marked `CLOSED` while retaining its entry reasoning and management events. One audit event and both read-model updates are committed in a SQLite-backed Durable Object `transactionSync`. The event key is deterministic; a consistent retry returns `ALREADY_RECONCILED` without provider reads or database writes, while missing or mismatched repaired state fails closed.

This manual control action is PAUSED-only and does not submit provider financial writes or modify historical journals. It does not patch performance incrementally. The provider-backed performance view/cache is rebuilt deterministically from the provider ledger on the next snapshot; a crash after repair therefore converges on repeated read/rebuild without double-counting. The source-of-truth architecture, six-category account-record sync, scheduler cadence, attribution chain, and unresolved/contradictory fail-closed behavior are documented in `ACCOUNTING.md`.
