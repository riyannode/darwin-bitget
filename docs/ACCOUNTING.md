# Bitget financial source of truth

This document describes DARWIN's accounting authority boundary. It is read-only and does not change strategy, prompts, order sizing, leverage, risk gates, trading cadence, or provider execution.

## Authority matrix

| Data | Authority | Local representation |
|---|---|---|
| Current account equity, positions, open orders | Bitget live observation (`PROVIDER_LIVE`) | DARWIN snapshot/read model only |
| Historical orders, fills, position history | Durable indexed Bitget provider ledger | Provider evidence is preserved by category/identity |
| Closed entry/exit, quantities, PnL, fees, funding, dividends | Bitget position-history lifecycle joined to exact DARWIN opening/closing identities | TradeExperience/PositionContext are derived views |
| Decision identity, reasoning, thesis, lessons, management chronology, audit | DARWIN persisted records | Never fabricated for provider external activity |
| DARWIN performance | Rebuilt from uniquely attributed provider lifecycles | PerformanceAggregate is a versioned, idempotent cache |
| Account-level net PnL since baseline | Unavailable until provider flows are fully classified | Equity delta is not represented as verified account PnL |

`TradeExperience`, `PositionContext`, and `PerformanceAggregate` are derived read models. Original journals remain immutable. `performance-v3-provider-ledger` replaces lifecycle counters/PnL from older local aggregates while preserving trustworthy equity/baseline observations. Provider evidence is re-read to rebuild the cache; repair and cache refresh therefore do not rely on one shared transaction.

## Ledger scope and synchronization

The full trade lifecycle ledger (orders, fills, position history, financial records) is scoped to `USDT-FUTURES`. Unified Account financial-record-only sync covers `USDT-FUTURES`, `OTHER`, `SPOT`, `MARGIN`, `COIN-FUTURES`, and `USDC-FUTURES`; order/fill/position-history endpoints are not called for financial-only categories. `/api/provider-ledger` exposes per-category status, last success/error, financial-record row count, and checkpoint. Coverage is complete only when every required category has succeeded.

A dedicated read-only provider-ledger callback runs every 15 minutes with a bounded 24-hour recent window and 15-minute overlap. UPSERTs and durable cursor checkpoints make repeated runs and restarts idempotent. This schedule is separate from the 5-minute trading cadence; it neither submits orders nor changes owner policy. Sync failures are diagnostic and do not alter trading policy or corrupt prior ledger rows.

Current equity remains a direct provider-live read and is not replaced by historical ledger values. Bitget's [UTA Get Financial Records API](https://www.bitget.com/api-doc/uta/account/Get-Financial-Records) documents product categories and a `type` field; its type enumeration is not mapped here to a complete external-flow taxonomy. Financial records are ingested, but types are not assumed to be cash flows without documented semantics. Consequently `externalFlowStatus=UNVERIFIED`, `netExternalInflows=UNAVAILABLE`, and `netPnlSinceBaseline=UNAVAILABLE`; successful ingestion alone does not verify flow classification.

## Attribution and DARWIN performance

Attribution requires this evidence chain:

```text
entry decision → unique idempotency clientOid/providerOrderId → provider order
→ provider fill → provider position history → closing orders/fills
```

Symbol/time similarity alone never proves ownership. Unjoinable provider history remains unresolved/unattributed and is excluded from DARWIN counts, wins/losses, and PnL. Provider external activity may be represented separately as account activity, but receives no fabricated DARWIN reasoning.

One provider position-history lifecycle is one trade. A partial reduce and multiple closing fills are execution chronology, not extra trades. Closed lifecycle classification uses provider `netProfit` (`>0` win, `<0` loss, `=0` breakeven) exactly once. If a closed lifecycle cannot be deterministically joined or lacks provider net PnL, DARWIN financial output is `UNAVAILABLE`; stale local realized PnL is never used as fallback. Open DARWIN trades count only when a current provider position and entry identity are proven; stale local OPEN experiences do not count.

`/api/trade-history` joins provider financial facts with DARWIN reasoning. It reports `financialSource=PROVIDER_LEDGER` for verified closed lifecycles or `PROVIDER_LIVE` for proven live positions, `reasoningSource=DARWIN_PERSISTED`, `origin`, and `providerPositionHistoryId`. Missing evidence is explicit (`financialSource=UNRESOLVED`, monetary fields `UNAVAILABLE`).

## SAMSUNG acceptance fixture

The fixture models one DARWIN lifecycle, `1485976014620573698`, for `SAMSUNGUSDT` LONG: provider entry `198.02`, exit `202.66`, open/close quantity `7.51`, `cumRealisedPnl=34.8487`, `netProfit=33.19485709`, open fee `-0.89227812`, close fee `-0.91318734`, funding `0.15162255`, dividend `0`. Six closing fills sum to the single lifecycle quantity. The legacy local `19.1364` remains audit evidence only and is not authoritative.

## Account formulas and field semantics

Only after every required flow category and relevant provider record type is documented and classified can the account-level formula be verified:

```text
netExternalInflows = verified external credits - verified external debits
netPnlSinceBaseline = currentProviderEquity - baselineEquity - netExternalInflows
```

If flow completeness or semantics are ambiguous, both results remain `UNAVAILABLE`.

`unrealizedPnl` prefers the provider account-level USDT unrealized value; otherwise it is the exact-decimal sum of positions from the same observation. Position `curRealisedPnl` is current-position information, not all-time account realized PnL.

| Metric | Provider field/rule | Treatment |
|---|---|---|
| Account equity | `usdtEquity` | Authoritative live `ACCOUNT EQUITY` |
| Available margin | `effEquity` / documented available field | `AVAILABLE MARGIN`; no equity subtraction |
| Initial margin | `imr` | `INITIAL MARGIN`; documented amount |
| Account margin used | explicit `marginUsed`, `usedMargin`, `occupiedMargin`, or `totalMargin` only | Unavailable if absent |
| Position unrealized | `unrealisedPnl` | Fallback only when account value is absent |
| Current position realized | `curRealisedPnl` | Informational only |
| Funding, fees, dividend | Position-history `totalFunding`, `openFeeTotal`, `closeFeeTotal`, `cashDividend` | Separate provider components |
| Closed lifecycle net | Position-history `netProfit` | Authoritative; do not add costs again |

Historical screenshot arithmetic and baseline figures recorded in previous versions of this document are audit artifacts from that earlier observation; they are not current production state or proof of current external-flow coverage.
