# Deployment

## Production topology

```text
Vercel static frontend → Cloudflare Worker + Durable Object
                     → Bitget Demo UTA + Qwen hackathon endpoint
```

The public site is [https://darwin-bitget.vercel.app/](https://darwin-bitget.vercel.app/). The repository's `vercel.json` rewrites `/api/*` to the production Worker. A self-hosted deployment must replace that destination with the developer's own Worker URL; never point a fork at the original Worker accidentally.

## Credential-free Judge Demo

```bash
git clone https://github.com/riyannode/darwin-bitget.git
cd darwin-bitget
docker compose up --build
```

This path uses `JUDGE_DEMO=true`, local fixtures, and no production resources. Cleanup:

```bash
docker compose down -v --remove-orphans
```

## Self-hosted PAPER production

Requirements: Node.js/npm, Cloudflare account and Wrangler, Vercel account, Bitget Demo API credentials, and a Qwen API key.

```bash
git clone https://github.com/riyannode/darwin-bitget.git
cd darwin-bitget
npm install
npm run typecheck
npm test
npm run build
npm run deploy:dry
```

Set these as backend-only Cloudflare Worker secrets:

```text
BITGET_API_KEY
BITGET_SECRET_KEY
BITGET_PASSPHRASE
QWEN_API_KEY
OWNER_CONTROL_TOKEN
```

Optional EVA configuration is separate and backend-only: `EVA_API_URL`, `EVA_GATEWAY_URL`, `EVA_AGENT_ID`, and `EVA_AGENT_API_KEY`. Never put Bitget secret/passphrase, Qwen key, owner token, or EVA agent key in client code, browser storage, public Vercel environment, logs, exports, or GitHub.

## Worker deployment

The repository script reads current Git `HEAD` and injects the full commit as `GIT_COMMIT_SHA`:

```bash
npm run deploy:dry
npm run deploy
```

The first deployment stays `TRADING_MODE=PAPER` and `PAPER_ONLY=true`. Do not enable live-money trading.

## Vercel deployment

Fork/import the repository into Vercel, set the frontend API rewrite to the self-hosted Worker, deploy, and verify browser requests reach that Worker. The frontend needs no provider/model secret.

## Pre-resume verification

Before `START`/`RESUME`, verify:

1. Worker health.
2. `/api/snapshot` reachable.
3. Bitget Demo account read succeeds.
4. `portfolioFreshness.source=PROVIDER_LIVE`.
5. `portfolioFreshness.stale=false`.
6. Positions/open orders readback succeeds.
7. Qwen connectivity succeeds.
8. Authenticated owner controls work.

Only then resume autonomous scheduling. This guide is not live-money trading instruction.

## Deployment verification and final artifacts

Compare Worker source SHA from deploy output with `/api/snapshot.commit`. Verify the Vercel source/deployment SHA separately. A healthy live readback shows `PROVIDER_LIVE` and `stale=false`. Do not commit `submissions/paper-log-final.json` or `.csv` until the collection period is complete; final metrics use closed provider-verified trades only.
