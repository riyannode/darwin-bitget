# Trading Universe

The normal runtime does not use a manually curated symbol allowlist. The official Bitget instrument catalog is fetched at runtime and filtered deterministically for online tokenized-stock contracts in `BITGET_CATEGORY` (default `USDT-FUTURES`) where provider metadata reports `symbolType=stock` and `isRwa=YES`, with usable quantity, margin, and leverage metadata.

The resulting provider-valid universe is passed to Qwen. Qwen selects a bounded shortlist and later selects the final instrument. A symbol absent from the current provider catalog is rejected by the deterministic gate.

Each cycle uses two market stages. Stage 1 calls the official SDK instrument catalog and one category-wide ticker request for lightweight candidate evidence. It does not create a trade decision. Qwen selects at most five candidates, while symbols with existing positions are always retained for position review.

Stage 2 collects per-candidate ticker data, 48 fifteen-minute historical bars, account assets, positions, and open orders. The resulting evidence bundle is passed to Qwen for the independent strategy thesis and futures action decision.
