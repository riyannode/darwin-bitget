# Canonical Judge Demo

## Requirements

- Docker with Compose support;
- no `.env` file;
- no Bitget, Qwen, EVA, Cloudflare, Vercel, owner token, or funded account;
- no production network access at runtime.

## Run

```bash
git clone https://github.com/riyannode/darwin-bitget.git
cd darwin-bitget
docker compose up --build
```

Open [http://localhost:3000/demo](http://localhost:3000/demo). Health is `/api/health`.

Reset/cleanup:

```bash
docker compose down -v --remove-orphans
```

## Environment contract

The image requires `JUDGE_DEMO=true` and starts a local fixture server. If it is absent or false, the server exits. No secret environment variables are accepted or needed. The process does not initialize the Worker, Durable Object, Bitget SDK client, Qwen client, EVA client, or scheduler.

## No-write guarantee

- no Bitget order API is imported or called;
- no Qwen request is made;
- no EVA request is made;
- no scheduler runs;
- no production Durable Object is touched;
- mutation endpoints return `DEMO_READ_ONLY`;
- the banner says `JUDGE DEMO`, `RECORDED / DETERMINISTIC REPLAY`, and `NO LIVE ORDERS`.

## Scenarios

- `/demo?scenario=verified-open` — recorded CRCLUSDT `OPEN_LONG` evidence with risk `PASS`, provider `filled`, readback, and reconciliation `MATCHED`. The local demo did not send the order.
- `/demo?scenario=hold` — recorded CRCLUSDT LONG context with Qwen fixture decision `HOLD` and no financial write.
- `/demo?scenario=risk-reject` — a deterministic proposal exceeding the real owner leverage boundary. The pure production risk gate returns `BLOCK`/`MAX_LEVERAGE`; no order is submitted.

The demo also exposes `/api/demo/scenarios`, `/api/snapshot`, and clearly labeled replay downloads. Replay exports are not the final competition PAPER log.

## What judges can inspect

Inspect the event stream, latest decision, risk result, execution evidence, reconciliation status, portfolio representation, policy boundary, and source/docs. A fixture position is never labeled `PROVIDER_LIVE`; the UI marks it as replay/fallback evidence.

## Replay versus production

The Docker Judge Demo is not a live Bitget session. It exists to make the architecture reproducible without sharing credentials.

- Live Production: actual autonomous Bitget Demo PAPER runtime at [darwin-bitget.vercel.app](https://darwin-bitget.vercel.app/).
- Docker Judge Demo: credential-free deterministic replay, no external calls, no writes.
- Self-host: a separate Worker/frontend using the developer's own Demo credentials, documented in [DEPLOYMENT.md](DEPLOYMENT.md).

## Evidence status

The verified-open scenario is recorded provider replay evidence. It must not be counted as a new autonomous local order or added to the final competition log.
