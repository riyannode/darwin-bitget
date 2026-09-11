# Bitget Autonomous Trader

Standalone Cloudflare Workers agent for autonomous PAPER perpetual-futures trading on the dynamically discovered Bitget contract catalog.

The main path is:

```text
dynamic universe → lightweight scan → Qwen shortlist → deep evidence
→ Qwen decision → deterministic policy gate → Bitget PAPER
→ readback → reconciliation → journal → reflection → lessons
```

Qwen owns strategy selection, symbol selection, `OPEN_LONG` / `OPEN_SHORT` / `HOLD` / `REDUCE` / `CLOSE`, thesis, margin allocation, and leverage selection. `src/trading/policy.ts` and `src/trading/risk-gate.ts` own financial authority boundaries.

The minimal frontend is a dark trading journal with Dashboard, Trade Log, Learning, and read-only Policy pages. It is an observability surface and has no manual trading controls.

## Local validation

```text
npm install
npm run typecheck
npm test
npm run deploy:dry
```

`npm run test:paper` is a separate opt-in suite. Without explicit credentials and `PAPER_CONFIRM_ORDER=YES`, it reports `PAPER_INTEGRATION_NOT_RUN` and places no order.

No EVA repository or EVA source is modified by this project.
