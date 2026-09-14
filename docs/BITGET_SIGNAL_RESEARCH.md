# DARWIN Bitget Signal Research Layer

Status: implementation on `feat/bitget-signal-research`, based on `431b325acddec77e2cd3ce2d44383816d74c61cb`.

This layer is optional perception enrichment. It does not own trading, risk, sizing, execution, reconciliation, or provider state.

## Official source review

Primary sources reviewed:

- Repository: [Bitget-AI/bitget-signal](https://github.com/Bitget-AI/bitget-signal)
- Package: `@bitget-ai/bitget-signal`, published version `1.2.0` from the npm registry
- Agent Hub: [Bitget-AI/agent_hub](https://github.com/Bitget-AI/agent_hub)
- Public MCP endpoint: `https://datahub.noxiaohao.com/mcp`
- MCP transport: Streamable HTTP, initialized with the official MCP TypeScript client
- Authentication: no Bitget account, API key, or MCP credential required according to the official package source
- Runtime requirements from source: Node.js >=20; `technical-analysis` documentation requires local Python with `pandas` and `numpy`

The package is two separate things: five Markdown skill files and an MCP registration. A skill is not one MCP tool.

### Advertised workflows

| Skill | Official workflow shape | Underlying tools in the official playbook |
|---|---|---|
| `macro-analyst` | Full snapshot in parallel, or focused rates/inflation/cross-asset query | `rates_yields`, `macro_indicators`, `cross_asset`, `global_assets`, `tradfi_news`, `cn_market`, `global_data` |
| `market-intel` | Structural/on-chain proxy analysis; explicitly discloses unavailable direct whale/ETF/cycle metrics | `news_feed`, `tradfi_news`, `crypto_market`, `derivatives_sentiment`, `defi_analytics`, `dex_market`, `network_status` |
| `news-briefing` | Topic-filtered latest headlines, or a multi-feed morning/social briefing | `news_feed`, `tradfi_news`, `derivatives_sentiment`, `social_trending` |
| `sentiment-analyst` | Three-call quick snapshot or deeper positioning comparison | `sentiment_index`, `derivatives_sentiment` |
| `technical-analysis` | Local Python/pandas/numpy indicator calculation over Bitget candles; 23 indicators | Official Markdown uses Python and direct candle retrieval. The public MCP also exposes a separate `technical_analysis` tool; v1 uses only that MCP tool and does not port the Python implementation. |

### MCP capability probe

The probe used `@modelcontextprotocol/sdk@1.30.0`, performed MCP initialization, then `listTools()` through Streamable HTTP. It observed server `market-data-mcp` version `1.26.0` and 19 tools:

```text
crypto_market
 defi_analytics
 dex_market
 sentiment_index
 tradfi_news
 crypto_price
 social_trending
 network_status
 derivatives_sentiment
 global_data
 news_feed
 cn_market
 global_assets
 crypto_derivatives
 technical_analysis
 backtest
 macro_indicators
 rates_yields
 cross_asset
```

Relevant schemas were read from `listTools()` rather than invented:

- `technical_analysis`: `action` enum (`rsi`, `macd`, `bollinger`, `ma`, `ema`, `atr`, `support_resistance`, `full_analysis`, `batch_analysis`), `symbol`, `symbols`, `timeframe`, `period`; required `action`.
- `news_feed`: `action` (`latest`/`sources`), `feeds`, `keyword`, bounded `limit` 1–10; required `action`.
- `sentiment_index`: `action` (`current`/`history`/`realtime`), bounded `days`/`hours`; required `action`.
- `derivatives_sentiment`: `action`, `symbol`, `period` enum, bounded `limit`; required `action`.
- `rates_yields`: `action`, `rate_key`, bounded `limit`; required `action`.
- `macro_indicators`: `action`, `indicator`, `indicators`, bounded `limit`; required `action`.

Probe observations:

- MCP initialization/listing worked without credentials. The first initialization was 349–379 ms and tool listing was 115 ms.
- `technical_analysis(full_analysis)` returned compact structured results for `CRCL/USDT`, `COIN/USDT`, `HOOD/USDT`, `MSTR/USDT`, and `NVDA/USDT` in 176–378 ms.
- `technical_analysis(full_analysis, KORU/USDT)` returned `No OHLCV data for KORU/USDT/4h`.
- Macro, news, and sentiment calls were not admitted to Worker v1: selected calls reached approximately 15–30 seconds and/or returned empty upstream values. One longer probe took approximately 166 seconds to initialize. Those capabilities are not shown to the deployed research router.

## Capability matrix

`WORKER-COMPATIBLE` means proven for the bounded Worker recipe, not merely present in the official Markdown.

| Skill | Worker-compatible | Scope | RWA symbol support | Underlying MCP tools | DARWIN calls/request | Coverage gap |
|---|---|---|---|---|---:|---|
| `macro-analyst` | NO | GLOBAL | NO | `rates_yields`, `macro_indicators`, `cross_asset`, `global_assets` | 2+ | Latency and empty upstream indicator results exceeded v1 bounds |
| `market-intel` | NO | SYMBOL-SPECIFIC | NO | `derivatives_sentiment`, `crypto_market`, `defi_analytics`, `dex_market` | 1+ | Crypto/on-chain oriented; RWA perp support not proven |
| `news-briefing` | NO | SYMBOL-SPECIFIC | NO | `news_feed`, `tradfi_news`, `social_trending` | 1+ | Probe feed results were empty and latency exceeded v1 bounds |
| `sentiment-analyst` | NO | SYMBOL-SPECIFIC | NO | `sentiment_index`, `derivatives_sentiment` | 1+ | Empty sentiment/positioning values for tested probes |
| `technical-analysis` | YES, MCP-only | SYMBOL-SPECIFIC | PARTIAL | `technical_analysis` | 1 | Official skill source uses local Python; five tested symbols returned useful MCP output; KORU did not |

RWA/symbol probe coverage for the current DARWIN set:

| Symbol | `technical-analysis` MCP | Other four skills | Notes |
|---|---|---|---|
| `CRCLUSDT` | PROVEN | NOT ADMITTED | `CRCL/USDT` returned structured technical output |
| `COINUSDT` | PROVEN | NOT ADMITTED | `COIN/USDT` returned structured technical output |
| `HOODUSDT` | PROVEN | NOT ADMITTED | `HOOD/USDT` returned structured technical output |
| `MSTRUSDT` | PROVEN | NOT ADMITTED | `MSTR/USDT` returned structured technical output |
| `NVDAUSDT` | PROVEN | NOT ADMITTED | `NVDA/USDT` returned structured technical output |
| `KORUUSDT` | UNSUPPORTED | NOT ADMITTED | MCP returned no OHLCV data; no fake RWA support is claimed |

## Runtime architecture

```text
cheap universe scan
  → candidate shortlist + existing provider positions
  → optional Qwen research router
  → deterministic TypeScript plan validation
  → bounded MCP recipe execution (technical-only in v1)
  → compact in-memory ResearchEvidence
  → existing Qwen trading decision
  → existing deterministic validation/risk gate
  → existing PAPER execution/readback/reconciliation
```

The router receives only the available, proven capability matrix. It cannot name tools, URLs, endpoints, leverage, allocations, order quantities, or provider operations. TypeScript maps an accepted skill to one fixed recipe and fixed arguments.

Research is disabled unless `BITGET_SIGNAL_ENABLED=true`. A missing flag, router failure, malformed plan, unsupported request, timeout, MCP error, oversized normalization, or cache miss leaves the existing decision path valid.

## Research contract and bounds

- `ResearchPlan = { requests: [] | ResearchRequest[] }`; empty is valid.
- `MAX_RESEARCH_REQUESTS_PER_CYCLE = 3`.
- `MAX_MCP_TOOL_CALLS_PER_CYCLE = 4`.
- `RESEARCH_CONCURRENCY = 2`.
- Router timeout: 10 seconds.
- Individual MCP tool timeout: 8 seconds.
- Total MCP phase: 15 seconds.
- One deterministic recipe attempt; no recursive loop and no blind retry.
- Cache: ephemeral in-memory `Map`, ten-minute TTL, key = skill + scope + recipe version.
- Normalized evidence: at most five facts, three limitations, 6 KiB per item, 16 KiB per cycle using `TextEncoder` byte counts.
- Raw MCP responses, full feeds, prompts, model output, and arbitrary JSON are not stored or passed to the main decision prompt.

The cold MCP connection requires one standards-compliant initialization request. Because v1 has one MCP call per accepted request and accepts at most three requests, cold enrichment is at most:

```text
1 research-router Qwen request
+ 1 MCP initialize request
+ 3 MCP tool requests
= 5 new external requests
```

Warm cache hits add zero external research requests. `MAX_MCP_TOOL_CALLS_PER_CYCLE=4` remains a hard validator bound for future recipes; the current admitted recipe set is one tool call per request and the request cap is three.

For the latest production no-write cycle, the observed evidence set was five symbols. Existing cycle reads are approximately:

```text
1 open-position read
+ 2 universe reads
+ 1 lightweight ticker scan
+ 1 candidate Qwen request
+ 4 shared evidence reads
+ 2 × 5 symbol evidence reads
+ 1 main decision Qwen request
= 20 existing external requests before enrichment
```

The cold research upper bound makes that observed no-write path approximately 25 external requests, leaving headroom under the 50-subrequest Worker limit. Existing sequential financial write/readback behavior is unchanged; this PR adds no requests to that path. Research concurrency is at most two waiting MCP calls.

## Storage impact

- Added Durable Object tables: **0**.
- Added Durable Object reads per cycle for research: **0**.
- Added Durable Object writes per cycle for research: **0**.
- Raw persistence: **NO**.
- No journal field stores research payloads. The main decision sees only bounded in-memory normalized evidence.
- Execution-capacity hints are derived from already-fetched market/instrument/account evidence and are also not persisted.

## Execution-capacity prevention

The latest production KORU evidence was read back before implementation:

```text
cycleId: 1d1d8214-b5d5-402e-a293-76ad16f997ed
decisionId: 98498f13-fb95-42a8-82cf-79693f77ebd3
action: OPEN_SHORT
symbol: KORUUSDT
marginAllocationPct: 1.5
leverage: 3
calculated quantity: 118.31
market price: 19.033
portfolio equity: 50043.28106382
effective provider max quantity: 100
risk status: BLOCK
risk code: MAX_ORDER_QTY
PAPER_ORDER_SUBMITTED: no
```

The hint derives the same effective provider max semantics used by the risk gate. In the regression fixture:

- max executable notional is `1902.6`;
- old `1.5% × 3` proposal is `118.42` quantity and remains blocked;
- `1.2% × 3` produces `94.74`, which is expressible;
- no TypeScript clamp or provider write is introduced.

## Learning duplicate investigation

The latest `/api/learning` readback contains two distinct `RISK_GATE` lesson rows for KORU, with different lesson IDs, actions, regimes, and creation times. They are distinct historical records, not identical persistence duplicates. This PR does not change the learning system or add deduplication.
