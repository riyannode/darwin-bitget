# Runbook

## Local source checks

```bash
npm install
npm run typecheck
npm test
npm run build
npm run deploy:dry
```

## Credential-free Judge Demo

```bash
docker compose up --build
```

Open `http://localhost:3000/demo`. Use `?scenario=verified-open`, `?scenario=hold`, or `?scenario=risk-reject`. Cleanup:

```bash
docker compose down -v --remove-orphans
```

The demo requires no `.env`, credentials, or external network at runtime. It never submits orders.

## Worker configuration

The Worker requires `TRADING_MODE=PAPER`, `PAPER_ONLY=true`, and `AGENT_MODE=AUTONOMOUS` or `EVA_EVALUATION`. Bitget and Qwen credentials belong in Cloudflare secrets, never in source, fixtures, `wrangler.jsonc`, Vercel public variables, or browser storage.

The owner policy defaults to 30% maximum single-position margin allocation, 5x maximum leverage, 10% daily drawdown, 60-minute cooldown, 15-minute scan cadence, and emergency stop disabled. Runtime policy/control mutations require `OWNER_CONTROL_TOKEN` and persist in the Durable Object.

## Safe first start

Before `START` or `RESUME` on a self-hosted Worker, verify:

1. Worker health.
2. Snapshot reachable.
3. Bitget Demo account read succeeds.
4. `portfolioFreshness.source=PROVIDER_LIVE` and `stale=false`.
5. Positions and open orders readback succeeds.
6. Qwen connectivity succeeds.
7. Owner controls authenticate.

Keep the first deployment PAPER-only. Do not force a trade while validating.

## Credentialed PAPER verification

The opt-in `npm run test:paper` suite requires explicit credentials and `PAPER_CONFIRM_ORDER=YES`. It submits only the configured bounded PAPER lifecycle after dynamic instrument and risk checks. No credential means `PAPER_INTEGRATION_NOT_RUN`; it is not a passing execution result. Never use the manual harness as autonomous competition history.

## Operational safety

An unresolved provider write remains unknown/unresolved and is not silently converted to a fill or failure. The cycle stops remaining financial writes after ambiguity. Provider diagnostics are sanitized before journaling and exporting.
