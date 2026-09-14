# Live Evidence

## Judge path

Open [https://darwin-bitget.vercel.app/](https://darwin-bitget.vercel.app/). This is the live production frontend for the autonomous Bitget Demo PAPER agent. Current values are runtime state, not frozen submission metrics.

## What a judge should observe

Every autonomous cycle still scans the full executable Demo stock-perpetual universe with a lightweight market scan. Qwen receives separate ownership labels:

- `openPositionEvidence` — current provider positions that must each receive one `HOLD`, `INCREASE`, `REDUCE`, `CLOSE`, or `REVERSE` management action;
- `entryCandidateEvidence` — selected supported-universe candidates that may receive optional `OPEN_LONG` or `OPEN_SHORT` actions.

An open CRCLUSDT position no longer makes the whole cycle conceptually focus on CRCLUSDT. A valid cycle can show `HOLD CRCLUSDT LONG`, `INCREASE CRCLUSDT LONG`, `REDUCE CRCLUSDT LONG`, `CLOSE CRCLUSDT LONG`, or `REVERSE CRCLUSDT → SHORT` alongside an unrelated `OPEN_LONG NVDAUSDT` evaluation. No new entry is forced when evidence is insufficient.

The dashboard Cycle Plan groups actions into `POSITION MANAGEMENT` and `NEW ENTRY ACTIONS`. The compact Market Discovery section shows universe scanned count, selected entry candidates, existing positions managed, total proposed actions, and financial writes performed. Decision History groups actions by cycle rather than presenting one primary decision.

## Implemented and verified in source

- Bitget Demo UTA / PAPER mode is the execution environment.
- PAPER scan eligibility is dynamically discovered from the Demo stock-perpetual catalog.
- The Worker performs provider readback and deterministic reconciliation.
- The browser refreshes provider-only `/api/live/portfolio` approximately every 10 seconds.
- The browser refreshes Durable Object runtime state from `/api/snapshot` approximately every 60 seconds and loads bounded history endpoints lazily when pages open.
- `/api/live/portfolio` bypasses Durable Object hot-path reads. Private authenticated Bitget operations use the narrow gateway over Cloudflare Tunnel to the stable-egress gateway; public market operations may remain direct.
- If an account or position provider read fails, the UI shows provider state as unavailable. It does not display journal portfolio fallback.
- Financial writes are PAPER-only, bounded to five semantic actions and five physical writes per cycle, serialized `CLOSE/REVERSE-close → REDUCE → INCREASE → OPEN → REVERSE-open`, refreshed between matched writes, and stopped after ambiguity. INCREASE shows additional margin and existing leverage; REVERSE shows close verification separately from opposite-entry result.

## Provider-live semantics

`PROVIDER_LIVE` and `stale=false` mean the current account/position response came from the provider-only read path. Judge-demo fixtures are explicitly recorded replay evidence and are never labeled provider live. A dashboard cycle plan proves schema/rendering and discovery evidence; it does not by itself prove a production multi-write cycle.

## Evidence classes and limitations

- Journal evidence: Durable Object audit records of cycles, plans, decisions, risk results, writes, and learning.
- Provider evidence: direct Bitget Demo order/position/readback and reconciliation facts.
- Live dashboard state: current provider readback from `/api/live/portfolio` when `PROVIDER_LIVE` and non-stale.
- Final competition PAPER log: a later full production export, still `PENDING FINAL COMPETITION EXPORT`.

Do not claim a new autonomous financial write unless a real provider readback and `MATCHED` reconciliation show it. The Docker replay and manual harness are not autonomous competition history.
