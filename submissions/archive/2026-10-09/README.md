# DARWIN Interim Historical Archive (PRODUCTION / AUTONOMOUS / PAPER)

This is an **INTERIM HISTORICAL ARCHIVE**, not final competition results. It is a public, sanitized projection of the owner-authenticated production source snapshot.

## Scope and source integrity

- Deployed Worker SHA: `67d20a088aa76a77f8bef8cee7f697f7a97f34df`
- Atomic source snapshot captured: `2026-10-09T10:15:07.489Z` (UTC)
- Source content SHA-256: `705f2e28c6058d6c15ff8b791a47bbe690ca46242a9e05cbe88203be34a26e18` (raw source stream only; it is not the hash of these public files)
- Quarantine-state SHA-256: `fb3c977309ec52a30b93a14d01bc30ff2fab4b8d6abe0aa3f916a678b325560d`; 10 sanitized quarantine identities are recorded in `manifest.json`.
- Source counts: journals 2677; cycles 2677; experiences 1173; events 31384; total 37911.
- Counts describe autonomous PAPER journals and their scoped cycles/events plus the complete historical experiences source table. The mutable Bitget provider ledger is authoritative but is not represented as an atomic part of this archive.

The source digest is computed from all bounded pages under the snapshot high-water marks. Each gzip chunk has separate compressed and uncompressed SHA-256 hashes in `manifest.json`. Public projection hashes are intentionally distinct from the raw source digest.

## Public projection policy

Each JSONL record preserves source table, row ID, source record ID, source timestamp, row metadata, and the relevant public projection. Decision/action, risk-gate, execution request/result, reconciliation status/codes, provider order/client-order references, trade quantities/prices, realized PnL, fees, funding, and associated cycle/event identities are retained as recorded. Recorded experience PnL is accompanied by its original provider-verification flag and an independently derived status; a closed trade is labeled provider-verified only when its unique linked exit decision has executionResult.status=filled and reconciliation.status=MATCHED, and the source realizedPnlVerified flag is true.

This projection does not publish raw source payloads, model prompts, hidden chain-of-thought, internal reflection narratives, internal backtest details, account-wide asset/balance snapshots, or raw provider error messages. Prompt *version identifiers* are retained; they are labels, not prompt text. ACCOUNT_ASSETS evidence payloads are withheld for account-level privacy. Those omissions do not change journal execution, reconciliation, or experience financial fields.

## Files

- `manifest.json`: source boundary, hashes, counts, provenance, identity and execution checks.
- `summary.json`: counts, time bounds, verification scope, and provider-verified metrics.
- `paper-log-summary.csv`: judge-readable metric summary.
- `paper-log-####.jsonl.gz`: bounded JSON Lines public projection chunks; decompress with `gzip -dc <file>`.

The public projection is not a provider-ledger export and does not replace authoritative provider reconciliation. No production source rows were modified to create this archive.
