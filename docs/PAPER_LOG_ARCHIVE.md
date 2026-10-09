# PAPER journal archive and collection epochs

This procedure applies after the archive-export release is explicitly approved and deployed. Do not run it against the current production SHA unless the deployed runtime confirms the route exists. It does not authorize a deployment, scheduler resume, order, recovery, or quarantine change.

## Startup-effects gate

`TraderAgent.fetch()` dispatches the owner-authenticated archive GET, current-epoch export GET, and epoch-start POST directly before the framework lifecycle fetch. These paths therefore do not invoke `onStart()` or its schema/read-model initialization, historical quarantine backfill, policy hydration, or scheduler reconciliation. The archive/export GETs use read-only persisted-state, schedule, and SQL reads and fail closed if state is unavailable. The epoch-start POST performs only its documented additive `risk_state` write after archive-proof verification; it does not run startup migrations/backfills. All other routes retain normal lifecycle startup behavior. Before production extraction, independently verify the deployed route/SHA, persisted PAUSED/idle state, zero trading schedules, and exact quarantine identities; compare the same identities before/after extraction. Never call the archive/export routes through a fallback that invokes lifecycle startup, and stop if request routing does not prove this bypass.

## Owner-authenticated source snapshot

The endpoint is private and requires the existing owner bearer authentication. It also refuses unless the runtime is `PAPER_ONLY`, the agent is persistently `PAUSED`, no cycle is running, and there is no `runScheduledCycle` schedule.

```text
GET /api/paper-log/archive?op=snapshot
Authorization: Bearer <local owner token>
```

`snapshot.contentSha256` covers every scoped source row in stable table/rowid order, including raw payload and row metadata. `snapshot.quarantineContentSha256` is the SHA-256 of the raw persisted quarantine-state payload (or `[]` when unset); the response also lists the sanitized quarantine identities with reason and creation timestamp as provenance. Include both digests and those full sanitized quarantine records in the archive manifest/readback record. Do not mark an archive complete if any table reports invalid payload rows.

The snapshot call executes its state/schedule checks, per-table count/high-water reads, and bounded 50-row-page content-hash scan under `blockConcurrencyWhile`, so a cold export never runs lifecycle startup and concurrent DO requests cannot mutate rows mid-snapshot. Recompute the canonical content digest from every downloaded page. Also preserve and compare `quarantineIdentities` and `quarantineContentSha256` against the final owner-authenticated snapshot before epoch start. Any digest/count/cursor/identity mismatch makes extraction incomplete. Keep the agent paused between requests; the epoch-start endpoint rechecks counts, high-water marks, and the content digest before persisting the boundary, so in-place payload edits during download are rejected.

## Bounded pages

The `contentSha256` algorithm is reproducible offline in Node.js: start with 32 zero bytes; visit tables in `journals`, `cycles`, `experiences`, `events` order; divide each table's rowid-ordered stream into canonical groups of 50 (including an empty group for an empty table); serialize each group as `JSON.stringify([table, pageNumber, rows.map(r => [r.rowId, r.recordId, r.createdAt, r.rowMetadata, r.payload])])`; replace the chain with `SHA256(previousDigestBytes || UTF8(serializedGroup))`. Store this digest in `manifest.json` as `sourceContentSha256`, and send the exact value as `archiveContentSha256` when starting the epoch.

For each source table, request pages with the corresponding `highWaterRowId` from the snapshot:

```text
GET /api/paper-log/archive?op=page&table=journals&afterRowId=0&throughRowId=<highWaterRowId>&limit=50
Authorization: Bearer <local owner token>
```

Repeat using `page.nextCursor` as `afterRowId` until `hasMore=false`. Keep each page in a local temporary directory and assemble offline; never request one giant JSON export. Each page row includes the exact source `payload`, stable `rowId`/`recordId`/`createdAt`, and `rowMetadata` for table columns not duplicated inside the payload (experience symbol/outcome and event type/cycle ID). The API returns at most 50 rows, and fails with HTTP 413 rather than truncating if any row in the next page exceeds 128 KiB. Any non-200 page, repeated/non-advancing cursor, duplicate rowid, parse failure, or mismatch from snapshot counts means the archive is incomplete and must not be published.

`journals` pages contain autonomous records only. `cycles` pages contain only cycles linked to those autonomous journals; `events` pages contain cycle-linked journal events only and exclude `CONTROL` / `PROVIDER_SYNC_*` telemetry; `experiences` pages contain the complete historical experiences table with its source row metadata. Counts and high-water marks describe those exact scoped rows, not the full provider ledger or all database rows. Late reconciliation and quarantine-clear events remain included when linked to an archived autonomous cycle. Preserve stored identifiers and timestamps, and report source scope and included counts separately. Decision counts come from journal records; do not infer the journal total from the previous 5,354-row observation.

## Offline assembly and publication checks

Assemble verified records in deterministic order. If the serialized archive is at most 20 MiB, publish a readable `paper-log.jsonl`; otherwise write gzip-compressed JSON Lines chunks named `paper-log-0001.jsonl.gz`, etc., each below 50 MiB and comfortably under GitHub's per-file limit. Include a `manifest.json`, `summary.json`, `paper-log-summary.csv`, and a `README.md` under:

```text
submissions/archive/2026-10-09/
```

