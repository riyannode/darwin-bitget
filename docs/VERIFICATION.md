# Verification

Verified locally:

- strict TypeScript typecheck;
- scenario-based futures risk, reconciliation, margin/leverage execution conversion, learning, and drawdown tests;
- Wrangler dry-run bundle, static assets, and Durable Object binding generation;
- credentialed PAPER lifecycle harness opt-in behavior without credentials.
- deployed Worker and Vercel root/API probes returning HTTP 200;
- deployed title `Darwin`, PAPER mode, version `0.2.0`, commit marker `03142a1`, and production environment readback;
- unauthenticated policy mutation failing closed with `OWNER_AUTH_NOT_CONFIGURED`;
- authenticated owner policy mutation changing the deployed scan interval from 15 to 5 minutes and restoring it to 15 minutes, with persisted `POLICY_UPDATED` audit fields and a rescheduled `nextScan`;
- generated `OWNER_CONTROL_TOKEN` stored in the Windows user environment and uploaded as the Cloudflare Worker secret without exposing its value.
- deployed Qwen configuration using the Bitget AI handbook proxy base URL and `qwen3.8-max`.
- provider fill/history parsers for exact realized PnL, fees, funding, and weighted fill price fallback;
- position-side parsing for provider short positions and lifecycle discrepancy events.

The dashboard is served from `public/` and uses the Durable Object snapshot/control endpoints. The visual implementation follows the supplied dark trading-journal reference with Dashboard, Trade Log, Learning, and read-only Policy pages.

Not verified:

- authenticated Qwen calls;
- authenticated Bitget Demo/PAPER order submission;
- EVA connectivity.

The local PAPER lifecycle harness is armed for `NVDAUSDT`, but currently stops before any write with `BITGET_API_KEY_REQUIRED` because Bitget credentials are not present in the Windows user environment. The latest deployed autonomous cycle reaches `MARKET_SCAN` and then reports `Incorrect API key provided` from the Qwen proxy. No order was attempted by the harness.

No credentials are embedded in the dashboard.

The public Bitget instrument catalog is read-only evidence only. It does not prove that a credentialed Demo/PAPER order will be accepted.
