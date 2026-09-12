# Verification

Verified state:

- strict TypeScript typecheck and scenario-based test suite pass locally;
- Wrangler dry-run bundle, static assets, and Durable Object binding generation pass;
- authenticated Qwen calls work through the configured Bitget AI proxy with `qwen3.8-max`;
- credentialed Bitget Demo/PAPER execution works through the official SDK path;
- manual `NVDAUSDT` execution-path harness verified `OPEN_LONG` → provider readback → `CLOSE` → reconciliation `MATCHED`;
- the manual lifecycle harness reported realized PnL `-0.0456`, final positions `0`, and final open orders `0`;
- hedge-mode close sends `posSide` without `reduceOnly`;
- one-way-mode close sends `reduceOnly`;
- provider parsing supports `orderStatus` and `cumExecQty`;
- the frontend contains Dashboard, Agent Journal, Trade History, Learning, and Policy pages;
- autonomous PAPER history is persisted in Durable Object SQLite and the submission export reads it without the dashboard's latest-25 display limit;
- the export is read-only, includes HOLD cycles, and excludes the manual lifecycle harness because that harness does not write autonomous Worker journals;
- policy/control mutations remain owner-authenticated and PAPER-only.

The manual `NVDAUSDT` lifecycle harness is execution-path verification only. It is not autonomous trading history and must not be presented as an autonomous Worker cycle in a submission log.

The dashboard displays only bounded recent history for readability. The full autonomous log is available through:

```text
GET /api/export/paper-log?format=json
GET /api/export/paper-log?format=csv
```

Both endpoints accept optional `from` and `to` ISO timestamps and never return credentials, auth headers, passphrases, or model chain-of-thought.

Not verified:

- EVA connectivity;
- a two-week competition-period PAPER log, which requires continued autonomous runtime collection.

The public Bitget instrument catalog is read-only evidence. It does not prove that a future credentialed Demo/PAPER order will be accepted.
