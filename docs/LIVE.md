# Live Evidence

## Judge path

Open [https://darwin-bitget.vercel.app/](https://darwin-bitget.vercel.app/). This is the live production frontend for the autonomous Bitget Demo PAPER agent. Current values are runtime state, not frozen submission metrics.

## Implemented and verified

- Bitget Demo UTA / PAPER mode is the execution environment.
- The configured Qwen model is `qwen3.8-max` through the Bitget AI endpoint.
- PAPER scan eligibility is dynamically discovered from the Demo stock-perpetual catalog.
- The Worker performs provider readback and deterministic reconciliation.
- The dashboard has a read-only Open Position page with multiple position cards.
- `PROVIDER_LIVE` portfolio state includes equity, available margin, open orders, positions, mark/entry values, leverage, notional, and signed unrealized PnL when provider data is available.
- The browser refreshes provider-only `/api/live/portfolio` approximately every 10 seconds.
- The browser refreshes Durable Object runtime state from `/api/snapshot` approximately every 60 seconds and loads bounded history endpoints lazily when pages open.
- `/api/live/portfolio` bypasses Durable Object hot-path reads. Private authenticated Bitget operations use the narrow gateway over Cloudflare Tunnel to the stable-egress gateway; public market operations may remain direct.
- If an account or position provider read fails, the UI shows provider state as unavailable. It does not display journal portfolio fallback.
- CRCLUSDT has a recorded PAPER lifecycle example with provider fill/readback and `MATCHED` reconciliation evidence.
- Qwen may `OPEN_LONG`, `OPEN_SHORT`, `HOLD`, `REDUCE`, or `CLOSE`; the backend remains the financial authority.
- One new entry is considered per cycle; multiple existing-position exits can be processed sequentially, and ambiguous writes stop remaining writes.

## Evidence classes

- Journal evidence: Durable Object audit records of Darwin cycles, decisions, risk results, writes, and learning.
- Provider evidence: direct Bitget Demo order/position/readback and reconciliation facts.
- Live dashboard state: current provider readback from `/api/live/portfolio` when `PROVIDER_LIVE` and `stale=false`; no journal portfolio fallback is shown when provider state is unavailable.
- Final competition PAPER log: a later full production export, still `PENDING FINAL COMPETITION EXPORT`.

The manual NVDA lifecycle is execution-path verification only, not autonomous trading history. The Docker replay is not a provider write and must not be added to the final competition log.

## Safety and limitations

The live site is PAPER-only and does not guarantee profitability. Provider instrument availability, model availability, and current positions can change. Verify the current snapshot before making a submission claim. EVA is optional and is not called by the Docker Judge Demo.
