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
| Account-level net PnL since baseline | Provider-live equity minus baseline equity and verified USDT-denominated external flows | Unavailable unless six-category historical coverage and all relevant type/amount/unit checks pass |

`TradeExperience`, `PositionContext`, and `PerformanceAggregate` are derived read models. Original journals remain immutable. `performance-v3-provider-ledger` replaces lifecycle counters/PnL from older local aggregates while preserving trustworthy equity/baseline observations. Provider evidence is re-read to rebuild the cache; repair and cache refresh therefore do not rely on one shared transaction.

## Ledger scope and synchronization

The full trade lifecycle ledger (orders, fills, position history, financial records) is scoped to `USDT-FUTURES`. Unified Account financial-record-only sync covers `USDT-FUTURES`, `OTHER`, `SPOT`, `MARGIN`, `COIN-FUTURES`, and `USDC-FUTURES`; order/fill/position-history endpoints are never called for the five non-`USDT-FUTURES` categories. The owner-authenticated `POST /api/provider-ledger/backfill` backfills financial records for all six categories from the preserved performance baseline, subject to Bitget's documented 90-day retention; it may backfill lifecycle resources for `USDT-FUTURES` only. Per-category coverage persists `coveredFrom`, `coveredThrough`, `lastSuccessfulSyncAt`, and `lastError` separately from moving resource checkpoints. `financialRecordCoverage=COMPLETE` requires all six categories to be error-free, cover the baseline, and reach the current coverage window. A recent-sync checkpoint alone is never evidence of historical coverage. `/api/provider-ledger` exposes per-category status, last success/error, financial-record row count, checkpoint, and coverage.

A dedicated read-only provider-ledger callback runs every 15 minutes with a bounded 24-hour recent window and 15-minute overlap. UPSERTs and durable cursor checkpoints make repeated runs and restarts idempotent. This schedule is separate from the 5-minute trading cadence; it neither submits orders nor changes owner policy. Sync failures are diagnostic and do not alter trading policy or corrupt prior ledger rows.

Current equity remains a direct provider-live read and is not replaced by historical ledger values. The allowlist in `src/trading/external-flow.ts` follows Bitget's [UTA type enumeration](https://www.bitget.com/api-doc/uta/enum), [financial-record API](https://www.bitget.com/api-doc/uta/account/Get-Financial-Records), and [UTA changelog](https://www.bitget.com/api-doc/uta/changelog). Exact documented transfer-in/out codes are external flows; order/trade PnL, fees, funding, liquidation, margin mechanics, and RWA settlement/rebase codes are trading/PnL components or internal non-flows; future/unrecognized types remain `UNKNOWN`. A complete paginated read-only 30-day sample of the configured Demo PAPER account on 2026-09-23 observed `CLOSE_LONG`, `CLOSE_SHORT`, `CONTRACT_MAIN_SETTLE_FEE_USER_IN/OUT`, `OPEN_LONG`, `OPEN_SHORT`, `PAPTRADING_USER_IN`, `ORDER_DEALT_FROZEN_OUT`, and `ORDER_DEALT_IN`; no records were returned for MARGIN, COIN-FUTURES, or USDC-FUTURES during that period. This is a bounded account sample, not a promise that later/older types are known. Flow amounts must be valid and denominated in USDT (the equity unit); no implicit BTC/USDC conversion is attempted. Every relevant record type in the covered period must be classified, and all six categories must have error-free historical coverage from the preserved baseline to the current coverage window. Until these conditions pass, `externalFlowStatus=UNVERIFIED`, `netExternalInflows=UNAVAILABLE`, and `netPnlSinceBaseline=UNAVAILABLE`.

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