The manifest must identify `PRODUCTION / AUTONOMOUS / PAPER`, deployed SHA, UTC collection bounds, exact source and included counts, `sourceContentSha256`, `quarantineContentSha256`, verified/unresolved execution counts, provider-verified closed-trade metrics, per-chunk row counts and SHA-256, total rows, unique cycle/decision identity checks, schema version, and `complete: true` only after all checks pass.

Before publication, inspect the full projection and every decompressed chunk. Do not publish credentials, API keys, bearer headers, passphrases, owner tokens, raw prompts, hidden chain-of-thought, or private provider headers. Preserve the original production records; create a documented public projection and never rewrite source records. If a sensitive field cannot be safely projected without changing a financial fact, stop publication and report the exact field class. Do not commit local raw downloads, temporary pages, secrets, or the reserved `submissions/paper-log-final.json` / `.csv` files.

After pushing the archive, read each exact GitHub artifact back, recompute SHA-256, parse every chunk, verify row counts and identity uniqueness, and compare the manifest's source totals with the snapshot. A successful push response alone is not publication proof.

## Start the new collection epoch

Only after the verified archive has been published and read back from GitHub, POST to the owner-authenticated `/api/paper-log/archive/epoch` endpoint while still paused:

```text
POST /api/paper-log/archive/epoch
Authorization: Bearer *** owner token>
Content-Type: application/json
```

The JSON body must use the exact values from the verified source snapshot and archive manifest:

```json
{
  "action": "START_PAPER_LOG_COLLECTION_EPOCH",
  "archiveManifestSha256": "<64-character lowercase SHA-256>",
  "archiveContentSha256": "<snapshot.contentSha256>",
  "quarantineContentSha256": "<snapshot.quarantineContentSha256>",
  "archivedCounts": { "journals": 0, "cycles": 0, "experiences": 0, "events": 0 },
  "highWaterRowIds": { "journals": 0, "cycles": 0, "experiences": 0, "events": 0 }
}
```

The numeric values above are placeholders, not production counts. The Worker recomputes the bounded source digest and raw quarantine-state digest and refuses if counts, high-water marks, either SHA-256, payload validity, PAPER mode, paused/idle state, or zero trading schedules do not match. It persists one additive `risk_state` marker; it does not delete or rewrite journals, cycles, events, experiences, idempotency keys, quarantines, position context, provider ledger, lessons, risk state, or financial baselines.

The default JSON/CSV exports query the current-epoch dataset only and start cycles/journals/events above their persisted high-water marks. Experiences are included when linked from current-epoch journal evidence (or a current-epoch reconciliation event), even if the experience row itself predates the epoch; closed experiences can be linked by evidence from any window in that epoch snapshot, while `entryTime`/`exitTime` preserve whether a position was opened historically or during the current collection period. Closed experience metrics are projected into the period containing their stored `exitTime`, so an experience referenced in an opening window is not counted as closed or credited with later PnL until its close window; it is emitted there exactly once even when the closing period has no journal referencing it. Standard full-summary exports remain bounded at 500 combined rows / 2 MiB and support UTC period filters. `from` and `to` are inclusive; when combining adjacent summary windows, set the next `from` one millisecond after the previous `to` to avoid boundary double-counting.

For raw current-epoch exports above that threshold, use keyset pages without pausing the PAPER scheduler:

```text
GET /api/export/paper-log?page=snapshot&from=<optional-UTC>&to=<optional-UTC>
GET /api/export/paper-log?page=next&cursor=<opaque-cursor>&format=json&limit=16
GET /api/export/paper-log?page=next&cursor=<opaque-cursor>&format=csv&limit=16
```

The snapshot response returns one initial cursor per table plus a fixed `highWaterRowIds` boundary for all four source tables. Follow each table cursor until `hasMore=false`; use the returned `nextCursor` verbatim. Pages sort by stable SQLite `rowid`, not timestamps, and are limited to 16 rows / 2 MiB payload, with a 128 KiB maximum per source row; oversized or invalid rows fail with an explicit error rather than being omitted. JSON and CSV carry the same page metadata, source rows, and continuation token. Raw pages deliberately have no page-local financial summary (`summaryScope=NOT_INCLUDED_IN_RAW_PAGES`); use the bounded period JSON/CSV export for period summaries. The experiences page can include pre-epoch experience rows, but its linkage subqueries read only current-epoch journals/events through the snapshot boundaries; historical journals are not reloaded. Snapshot/page requests perform read-only SQL and do not inspect or alter scheduler state, quarantine, provider ledger, idempotency, learning state, or financial baselines. The snapshot also carries a source-mutation revision. Updates/deletes to any source table after snapshot creation increment that revision; a continuation against a changed revision returns HTTP 409 (`PAPER_LOG_COLLECTION_EXPORT_SNAPSHOT_STALE`) instead of mixing mutable journal/experience versions or silently missing a newly linked pre-epoch experience. Start a fresh snapshot and restart the affected table export after that response. Inserts after the snapshot are excluded by the fixed rowid boundaries. This mechanism does not re-read the historical archive.

Late reconciliation for a pre-epoch execution must be stored as new evidence linked to its original cycle/decision and archive reference. Do not mutate the archived record silently. The interim archive does not freeze competition results; the final reserved paths remain absent until the owner separately confirms the final freeze.
