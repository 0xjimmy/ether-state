# Cleanup and tick-window traces

Each chain ran for 60 seconds with live pool tracking and a 100-block historical backfill. The app used its existing depth tracker and the reusable pool definition on one EvmClient.

| Chain | Log batches | Gaps | App errors | Median / max lag, blocks | Apply p95, ms | HTTP envelopes | Depth refreshes |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| base | 31 | 0 | 0 | 0 / 1 | 0.339 | 404 | 0 |
| robinhood | 624 | 0 | 0 | 5 / 19 | 3.702 | 1352 | 1 |

Both historical jobs completed. Both traces retained ten displayed levels on each side in every captured snapshot. The tracker keeps three spare initialized boundaries on each side. It requests a refill when fewer than two spare boundaries remain. Large price jumps can still exhaust that reserve before RPC reads finish. The configured bitmap search radius can also limit available depth.

Base had no RPC error envelopes. Robinhood had six upstream rate-limit envelopes. The client recovered without an app error or an applied log gap. Lag remains nonzero and variable. These runs do not prove zero added latency.

The preceding one-spare-boundary trial briefly showed eight or nine levels after fast crossings. It also had a late eleven-block lag spike with six rate-limit responses. That observation prompted the larger reserve. Its raw trace remains in the app workspace at `.data/traces/2026-09-20T07-10-06.308Z`.

These are operational checks, not isolated performance comparisons. Local verification overlapped parts of these runs. The final watchState ownership fix completed during verification; the pool tracker uses watchCall and does not exercise watchState. The source manifest records the reviewed source, not an assertion that every source edit preceded both traces.

The final library check passed 86 tests, type checking, lint, build, and packed ESM, CommonJS, and declaration consumers. The app passed 19 tests and its production build. Both new live and finite forward examples ran successfully. Cleanup tests cover concurrent close calls, pending reads, stream completion, writer release, scope exit, WebSocket closure, and watchState decoder interruption.

Reproduce from the sibling app directory:

```sh
TRACE_CHAIN=base TRACE_HISTORY_BLOCKS=100 TRACE_DURATION_MS=60000 bun run trace:pools
TRACE_CHAIN=robinhood TRACE_HISTORY_BLOCKS=100 TRACE_DURATION_MS=60000 bun run trace:pools
```

The summaries and compressed raw traces are adjacent to this file. Endpoint latency, rate limits, and pool activity vary between runs.

## Upstream recovery follow-up

The app's configured Robinhood endpoints reproduced an origin failure. An endpoint returned HTTP 403, and the old policy stopped the logical read. The shared EvmClient policy now rotates all upstream HTTP status and decoding failures. It also rotates remote parameter rejections and unknown provider errors. Transient RPC internal errors retry. Local request encoding failures and valid contract reverts remain terminal.

The client retains at most two active attempts and the total request deadline. Its attempt budget expands beyond four when verified eligible endpoints remain. Untried endpoints take priority. Rotated failures lower that endpoint's priority for the method for 60 seconds.

The same app configuration then found and verified pool creation at block 1,506,281. No pool-specific RPC retry was added. These recovery changes and the PGlite transaction-drain fix followed the timed traces above. The tests cover these final changes; the trace timings do not measure them. The app now shows the underlying error message instead of only the error stage.
