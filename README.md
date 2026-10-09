# DARWIN Bitget

**DARWIN is an autonomous Qwen portfolio agent for Bitget US-stock perpetual PAPER trading.**

Bitget market/account evidence → Qwen decisions → deterministic risk gate → Bitget PAPER execution → provider readback → reconciliation → journal and learning.

## Judge paths

- **Live Production:** [darwin-bitget.vercel.app](https://darwin-bitget.vercel.app/) — current autonomous PAPER runtime and provider state.
- **Judge Demo:** [Docker replay guide](docs/DEMO.md) — deterministic recorded replay; no live orders or external calls.
- **Paper Log Export:** after the archive-export release, JSON/CSV expose the active collection epoch only; complete historical archives are owner-authenticated, paginated, and published separately after validation.
- **Submission docs:** [Judge submission](docs/SUBMISSION.md) · [Verification](docs/VERIFICATION.md) · [Deployment](docs/DEPLOYMENT.md).
- **Architecture:** [authority boundaries and runtime](docs/ARCHITECTURE.md).

## How it works

The autonomous cycle reads Bitget PAPER account and market evidence. Qwen proposes decisions; deterministic backend validation and risk controls retain financial authority. Bitget readback and reconciliation verify outcomes before the journal and learning records are updated.

```text
Bitget evidence → Qwen decisions → deterministic risk gate
→ Bitget PAPER execution → provider readback → reconciliation
→ journal / learning
```

**Financial truth is split by purpose:** Bitget PAPER provider account reads are authoritative for current equity, balances/margin, positions, and open orders. The Bitget provider ledger is authoritative for historical orders, fills, lifecycle history, realized/net PnL, fees, and funding. DARWIN local state contains Qwen reasoning, decisions, risk gates, journals, learning/reflections, attribution/read models, and audit state; it does not override Bitget provider truth.

A symbol-level PRE-WRITE market evidence failure skips and records that symbol without a financial write or stopping unrelated symbol actions. Post-write reconciliation uses canonical provider account/position readback, independent of ticker/kline availability. Ambiguous or unresolved execution remains fail-closed and quarantined by symbol, so an unresolved MSTR execution need not block unrelated valid symbols.

## Judge Demo

Run the separate deterministic replay locally:

```bash
docker compose up --build
```

Open [http://localhost:3000/demo](http://localhost:3000/demo):

- `/demo?scenario=verified-open`
- `/demo?scenario=hold`
- `/demo?scenario=risk-reject`

The interface identifies the data as **RECORDED / DETERMINISTIC REPLAY** and **NO LIVE ORDERS**. Replay account data is not current Bitget provider state. See [the complete demo and verification steps](docs/DEMO.md).

## Metrics and final export

**Live current metrics** can change while autonomous PAPER collection continues; inspect the live endpoints for current values. They are not frozen competition results. **Frozen final submission metrics** are pending the end of collection and must be calculated only from provider-verified closed trades. The reserved `submissions/paper-log-final.json` and `.csv` files are deliberately absent until that final freeze; see [the exact procedure](docs/SUBMISSION.md#final-paper-export-freeze).

## Source and operation

- [Architecture](docs/ARCHITECTURE.md)
- [Submission overview](docs/SUBMISSION.md)
- [Live evidence](docs/LIVE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Verification](docs/VERIFICATION.md)
