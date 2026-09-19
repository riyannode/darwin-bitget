# PAPER accounting read model

This document describes the audit contract for the DARWIN Bitget dashboard. It is
read-only accounting documentation; it does not change strategy, order sizing,
leverage, risk gates, scheduler cadence, or provider execution.

## Sources and synchronization

`/api/snapshot` now obtains one provider portfolio observation and passes that exact
observation into the Durable Object read model. The response carries the provider
portfolio, performance accounting, source, and observation time together. The
provider-only `/api/live/portfolio` endpoint remains available for clients that need
only the live portfolio.

Persisted ledger values are durable read-model state:

- `baselineEquity`, `baselineObservedAt`, `baselineSource`, and
  `initializationReason`;
- verified lifecycle counts and verified realized PnL;
- peak equity and incremental high-water drawdown state.

The competition baseline is immutable after initialization. An existing baseline is
preserved during restart, UI reads, failed cycles, and new positions.

## Formulas

```text
netExternalInflows = verified credits/deposits/top-ups/transfers-in
                     - verified debits/withdrawals/transfers-out

netPnlSinceBaseline = currentProviderEquity
                      - baselineEquity
                      - netExternalInflows
```

The current production account has no imported external-flow ledger. The read model
therefore exposes `externalFlowStatus=UNVERIFIED_ZERO_FLOW_INVARIANT` and the numeric
`netExternalInflows=0` explicitly; auditors must confirm that no reset, top-up,
deposit, withdrawal, or transfer occurred during the measured period. The value is
not presented as silently proven.

`unrealizedPnl` prefers the authoritative account-level USDT unrealized value. If it
is absent, it is the exact-decimal sum of positions from the same provider
observation. Provider position `curRealisedPnl` is exposed as informational current-
position realized PnL and is not treated as all-time account realized PnL.

```text
classifiedClosedTrades = wins + losses + breakeven
winRatePct = wins / classifiedClosedTrades * 100
```

When `classifiedClosedTrades=0`, win rate is `UNAVAILABLE`. A partial reduce keeps
the episode open. A full close classifies the existing episode. A reverse closes the
old episode and opens a new opposite episode.

Performance drawdown is separate from daily risk-gate drawdown:

```text
peakEquity[t] = max(equity snapshots from baseline through t)
currentDrawdownPct = max(0, (peakEquity - currentEquity) / peakEquity * 100)
maxDrawdownPct = max(all persisted currentDrawdownPct values)
```

The dashboard labels the risk-policy value `DAILY RISK DRAWDOWN` and the ledger
values `CURRENT DRAWDOWN` and `MAX DRAWDOWN`.

## Bitget UTA field mapping

| Metric | Provider field / rule | Dashboard treatment |
|---|---|---|
| Account equity | `usdtEquity` | `ACCOUNT EQUITY`; authoritative |
| Available margin | `effEquity` / documented available field | `AVAILABLE MARGIN`; no equity subtraction |
| Initial margin | `imr` | `INITIAL MARGIN`; UTA documentation defines it as an amount |
| Account margin used | explicit `marginUsed`, `usedMargin`, `occupiedMargin`, or `totalMargin` only | `MARGIN USED`; unavailable if absent |
| Position margin | sum of `marginSize`/position margin fields in one snapshot | `POSITION MARGIN`; not called account-wide used margin |
| Account unrealized PnL | `usdtUnrealisedPnl` or documented account unrealized field | authoritative `UNREALIZED PNL` |
| Position unrealized PnL | `unrealisedPnl` | fallback only when account value is absent |
| Current position realized | `curRealisedPnl` | informational `POSITION REALIZED PNL` |
| Position funding | `totalFunding` | separate `FUNDING` component |
| Position fees | `openFeeTotal + closeFeeTotal` | separate `FEES` component |
| Cash dividend | `cashDividend` when returned | separate `CASH DIVIDEND` component |
| Verified close PnL | position history `netProfit` when available; otherwise documented provider close evidence | `verifiedRealizedPnl`; costs are not added again |

`mmr`, `mgnRatio`, `positionMgnRatio`, `profitRate`, and ROI/rate fields are never
used as currency amounts. `imr` is only used as `INITIAL MARGIN` because the UTA
account endpoint documents that exact field as an initial-margin amount; it is not
used as a generic `MARGIN USED` fallback.

## Screenshot reconciliation example

For the supplied screenshot:

```text
account equity  = 50405.78465224
net PnL shown   = 372.47179086
implied baseline = 50033.31286138
```

The actual persisted production baseline observed during this audit was
`50033.99009667`, so the screenshot-implied baseline is not the persisted baseline.
The corresponding persisted snapshot reported `latestEquity=50406.0394323` and
`totalPnl=372.04933563`. The live provider read observed during this audit was
`50405.92057101`; against the persisted baseline its exact equity delta was
`371.93047434`.

The screenshot component sum is:

```text
453.3867 + 3.1374 = 456.5241
```

That is not substituted for net account PnL. The two components are provider
unrealized PnL and current-position realized PnL; they are not a complete account
ledger and do not prove external flows, fees, funding, dividends, or provider
settlement semantics. The post-patch read model exposes them separately and uses
provider equity delta, adjusted by the explicit external-flow status, for the
competition metric.

The screenshot margin comparison is:

```text
50405.78465224 - 50386.75811093 = 19.02654131
```

That difference is not account margin used. It is the gap between equity and the
provider's available/effective equity. The displayed `3776.78` is consistent with
UTA initial margin (`imr`) and is now shown as `INITIAL MARGIN`; generic account
`MARGIN USED` is unavailable unless an explicit occupied/used amount is returned.
