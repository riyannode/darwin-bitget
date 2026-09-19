# DARWIN Bitget Submission

## Positioning

DARWIN Bitget is an autonomous PAPER futures agent for Bitget's 24/7 US-stock / RWA perpetual market. DARWIN separates portfolio responsibility from opportunity discovery: every cycle re-evaluates each existing position while independently searching the current executable universe for new opportunities. Qwen proposes a bounded multi-action plan; deterministic code controls financial authority.

## Hackathon / Track

- Event: Bitget AI Hackathon S2
- Track: Agentic Trading
- Mode: Bitget Demo PAPER only

## Judge paths

Present the paths in this order:

1. [Live Production](https://darwin-bitget.vercel.app/) — actual autonomous
   Bitget Demo PAPER runtime.
2. **Zero-credential Docker Judge Demo** — run `docker compose up --build` for
   a deterministic, credential-free replay.
3. **Source / fork / self-host** — deploy a separate PAPER instance with the
   developer's own Cloudflare, Vercel, Bitget Demo, and Qwen configuration.
4. **Final PAPER Log** — `PENDING FINAL COMPETITION EXPORT` until collection is
   complete.

These contexts must not be conflated: the live site is production runtime,
the Docker app is recorded replay, and a fork is the developer's own
deployment. See [docs/DEPLOYMENT.md](DEPLOYMENT.md) for the two deployment
paths and the required pre-resume checks.

## Problem

Always-on perpetual markets produce more symbols, evidence, and position state than a fixed UI rule can safely summarize. An autonomous agent needs dynamic provider discovery, bounded model context, position-aware decisions, readback, reconciliation, and persistent learning without allowing model output to bypass owner controls.

## What is implemented

- dynamic Demo stock-perpetual discovery and public market evidence;
- lightweight scan → Qwen shortlist → separate management/entry deep evidence → Qwen `CycleDecisionPlan`;
- `OPEN_LONG`, `OPEN_SHORT`, `HOLD`, `INCREASE`, `REDUCE`, `CLOSE`, and `REVERSE`;
- deterministic owner policy/risk gate, `MAX_TOTAL_ACTIONS_PER_CYCLE=5`, and `MAX_FINANCIAL_WRITES_PER_CYCLE=5`;
- sequential `CLOSE/REVERSE-close → REDUCE → INCREASE → OPEN → REVERSE-open` writes with provider refresh between matched writes and ambiguity stopping remaining writes;
- Bitget Demo UTA execution, readback, reconciliation, journal, and sanitized diagnostics;
- Durable Object SQLite experiences, reflections, lessons, and bounded replay;
- read-only `PROVIDER_LIVE` portfolio dashboard with multi-position Open Position page;
- compact persisted performance aggregate with one-time baseline, verified lifecycle counts, and bounded UTC daily summaries;
- bounded persisted position-context reasoning for original entry and latest management decisions, including legacy CRCLUSDT bootstrap;
- zero-credential deterministic Docker Judge Demo.

## Architecture and responsibility

```text
Demo executable universe → scan → bounded entry shortlist
open provider positions → management evidence
entry candidates → entry evidence
→ Qwen CycleDecisionPlan { positionActions[], entryActions[] }
→ deterministic validation → CLOSE → REDUCE → OPEN sequential planner
→ risk gate → PAPER write → readback → reconciliation → refreshed portfolio
→ journal → learning
```

Private authenticated Bitget operations use the following transport:

```text
Cloudflare Worker → authenticated narrow gateway request → Cloudflare Tunnel
→ stable-egress gateway → Bitget Demo PAPER API
```

Public market operations may remain direct. The Worker does not store
`BITGET_API_KEY`, `BITGET_SECRET_KEY`, or `BITGET_PASSPHRASE`; those credentials
remain in the stable-egress gateway. The Worker stores only backend-only gateway,
Qwen, owner-control, and optional EVA secrets.

The data boundary is explicit: provider-live `/api/live/portfolio` performs no Durable Object reads and reports current Bitget state; persisted `/api/snapshot` performance reports verified DARWIN aggregates; `/api/position-context` reports bounded structured decision evidence. These are not interchangeable and structured evidence is not hidden chain-of-thought.

Qwen proposes strategy, thesis, symbol, direction, management intent, margin allocation, and leverage. Deterministic code owns PAPER-only mode, hard owner bounds, provider metadata, balance/margin validation, existing-side INCREASE semantics, reverse sequencing, idempotency, readback, reconciliation, and fail-closed ambiguity handling.

## Agent-quality evidence contract

The current prompt contracts are `darwin-mandate-v6`, `darwin-candidate-v1`, `darwin-decision-v9`, `darwin-reflection-v1`, and `darwin-backtest-v2`. Each action must explain its decision rationale, supporting evidence, risk and invalidation conditions, evidence limitations, and lessons used. INCREASE carries additional margin and preserves provider leverage; REVERSE carries previous side, target side, and two-leg verification. The dashboard exposes those fields grouped by cycle so a judge can distinguish model reasoning from deterministic risk authority.

## Architectural differentiator for judging

- **Decision explainability:** management and entry actions each retain evidence-attributed rationale, risk, confidence, and execution/reconciliation state.
- **Agent architecture:** portfolio management cannot suppress unrelated opportunity discovery; an existing HOLD, INCREASE, REDUCE, CLOSE, or REVERSE and a new entry can coexist when deterministic rules allow it.
- **Risk control:** deterministic five-action cap, current-position validation, refreshed portfolio risk checks, serialized writes, idempotency, and stop-on-ambiguity.
- **Performance integrity:** trade episodes require verified autonomous opens, win rate uses verified classified closed outcomes only, NET PNL SINCE BASELINE is provider equity delta adjusted by the explicit external-flow status from a one-time immutable baseline, and daily summaries use trustworthy UTC equity observations only.
- **Explainability:** Open Position preserves original verified entry reasoning separately from the latest HOLD/INCREASE/REDUCE/CLOSE/REVERSE management reasoning; Trade History exposes structured entry, exit, and lifecycle evidence.
- **Operational integrity:** no forced trades, HOLD remains valid, unresolved writes are not verified trades, and the Docker replay is not production history. No better returns are promised.

## Bitget integration

The Worker uses the official Bitget Agent SDK and Demo UTA context. PAPER eligibility is dynamically discovered from the Demo catalog; public-only symbols cannot become PAPER candidates. The dashboard uses a separate read-only provider portfolio readback for equity, margin, positions, open orders, and signed unrealized PnL.

## Learning loop

Verified outcomes become experiences. Qwen reflection evaluates strategy, evidence, entry, exit, leverage, margin sizing, execution, and outcome separately. Lessons are persisted and retrieved by later decisions. Operational provider failures remain execution-health evidence and are not proof that a strategy, symbol, direction, or liquidity thesis was bad.

## Current production status

The judge path is [https://darwin-bitget.vercel.app/](https://darwin-bitget.vercel.app/). It is a PAPER observability surface backed by a Cloudflare Worker/Durable Object and Bitget Demo UTA. The browser reads provider-only `/api/live/portfolio` approximately every 10 seconds, `/api/snapshot` approximately every 60 seconds, and bounded history endpoints lazily when pages open. Verify current provider state from `/api/live/portfolio`; this document is not a frozen performance report.

## Judge material

| Material | Location / status |
| --- | --- |
| Source | [github.com/riyannode/darwin-bitget](https://github.com/riyannode/darwin-bitget) |
| Live production | [darwin-bitget.vercel.app](https://darwin-bitget.vercel.app/) |
| Canonical Docker Judge Demo | `docker compose up --build` → `http://localhost:3000/demo` |
| Architecture | [docs/ARCHITECTURE.md](ARCHITECTURE.md) |
| Demo guide | [docs/DEMO.md](DEMO.md) |
| Deployment guide | [docs/DEPLOYMENT.md](DEPLOYMENT.md) |
| Verification | [docs/VERIFICATION.md](VERIFICATION.md) |
| Final PAPER log | PENDING FINAL COMPETITION EXPORT |
| Demo video | PENDING |
| X post | PENDING |

## Canonical judge evaluation

1. Open live production to inspect the deployed interface and current read-only provider state.
2. Run the Docker demo and inspect `verified-open`, `hold`, and `risk-reject`.
3. Confirm the replay banner distinguishes recorded evidence from a local provider write.
4. Trace the authority boundary through the architecture and deployment docs.

The Docker Judge Demo is not a live Bitget session. It exists to make the architecture reproducible without sharing credentials.

## Evidence status

Verified facts are listed in [docs/VERIFICATION.md](VERIFICATION.md). The manual NVDA lifecycle is execution-path verification only, not autonomous Worker history. Final competition log and performance metrics remain pending.

## Honest limitations

- PAPER behavior is not proof of live-money performance.
- The final collection-period log is not frozen.
- Provider availability and instrument universe can change.
- EVA evaluation is optional and outside the zero-credential demo.

## Final submission checklist

- [ ] Continue collecting autonomous PAPER history.
- [ ] Export the complete final competition log from Durable Object history.
- [ ] Validate closed verified trades only for final metrics.
- [ ] Record demo video and X submission link.
- [ ] Recheck production SHA, `snapshot.commit`, `PROVIDER_LIVE`, and `stale=false`.
- [ ] Keep credentials out of repository and submission artifacts.
