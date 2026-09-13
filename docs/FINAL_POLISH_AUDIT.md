# Final Judging Polish Audit

This audit is limited to judge-facing agent quality: decision explainability,
agent architecture quality, risk-control clarity, and maintainability. Financial
behavior, scheduler behavior, provider behavior, execution/reconciliation, and
persisted schema are out of scope.

| Finding | Classification | Handling |
| --- | --- | --- |
| The mandate version and wording did not explicitly require a separated decision rationale, supporting evidence, risk/invalidation explanation, or evidence limitations. | `SAFE_CLEANUP` | Updated the wording to `darwin-mandate-v4`; no decision fields or risk rules changed. |
| The judge-facing decision panels rendered thesis, factors, and lessons but omitted the persisted `evidenceUsed` field. | `SAFE_CLEANUP` | Rendered `EVIDENCE USED` beside the existing explanation fields. |
| `getSchedulerDiagnostics` contained an unused `activeCycle` local. | `SAFE_CLEANUP` | Removed the dead local; scheduler behavior is unchanged. |
| `gateway/src/server.ts` imported `ServerResponse` without using it. | `SAFE_CLEANUP` | Removed the unused type import. |
| The opt-in paper integration harness contained an unused `positionSide` parser. | `SAFE_CLEANUP` | Removed the dead helper; the explicit harness contract is unchanged. |
| `src/agent/agent.ts` combines lifecycle, request routing, scheduler, persistence, execution, reconciliation, and reflection responsibilities. | `DEFER_AFTER_HACKATHON` | No broad `agent.ts` split in the final judging PR. |
| The decision, risk gate, decimal, provider, scheduler, execution, and persistence seams already have focused contracts and regression coverage. | `NO_CHANGE_NEEDED` | Preserved existing behavior and tests. |
| Best-effort telemetry deliberately catches persistence failures so telemetry cannot prevent cycle handling. | `NO_CHANGE_NEEDED` | Preserved the intentional failure boundary. |

Only the five `SAFE_CLEANUP` findings are implemented here.