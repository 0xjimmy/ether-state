# Reusable Indexer pool-watch measurements

Each run measures 60 seconds after the existing pool tracker starts. The generic pool instance runs alongside it, using the same EvmClient and an in-memory PGlite database. The instance follows live blocks and collects 100 blocks before bootstrap. Tests use the same pool addresses and upstream configuration as the baseline.

Run from the sibling library-tests app:

```sh
TRACE_CHAIN=robinhood TRACE_HISTORY_BLOCKS=100 TRACE_DURATION_MS=60000 bun run trace:pools
TRACE_CHAIN=base TRACE_HISTORY_BLOCKS=100 TRACE_DURATION_MS=60000 bun run trace:pools
```

## Results

| Chain | Baseline median / max lag, blocks | With Indexer median / max lag, blocks | Live log batches | Applied gaps | App errors | Backfill |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Robinhood | 4 / 8 | 5 / 8 | 628 | 0 | 0 | Complete |
| Base | 0 / 1 | 0 / 1 | 30 | 0 | 0 | Complete |

The generic Indexer's sampled lag also stayed within eight blocks on Robinhood and one block on Base. Robinhood's first and last event lag were six and five blocks, with a fitted slope of -0.0298 blocks per second. Base began and ended at zero lag. These runs show bounded lag during this observation window, not a guaranteed latency limit.

The Robinhood instance committed 729 covered blocks, including the requested pre-bootstrap range, and emitted 606 candle updates. Base committed 131 covered blocks and emitted 46 candle updates. The existing tracker counts and Indexer counts start at different bootstrap blocks and must not be subtracted to infer gaps.

Robinhood recovered three provider rate-limit envelopes. Base had no RPC error envelopes. The additional historical work increased total HTTP envelopes from 1088 to 1321 on Robinhood and from 168 to 416 on Base. Counts include startup. WebSocket requests are excluded.

The existing tracker update p95 rose from 0.63 to 4.12 ms on Robinhood and from 0.35 to 1.24 ms on Base. The new worker adds database and projection work in the same process. The measurement does not isolate which operation caused that increase. Rebuilding each affected candle from its stored events is a likely optimization target. The runs do not establish that the new worker is free of CPU cost.

## Evidence and limits

The JSON summaries contain endpoint timings, five-second lag samples, coverage, Indexer state, candle update counts, and errors. Compressed JSONL traces retain RPC envelope summaries, pool snapshots, and candle updates.

Public endpoint load differs between runs. The baseline Robinhood run overlapped the library test suite. The final Robinhood run overlapped local package-consumer validation near startup. These are practical observations, not a controlled provider benchmark.

The timed runs preceded a final cleanup that strips unused header fields from in-memory model batches. That cleanup did not change RPC scheduling or projection logic. `reviewed-source-manifest.json` identifies the reviewed source after that cleanup, not an immutable commit captured at benchmark start.

These runs use a known 100-block lower bound. They do not measure complete pool-lifetime backfill or prove archive availability. Origin discovery has separate regression tests for upstream archive failure, factory-log fallback, and explicit range limits. Archive support and log limits belong to individual upstreams, not to the chain as a whole.

The implementation still fetches historical headers and hash-pinned logs per block. It needs a range-fetch path for high-throughput lifetime indexing. Database retention and pagination are also future work.

## Validation

Type checking, lint, build, packed ESM/CommonJS/declaration consumers, and all new deterministic tests passed. The full suite ran 73 tests before the final origin regression was added. One direct Viem call to mainnet.base.org failed with a provider rate limit; both Base tests passed when rerun against base-rpc.publicnode.com. An earlier full-suite attempt had a transient historical-block failure that passed in isolation. The final origin regression and the other focused tests passed.

The app passed 14 tests and its production build. Vite still reports the existing PGlite eval and bundle-size warnings. The running development server serves the updated app module. A browser smoke test was attempted, but Chromium downloads timed out, so browser interaction and multi-tab behavior were not verified in this environment.
