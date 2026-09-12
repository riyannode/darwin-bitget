# DARWIN Bitget Submission

## Positioning

DARWIN Bitget is an autonomous PAPER futures agent for Bitget's 24/7 US-stock / RWA perpetual market. Qwen selects contextual trading behavior; deterministic code controls financial authority.

## Hackathon / Track

- Event: Bitget AI Hackathon S2
- Track: Agentic Trading
- Mode: Bitget Demo PAPER only

## Problem

Always-on perpetual markets produce more symbols, evidence, and position state than a fixed UI rule can safely summarize. An autonomous agent needs dynamic provider discovery, bounded model context, position-aware decisions, readback, reconciliation, and persistent learning without allowing model output to bypass owner controls.

## What is implemented

- dynamic Demo stock-perpetual discovery and public market evidence;
- lightweight scan → Qwen shortlist → deep evidence → Qwen futures decision;
- `OPEN_LONG`, `OPEN_SHORT`, `HOLD`, `REDUCE`, and `CLOSE`;
- deterministic owner policy/risk gate and one new entry maximum per cycle;
- multiple sequential exits with ambiguity stopping remaining writes;
- Bitget Demo UTA execution, readback, reconciliation, journal, and sanitized diagnostics;
- Durable Object SQLite experiences, reflections, lessons, and bounded replay;
- read-only `PROVIDER_LIVE` portfolio dashboard with multi-position Open Position page;
- zero-credential deterministic Docker Judge Demo.

## Architecture and responsibility

```text
Demo executable universe → scan → Qwen shortlist → deep evidence
→ Qwen strategy/action → risk gate → Bitget Demo PAPER
→ readback → reconciliation → journal → learning
```

Qwen owns strategy, thesis, symbol, direction, exits, margin allocation, and leverage. Deterministic code owns PAPER-only mode, hard owner bounds, provider metadata, balance/margin validation, idempotency, readback, reconciliation, and fail-closed ambiguity handling.

## Bitget integration

The Worker uses the official Bitget Agent SDK and Demo UTA context. PAPER eligibility is dynamically discovered from the Demo catalog; public-only symbols cannot become PAPER candidates. The dashboard uses a separate read-only provider portfolio readback for equity, margin, positions, open orders, and signed unrealized PnL.

## Learning loop

Verified outcomes become experiences. Qwen reflection evaluates strategy, evidence, entry, exit, leverage, margin sizing, execution, and outcome separately. Lessons are persisted and retrieved by later decisions. Operational provider failures remain execution-health evidence and are not proof that a strategy, symbol, direction, or liquidity thesis was bad.

## Current production status

The judge path is [https://darwin-bitget.vercel.app/](https://darwin-bitget.vercel.app/). It is a PAPER observability surface backed by a Cloudflare Worker/Durable Object and Bitget Demo UTA. Verify current provider state from the live snapshot; this document is not a frozen performance report.

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
