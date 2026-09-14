# Deployment

## Production topology

```text
Vercel static frontend → Cloudflare Worker + Durable Object
                     → public market APIs / Qwen hackathon endpoint
                     → authenticated narrow gateway → Cloudflare Tunnel
                     → stable-egress gateway → Bitget Demo PAPER API
```

The public site is [https://darwin-bitget.vercel.app/](https://darwin-bitget.vercel.app/). The repository's `vercel.json` rewrites `/api/*` to the production Worker. A self-hosted deployment must replace that destination with the developer's own Worker URL; never point a fork at the original Worker accidentally. Public market operations may remain direct; private authenticated Bitget operations use the gateway path shown above.

## Fork, clone, and self-host paths

Keep the three execution contexts separate:

1. **Live Production** — [darwin-bitget.vercel.app](https://darwin-bitget.vercel.app/), the deployed autonomous Bitget Demo PAPER runtime for judges.
2. **Credential-free Docker Judge Demo** — deterministic local replay with no provider or model credentials.
3. **Forked/self-hosted PAPER** — a developer's own Cloudflare Worker, Durable Object state, Vercel project, and Bitget Demo account.

The live site remains available to judges. A fork must never point its
frontend at the original production Worker by accident.

### A. Credential-free Judge Demo

```bash
git clone https://github.com/riyannode/darwin-bitget.git
cd darwin-bitget
docker compose up --build
```

This path uses `JUDGE_DEMO=true`, local fixtures, and no production resources.
It requires no Bitget, Qwen, EVA, owner-control, or funded-account
credentials. Bitget order APIs, Qwen, EVA, scheduler financial work, and
production Durable Object state are unavailable in this mode. Cleanup:

```bash
docker compose down -v --remove-orphans
```

### B. Forked/self-hosted PAPER production

Requirements:

- Node.js and npm;
- a Cloudflare account and Wrangler;
- a Vercel account;
- a stable-egress Bitget gateway on the operator's backend;
- a Qwen API key.

```bash
git clone https://github.com/riyannode/darwin-bitget.git
cd darwin-bitget
npm install
npm run typecheck
npm test
npm run build
npm run deploy:dry
```

Set only the gateway service secret, Qwen key, owner-control token, and any
configured EVA secret as backend-only Cloudflare Worker secrets. The Worker must
not store or receive `BITGET_API_KEY`, `BITGET_SECRET_KEY`, or `BITGET_PASSPHRASE`.
Never place real values in
the repository, browser, frontend bundle, public Vercel environment, logs, or
paper-log exports:

```text
BITGET_GATEWAY_SERVICE_SECRET
OWNER_CONTROL_TOKEN
QWEN_API_KEY
```

The stable gateway alone stores `BITGET_API_KEY`, `BITGET_SECRET_KEY`, and
`BITGET_PASSPHRASE` in a restrictive environment file. It exposes only the
narrow typed DARWIN actions and runs in Bitget Demo PAPER mode.

Optional EVA configuration is separate and backend-only:
`EVA_API_URL`, `EVA_GATEWAY_URL`, `EVA_AGENT_ID`, and `EVA_AGENT_API_KEY`.
`EVA_AGENT_API_KEY` is a Worker secret. The agent ID is runtime configuration,
not a frontend credential.

### Bitget transport and Worker deployment

The repository script reads current Git `HEAD` and injects the full commit as `GIT_COMMIT_SHA`:

```bash
npm run deploy:dry
npm run deploy
```

The first deployment stays `TRADING_MODE=PAPER` and `PAPER_ONLY=true`. Do not
enable live-money trading and do not make a fresh clone immediately submit
autonomous orders.

### Vercel deployment

Fork/import the repository into Vercel, set the frontend API rewrite to the
self-hosted Worker, deploy, and verify browser requests reach that Worker.
The frontend needs no provider, model, owner-control, or EVA secret. Confirm
the deployed rewrite does not still target the original production Worker.

## Pre-resume verification

Before `START`/`RESUME`, verify:

1. Worker health.
2. `/api/snapshot` reachable for Durable Object runtime state.
3. Provider-only `/api/live/portfolio` account and position read succeeds.
4. `/api/live/portfolio` returns `source=PROVIDER_LIVE` and a non-stale readback.
5. Positions/open orders readback succeeds.
6. Qwen connectivity succeeds.
7. Authenticated owner controls work.

Only then start or resume autonomous scheduling. DARWIN Bitget is configured
for Bitget Demo PAPER trading. Do not convert this fork/self-host guide into
live-money trading instructions.

## Architecture-change rollout gate

This cycle-plan change has intentional financial behavior impact. Before deploying an exact PR HEAD:

1. verify the runtime is idle and no unresolved execution needs investigation;
2. manually `PAUSE` and verify matching scheduler count becomes zero;
3. preserve current provider positions; do not manually close CRCL or force an entry;
4. deploy the exact PR HEAD and verify the Worker commit marker, `/api/snapshot`, `/api/live/portfolio`, gateway health, and scheduler configuration;
5. manually `RESUME` only after the readbacks pass.

Post-deploy acceptance observes at least two completed autonomous cycles. Each should show `MARKET_SCAN`, a non-zero scan count, separate entry shortlist and position-management evidence, total proposed actions at most five, healthy scheduler, and `PROVIDER_LIVE`. A trade is not required. If a write naturally occurs, require full provider readback and `MATCHED` reconciliation. A temporary fresh paper-log export checks historical compatibility and provider verification accounting; it is not automatically the final competition export.

## Deployment verification and final artifacts

Compare Worker source SHA from deploy output with `/api/snapshot.commit`. Verify the Vercel source/deployment SHA separately and ensure the frontend deployment corresponds to the same final PR HEAD. A healthy provider readback from `/api/live/portfolio` shows `PROVIDER_LIVE` and a non-stale result. Do not commit `submissions/paper-log-final.json` or `.csv` until the collection period is complete; final metrics use closed provider-verified trades only.
