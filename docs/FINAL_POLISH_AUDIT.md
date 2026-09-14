# Final Judging Polish Audit

This historical audit covered the pre-PR #4 judging polish pass. The current
architecture change is documented in `docs/ARCHITECTURE.md`, `docs/VERIFICATION.md`,
and `docs/SUBMISSION.md`. PR #4 intentionally changes financial behavior by
separating position management from new-entry planning; it is not SAFE_CLEANUP.

| Finding | Classification | Handling |
| --- | --- | --- |
| The pre-PR #3 mandate version and wording did not explicitly require a separated decision rationale, supporting evidence, risk/invalidation explanation, or evidence limitations. | `SAFE_CLEANUP` (historical) | The prior polish pass updated `darwin-mandate-v4`; PR #4 now intentionally supersedes it with `darwin-mandate-v5` and `darwin-decision-v3` for the CycleDecisionPlan contract. |
| The judge-facing decision panels rendered thesis, factors, and lessons but omitted the persisted `evidenceUsed` field. | `SAFE_CLEANUP` | Rendered `EVIDENCE USED` beside the existing explanation fields. |
| `getSchedulerDiagnostics` contained an unused `activeCycle` local. | `SAFE_CLEANUP` | Removed the dead local; scheduler behavior is unchanged. |
| `gateway/src/server.ts` imported `ServerResponse` without using it. | `SAFE_CLEANUP` | Removed the unused type import. |
| The opt-in paper integration harness contained an unused `positionSide` parser. | `SAFE_CLEANUP` | Removed the dead helper; the explicit harness contract is unchanged. |
| `src/agent/agent.ts` combines lifecycle, request routing, scheduler, persistence, execution, reconciliation, and reflection responsibilities. | `DEFER_AFTER_HACKATHON` | No broad `agent.ts` split in the final judging PR. |
| The decision, risk gate, decimal, provider, scheduler, execution, and persistence seams already have focused contracts and regression coverage. | `NO_CHANGE_NEEDED` | Preserved existing behavior and tests. |
| Best-effort telemetry deliberately catches persistence failures so telemetry cannot prevent cycle handling. | `NO_CHANGE_NEEDED` | Preserved the intentional failure boundary. |
| No actionable `TODO`, `FIXME`, or `HACK` markers were found in product source or documentation during the audit. | `NO_CHANGE_NEEDED` | No marker cleanup was needed. |
| Small response/text helpers are repeated across the Worker, Durable Object, and gateway runtime boundaries. | `DEFER_AFTER_HACKATHON` | Consolidation would cross runtime seams without judge-facing leverage; no refactor made. |
| Decimal arithmetic is canonical in `src/trading/decimal.ts`, while provider parsing has an isolated decimal-summing helper. | `DEFER_AFTER_HACKATHON` | Decimal semantic consolidation is excluded from this PR; no refactor made. |
| External/provider and persisted JSON boundaries use bounded `unknown` values with explicit narrowing and schema parsing; a small number of casts remain. | `NO_CHANGE_NEEDED` | Strict typecheck and existing boundary validation pass; no unsafe widening added. |
| The production temporary scan-interval exercise remains in the agent lifecycle. | `DEFER_AFTER_HACKATHON` | Scheduler behavior is excluded; no refactor made. |
| Judge replay/test logic is isolated under `demo/` and guarded by `JUDGE_DEMO`. | `NO_CHANGE_NEEDED` | The separate deterministic demo boundary is intentional and unchanged. |
| Bitget adapter code repeats parsing/normalization for positions, profit rates, fills, and provider statuses. | `DEFER_AFTER_HACKATHON` | Provider behavior is excluded; no adapter refactor made. |

The historical five cleanup findings remain unchanged. PR #4 is a separate
intentional architecture/financial-behavior change and must not be classified as
SAFE_CLEANUP.