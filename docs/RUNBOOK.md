# Runbook

## Local source checks

```bash
npm install
npm run typecheck
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

The Worker requires `TRADING_MODE=PAPER`, `PAPER_ONLY=true`, and `AGENT_MODE=AUTONOMOUS`. The Worker stores only backend-only gateway, Qwen, and owner-control secrets. Bitget API credentials belong only in the stable-egress gateway, never in Worker secrets, source, fixtures, `wrangler.jsonc`, Vercel public variables, or browser storage. On startup, the Durable Object creates the compact performance and symbol+side position-context read models; their one-time bounded bootstrap must not be moved into `/api/snapshot`.

The owner policy defaults to 30% maximum single-position margin allocation, 5x maximum leverage, 10% daily drawdown, 60-minute cooldown, 5-minute scan cadence, and emergency stop disabled. Runtime policy/control mutations require `OWNER_CONTROL_TOKEN` and persist in the Durable Object.

Daily drawdown baseline is the first valid provider `portfolioEquity` observed for the UTC date; a new baseline is set when the date derived from `now.toISOString().slice(0, 10)` changes. The guard computes `((baselineEquity - currentEquity) / baselineEquity) * 100` using exact fixed-point arithmetic and blocks only when current equity is below baseline and the result is at least `maxDailyDrawdownPct`. This daily guard is distinct from the dashboard's current/peak account drawdown metric, which compares latest equity with persisted peak equity.

## Safe first start

Before `START` or `RESUME` on a self-hosted Worker, verify:

1. Worker health.
2. Snapshot reachable.
3. Provider-only `/api/live/portfolio` account read succeeds.
4. `/api/live/portfolio` succeeds with `source=PROVIDER_LIVE`, a valid `observedAt`, and provider portfolio/readback available; handle optional `degraded`/`errors` explicitly when present.
5. Positions and open orders readback succeeds.
6. Qwen connectivity succeeds.
7. Owner controls authenticate.

Keep the first deployment PAPER-only. Do not force a trade while validating.

## Credentialed PAPER verification

Credentialed PAPER verification is an operator-driven manual procedure against a paused Worker. Confirm the configured bounded PAPER lifecycle end to end through the live dashboard endpoints after dynamic instrument and risk checks. No automated harness submits orders, so a missing credential is not a passing execution result. Never treat a manual check as autonomous competition history.

## Operational safety

An unresolved provider write remains unknown/unresolved and is not silently converted to a fill or failure. The cycle stops remaining financial writes after ambiguity. Provider diagnostics are sanitized before journaling and exporting.

## Cycle-plan rollout and acceptance

This is an intentional financial behavior architecture change, not SAFE_CLEANUP. Before deployment, inspect the provider and scheduler read-only, verify the runtime is idle, confirm no unresolved execution requires investigation, manually `PAUSE`, and verify matching schedule count is zero. Preserve current provider positions; do not manually close CRCL or force a new entry.

Deploy the exact PR HEAD. Verify the Worker commit marker, `/api/snapshot`, `/api/live/portfolio`, gateway health, and scheduler configuration, then manually `RESUME`. Observe at least two completed cycles. For each, verify `MARKET_SCAN` with count greater than zero, a separate entry shortlist, every existing provider position represented in Position Management, independent entry evaluation, total semantic actions no greater than five, physical writes no greater than five, scheduler health, and `PROVIDER_LIVE`. A no-write cycle is valid. Any natural write needs provider readback and `MATCHED` reconciliation. For INCREASE verify post-action margin and existing leverage; for REVERSE verify the old position is gone before any opposite-side order.

Generate a temporary fresh paper-log export after deployment. Confirm legacy journals remain readable/exportable, new multi-action cycles export separately, matched legacy primary executions are verified, summary verified/unresolved counts reconcile, position-context reasoning joins exact symbol + side, performance counts exclude blocked/unresolved openings, and Docker/demo records are absent from autonomous metrics. Do not freeze this temporary export as the final competition log.
