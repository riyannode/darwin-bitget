# Runbook

## Local checks

Run `npm install`, `npm run typecheck`, `npm test`, `npm run check`, `npm run build`, and `npm run deploy:dry`.

## Worker configuration

The Worker requires `TRADING_MODE=PAPER`, `PAPER_ONLY=true`, and `AGENT_MODE=AUTONOMOUS` or `EVA_EVALUATION`. Bitget and Qwen credentials belong in local secret configuration or Cloudflare secrets, never in source or fixtures.

For the Bitget AI hackathon Qwen subsidy key, use `QWEN_BASE_URL=https://hackathon.bitgetops.com/v1` with `QWEN_MODEL=qwen3.8-max`. Do not send that subsidy key to a DashScope regional endpoint.

The owner policy defaults to 30% maximum single-position margin allocation, 5x maximum leverage, 10% daily drawdown, 60-minute cooldown, 15-minute scan cadence, and emergency stop disabled. The authenticated Policy page can update the bounded runtime values; the Durable Object persists them and reschedules the scan when its interval changes.

Set `OWNER_CONTROL_TOKEN` as a Cloudflare Worker secret. Keep it out of GitHub, Vercel environment variables, browser bundles, and logs. The browser retains a token only in memory for authenticated control and policy requests.

## Credentialed PAPER verification

Set `PAPER_INTEGRATION=1`, `PAPER_TEST_LIFECYCLE=1`, provide all Bitget credentials, select a currently tradable `PAPER_TEST_SYMBOL`, set `PAPER_TEST_ACTION` to `OPEN_LONG` or `OPEN_SHORT`, set `PAPER_TEST_MARGIN_PCT` and `PAPER_TEST_LEVERAGE`, and set `PAPER_CONFIRM_ORDER=YES` before running `npm run test:paper`. The suite submits one bounded opening order and one closing order only after dynamic contract validation and deterministic risk approval. It verifies provider readback, position removal, and numeric realized PnL. It never retries an ambiguous write.

No credentials means `PAPER_INTEGRATION_NOT_RUN`, not a passing integration result.
