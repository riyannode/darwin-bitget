# DARWIN Bitget

DARWIN Bitget is an autonomous PAPER futures trading agent for Bitget's 24/7 US-stock / RWA perpetual market.

## Hackathon Submission

- Event: Bitget AI Hackathon S2
- Track: Agentic Trading
- Live Production: [darwin-bitget.vercel.app](https://darwin-bitget.vercel.app/)
- Source: [github.com/riyannode/darwin-bitget](https://github.com/riyannode/darwin-bitget)
- Judge Demo: `docker compose up --build`, then [http://localhost:3000/demo](http://localhost:3000/demo)
- Final PAPER Log: pending final competition export
- Demo Video: pending
- X submission: pending

## Judge Paths

1. [Live Production](https://darwin-bitget.vercel.app/) — actual autonomous Bitget Demo PAPER runtime.
2. Zero-credential Docker Judge Demo — deterministic recorded replay with no provider or model calls.
3. Source / fork / self-host — a separate PAPER instance with the developer's own backend credentials.
4. Final PAPER Log — `PENDING FINAL COMPETITION EXPORT` while history is still being collected.

## What DARWIN Does

Each cycle discovers the current executable Bitget Demo stock-perpetual universe, performs a bounded market scan, asks Qwen to select candidates and form a futures decision, validates the proposed action with deterministic policy controls, and only then uses the Bitget Demo execution path. Provider readback and reconciliation decide whether a write is verified. Journals, experiences, reflections, and lessons persist in Durable Object SQLite.

```text
Demo executable universe → lightweight scan → Qwen shortlist → deep evidence
→ Qwen decision → deterministic risk gate → Bitget Demo PAPER
→ provider readback → reconciliation → journal → reflection / learning
```

Qwen owns strategy selection, symbol selection, `OPEN_LONG` / `OPEN_SHORT` / `HOLD` / `REDUCE` / `CLOSE`, thesis, margin allocation, and leverage selection. Deterministic code owns financial authority and safety boundaries. No profitability guarantee is claimed.

## Why It Exists

Bitget's US-stock / RWA perpetual market runs continuously, but an autonomous agent still needs a reliable boundary between reasoning and financial authority. DARWIN shows that the model can make contextual decisions and learn from outcomes while the backend never lets model text grant itself more execution authority.

## Architecture

The Cloudflare Worker hosts the Durable Object agent and API boundary. It reads the dynamic Bitget Demo executable universe, uses public market data as evidence, calls Qwen, and persists the audit path. The browser reads provider-only `/api/live/portfolio` approximately every 10 seconds, reads Durable Object runtime state from `/api/snapshot` approximately every 60 seconds, and loads bounded history endpoints lazily when pages open. Private authenticated Bitget operations use the stable-egress gateway; public market operations may remain direct. The Vercel frontend is an observation surface with no manual trading controls.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/LIVE.md](docs/LIVE.md), and [docs/DEMO.md](docs/DEMO.md).

## Safety Boundary

- `TRADING_MODE=PAPER` and `PAPER_ONLY=true` are required.
- Owner policy limits margin allocation, leverage, drawdown, cooldown, and scheduler cadence.
- Every financial action passes one deterministic risk gate.
- Bitget readback and reconciliation are required before a write is treated as verified.
- An ambiguous write stops remaining writes for that cycle; no blind retry is used.
- External/provider text cannot change policy, auth, PAPER mode, tools, or schemas.

## Judge Quick Start

```bash
docker compose up --build
```

Open [http://localhost:3000/demo](http://localhost:3000/demo). Scenarios:

- `/demo?scenario=verified-open`
- `/demo?scenario=hold`
- `/demo?scenario=risk-reject`

The UI says `JUDGE DEMO`, `RECORDED / DETERMINISTIC REPLAY`, and `NO LIVE ORDERS`. The demo never calls Bitget, Qwen, EVA, or a production Durable Object.

```bash
docker compose down -v --remove-orphans
```

The Judge Demo is not a live Bitget session. It exists to make the architecture reproducible without sharing credentials.

## Live Production

The live site reads provider-only `/api/live/portfolio` for current `PROVIDER_LIVE` portfolio state and current provider unrealized PnL. `/api/snapshot` is the slower Durable Object runtime-state read and is not the live portfolio polling path. If the account or position provider read fails, the UI shows provider state as unavailable and does not show journal portfolio fallback. The detailed Open Position page is read-only. The dashboard is not a substitute for the full historical export.

## Deploy Your Own

The public [live site](https://darwin-bitget.vercel.app/) remains the fastest
judge path. A fork is a separate deployment with its own Worker, Durable
Object state, Vercel project, and Bitget Demo credentials.

### A. Credential-free Judge Demo

```bash
git clone https://github.com/riyannode/darwin-bitget.git
cd darwin-bitget
docker compose up --build
```

This path needs no Bitget credentials, Qwen credentials, EVA credentials,
owner token, funded account, or live-trading account. It is a deterministic
local replay and never submits an order.

### B. Forked/self-hosted PAPER production

Requirements: Node.js/npm, a Cloudflare account, Wrangler, a Vercel account,
a stable-egress gateway configured with Bitget Demo API credentials, and a Qwen
API key. Fork the repository or clone
your fork; do not use the original production Worker for a self-hosted UI.

```bash
git clone https://github.com/riyannode/darwin-bitget.git
cd darwin-bitget
npm install
npm run typecheck
npm test
npm run deploy:dry
```

Set only these as backend-only Cloudflare Worker secrets; use placeholders only
in local examples. The Worker does not store or receive Bitget API credentials:

```text
BITGET_GATEWAY_SERVICE_SECRET
QWEN_API_KEY
OWNER_CONTROL_TOKEN
```

Optional EVA secrets are documented separately in [docs/EVA_INTEGRATION.md](docs/EVA_INTEGRATION.md). Never put `BITGET_API_KEY`, `BITGET_SECRET_KEY`, `BITGET_PASSPHRASE`, `QWEN_API_KEY`, `OWNER_CONTROL_TOKEN`, or `EVA_AGENT_API_KEY` in client code, browser storage, public Vercel environment variables, logs, exports, or GitHub. The stable gateway stores the Bitget credentials and remains PAPER-only.

Deploy the Worker with the repository's actual script: `npm run deploy`. Fork/import the repository into Vercel, point its `/api` rewrite to your own Worker, deploy, and verify the browser reaches your Worker rather than the original production Worker.

The first deployment remains PAPER-only. Before `START` or `RESUME`, verify Worker health, `/api/snapshot` reachability, provider-only `/api/live/portfolio` account and position access, `source=PROVIDER_LIVE`, `stale=false`, positions/open-orders readback, Qwen connectivity, and authenticated owner controls. Do not start an autonomous cycle until those checks pass. DARWIN Bitget is configured for Bitget Demo PAPER trading; this guide is not live-money trading instruction.

## Documentation

- [Submission](docs/SUBMISSION.md)
- [Judge Demo](docs/DEMO.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Live evidence](docs/LIVE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Runbook](docs/RUNBOOK.md)
- [Verification](docs/VERIFICATION.md)
- [Trading universe](docs/TRADING_UNIVERSE.md)
- [EVA integration](docs/EVA_INTEGRATION.md)

## Final PAPER Log

The final competition log is intentionally not committed yet. Reserve `submissions/paper-log-final.json` and `submissions/paper-log-final.csv`; generate them only after collection is complete. Final metrics use closed, provider-verified trades only. Open unrealized PnL and execution failures are not realized performance.
