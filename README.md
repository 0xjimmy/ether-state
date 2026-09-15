# ether-state

An Effect-based client for reading and watching EVM data. This branch is work toward 0.3, not a release. The old `EtherState` API has been removed.

```ts
import { EvmClient, getChainList, getChain, getRpcEndpoints, getExplorers } from "ether-state"
```

## Client

- Typed RPC methods, errors, and bigint conversion.
- Chainlist discovery, chain validation, and inferred block time.
- HTTP/WS request racing, WS reconnects, rate limits, and bounded queues.
- Request deduplication, result caching, HTTP batching, and compatible Multicall3 reads.
- Shared block, log, transaction, call, and state watches.
- Historical logs, blocks, transactions, and receipts as collected results or streams.

Reorg recovery, endpoint capability learning, and failure recovery still need work and tests. A successful live run does not prove that all recovery paths work.

See [examples](examples/README.md) for runnable scripts and short feature guides.

## Viem Public Client

The `ether-state/viem` subpath adapts public Viem requests to an existing EvmClient. It does not add wallet, account, or signing behavior. Viem stays outside the root package entry point.

```ts
import { Effect } from "effect"
import { createPublicClient } from "viem"
import { base } from "viem/chains"
import { EvmClient } from "ether-state"
import { viemTransport } from "ether-state/viem"

const program = Effect.gen(function* () {
  const evm = yield* EvmClient.make({ network: { chainId: 8453n } })
  const publicClient = createPublicClient({ chain: base, transport: viemTransport(evm) })
  return yield* Effect.promise(() => publicClient.getBlockNumber())
})
```

The adapter uses EvmClient for retries, batching, endpoint selection, and shared block and log streams. Concurrent plain `eth_call` reads use Multicall3. Other compatible concurrent HTTP reads use JSON-RPC batches. Calls with sender, value, gas, or state context remain direct calls. The adapter does not wrap a call that already targets Multicall3.

The defaults use a zero-millisecond collection window, 20 items per batch, 256 KB per HTTP batch, and 1,024 calldata bytes per Multicall3 batch. `httpBatchWindow`, `httpBatchMaxItems`, `httpBatchMaxBytes`, `multicallWindow`, `multicallMaxCalls`, and `multicallMaxCalldataBytes` can change these limits. `hedgeDelay` controls when a second endpoint starts if the first endpoint does not answer; its default is 100 ms. The old `batchWindow` and `batchSize` options remain aliases for compatibility.

Viem `newHeads` and log subscriptions recover missed block numbers after a notification gap. Header watches fetch headers only. Log watches use one block-hash-pinned `eth_getLogs` request for each filter and block. The adapter rejects wallet methods and node-managed filter lifecycle methods. It accepts `eth_sendRawTransaction` only for an already signed transaction.

Run the live Base comparison for 60 seconds per client:

```sh
BASE_RPC_HTTP_URL=https://your-base-rpc.example bun run bench:viem
```

Set `BENCH_DURATION_MS`, `BENCH_CONCURRENCY`, `BENCH_WORKLOAD`, or `BENCH_ADDRESS` to change the run. Workloads include `contractReads`, `distinct`, `dedupe`, `balance`, and `blockNumber`. Set `BENCH_HTTP_BATCH_WINDOW` or `BENCH_MULTICALL_WINDOW` to compare collection windows. Set `BENCH_OUTPUT` to write clean JSON to a file. The benchmark sends reads through isolated paths on one local counting proxy and reports latency, throughput, failure, byte, envelope, JSON-RPC item, and concurrency counts.

## Development

Use Bun 1.3.3.

```sh
bun install --frozen-lockfile --ignore-scripts
bun test
bun run check
bun run test:live
```

`bun test` runs unit and live RPC tests directly from source. It does not require a build.
`bun run check` adds strict TypeScript checks, type-aware lint, a build, and a packed-package check for ESM, CommonJS, and declarations.

Live tests use real Ethereum RPCs and always run in CI. Public endpoints can time out or rate-limit requests; such failures fail the check. Set `RPC_HTTP_URL` to choose an endpoint. `bun run test:live` runs only the live test. CI uses one Bun job. There are no browser tests or Node-version matrices.

TypeScript emits ESM and declarations. Bun builds the CommonJS entry point. The base tsconfig checks source and examples; the build config includes only source. The CommonJS entry requires a runtime that can load Effect's ESM dependency. Node and browser compatibility are not tested in CI.

Runtime dependencies are Effect and ethers. Viem and the Anvil binary are development-only compatibility-test dependencies. npm is used only by the release workflow for publishing.

## Source layout

```text
src/
  index.ts
  viem.ts            optional Viem Public Client transport
  rpc/
    client.ts       client setup and orchestration
    schema.ts       RPC schemas and method types
    chainList.ts    cached chain metadata
    live.ts         block state and timing
    watch.ts        log filters and call/state watches
    history.ts      historical ranges and streams
    query.ts        request deduplication and cache
    multicall.ts    compatible contract-read batches
    transport/
      http.ts       HTTP requests and JSON-RPC batching
      ws.ts         WS state, reconnects, and subscriptions
      queue.ts      batching queue and endpoint budgets
```

## Later

- [Indexing and storage](https://github.com/0xjimmy/ether-state/issues/8)
- [Local state and simulation](https://github.com/0xjimmy/ether-state/issues/9)

See [the release flow](docs/releases.md). Changes go through a PR to `main`; publishing is a separate `main` to `release` step.
