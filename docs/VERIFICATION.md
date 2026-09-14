# Verification

## Evidence levels

### CODE VERIFIED

The repository is intended to verify the following through typecheck, unit tests, integration boundaries, and the credential-free demo:

- `CycleDecisionPlan` separates `positionActions[]` and `entryActions[]`;
- every open provider position must receive exactly one management action;
- management actions may target existing positions outside `supportedUniverse`;
- new entries require supported-universe membership and current deep evidence;
- `MAX_TOTAL_ACTIONS_PER_CYCLE=5` rejects over-cap intent without truncation;
- `CLOSE → REDUCE → OPEN` ordering is deterministic and financial writes are sequential;
- provider evidence and portfolio state refresh between matched writes;
- ambiguous/unresolved writes stop remaining writes without blind retry;
- idempotency remains per action;
- old journals normalize through `src/storage/journal-normalizer.ts` without destructive migration;
- paper-log effective execution/reconciliation fallback marks legacy matched primary executions verified;
- paper-log action category, cycle discovery, and lifecycle metrics do not count HOLD or unresolved writes as verified trades;
- dashboard and Judge Demo render grouped cycle plans and discovery evidence;
- frontend has no provider credentials or manual financial controls.

The prompt contracts are code-checked as `darwin-mandate-v5` and `darwin-decision-v3`. Reflection/backtest prompt versions remain unchanged.

### PRODUCTION VERIFIED

Only runtime observations after deployment belong here. A source test, Docker replay, or HOLD/no-entry cycle does not prove multi-write production execution. Production verification requires the exact deployed commit, `PROVIDER_LIVE` account/position reads, a healthy scheduler, and provider readback plus `MATCHED` reconciliation for any financial write. No multi-action financial execution is marked production-verified by this source change alone.

## Paper log evidence

The dashboard shows bounded recent history. Full autonomous history is exported through:

```text
GET /api/export/paper-log?format=json
GET /api/export/paper-log?format=csv
```

The export is read-only, includes HOLD cycles, exports every action separately with its action category and cycle-level discovery fields, excludes manual harness and Docker records, and preserves sanitized provider diagnostics. It does not expose credentials, auth headers, passphrases, or model chain-of-thought. The final competition export is still `PENDING FINAL COMPETITION EXPORT`.

## Not claimed

- No guaranteed profitability or meaningful Sharpe ratio when sample size is insufficient.
- A Judge Demo replay is not a live provider session.
- EVA evaluation is not part of the zero-credential demo.
- Final competition-period metrics are not frozen.
- A HOLD + no-entry cycle verifies scheduling/schema behavior only, not a multi-write path.
