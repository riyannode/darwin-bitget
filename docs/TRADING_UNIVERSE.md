# Trading Universe

PAPER scan eligibility comes from the official Bitget Demo `USDT-FUTURES` instrument catalog with `paptrading=1`. Darwin dynamically filters it to online stock/RWA perpetual instruments with valid quantity, margin, and leverage metadata. It never hardcodes the current symbol list or count.

Public ticker/history endpoints remain market-data sources. A symbol absent from the Demo executable catalog cannot enter candidate selection, deep evidence, a new OPEN decision, or execution. The effective pipeline is:

```text
Demo instruments → online stock symbols → lightweight market scan
→ Qwen shortlist → deep evidence → decision/risk/execution
```

The scan does not interpret indicators as trade rules. Qwen selects a bounded shortlist and receives deeper history, account/position state, orders, events when available, and retrieved lessons. Existing provider positions are retained for position-aware management even when discovery later changes.

If Demo discovery fails, Darwin fails closed for new financial decisions rather than falling back to the public universe.
