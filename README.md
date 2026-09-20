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

Native watch reorg rollback and broader provider failure coverage still need work and tests. A successful live run does not prove that all recovery paths work.

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

The defaults use a zero-millisecond collection window, 20 items per batch, 256 KB per HTTP batch, and 1,024 calldata bytes per Multicall3 batch. `httpBatchWindow`, `httpBatchMaxItems`, `httpBatchMaxBytes`, `multicallWindow`, `multicallMaxCalls`, and `multicallMaxCalldataBytes` can change these limits. `hedgeDelay` sets the minimum delay for a second read attempt; its default is 100 ms. The client increases this delay from recent response times to avoid unnecessary duplicate requests. The old `batchWindow` and `batchSize` options remain aliases for compatibility.

Viem `newHeads` and log subscriptions recover missed block numbers after a notification gap. Header watches fetch headers only. Log watches use one block-hash-pinned `eth_getLogs` request for each filter and block. The adapter rejects wallet methods and node-managed filter lifecycle methods. It accepts `eth_sendRawTransaction` only for an already signed transaction.

### Native log and call watches

`client.watchLogs()` emits all logs. Pass an address and topic filter to select logs locally.
All native log consumers share one upstream stream. Extra filters do not add RPC requests.

`client.watchLogBlocks(filter)` emits a complete log array for every processed block, including empty matches.
Each batch includes `block` and `observedAt`. The block contains its number, hash, parent hash, timestamp, and log bloom.
The stream fills gaps in observed block numbers and emits batches in order. This is live catch-up, not durable indexing or reorg rollback.
Use the indexer for durable checkpoints and rollback.

The log stream uses hash-pinned, unfiltered `eth_getLogs` reads for a short backlog, with up to eight blocks in flight.
For a larger backlog, it uses ranges of up to 16 blocks and checks returned log hashes against the expected headers.
The newest block remains on the hash-pinned path. Endpoints that reject unfiltered ranges are excluded from range reads.
If a range fails, the client falls back to per-block reads. If unfiltered log reads are unsupported, it uses validated receipts.
Native log tracking no longer requires full transaction bodies. Address and topic matching remains exact.
A nonzero bloom requires logs in an unfiltered result; this check does not prove that a provider returned every log.

`watchCall` and `watchState` pin reads to the reported block hash with `requireCanonical: true`.
They keep the newest pending head while an existing read completes. These are latest-state watches, not a read for every block.
Transient failures resume on the current head. `watchState` exposes `Retrying` and `Failed`, with the previous value when available.
A requested historical call never silently changes its block reference.

### Request recovery and progress

Idempotent reads, block polling, log fetching, and historical fetches use the same internal request policy.
Each physical RPC read has at most two concurrent attempts and a total `requestTimeout` budget.
The attempt limit is at least four and expands to cover the verified eligible endpoints. Untried endpoints take priority over repeated attempts.
Endpoint queue time is part of that budget. A high-level operation can require several physical reads.
Writes such as transaction submission do not use this retry policy.

The client ranks eligible endpoints by measured valid-response time, load, cooldown, and prior attempts.
HTTP standbys can serve reads after a selected endpoint fails. Connected WebSocket endpoints remain a fallback for reads.
Successful responses cancel losing attempts. Unsupported methods and log-range restrictions are remembered.
HTTP batches learn reported item limits and split future batches. Rate limits reduce endpoint throughput, followed by gradual recovery. The affected method prefers other endpoints for 30 seconds, so one expensive method does not repeatedly exhaust the same provider.
Upstream HTTP errors, invalid responses, remote parameter rejections, and unknown provider errors retry or rotate before reaching a consumer. Rotated failures lower that endpoint's method priority for 60 seconds. Local request encoding errors and valid contract reverts remain terminal. If the deadline or attempt budget expires, the client returns the last typed failure.

Head discovery runs independently of log catch-up:

- Below 500 ms block time, the client does not speculate about future blocks. It polls latest with a deadline of at least 500 ms, capped by `requestTimeout`, and keeps at most one polling operation active. Fresh WebSocket heads suppress polling. If a request exceeds the polling interval, the next iteration starts immediately.
- At 500 ms or above, the client also starts a next-block request 150 ms before the expected arrival. The burst uses a 50 ms hedge interval and bounded retries. In-flight and rate limits can delay additional attempts. A separate latest-head check recovers missed announcements.

`client.metrics.requests` counts reads, attempts, and extra attempts across transports. Extra attempts include hedges and retries.
`client.metrics.streams` reports the observed head, delivered log block, lag, last progress time, and last live-read error.
Its status is `idle`, `live`, or `degraded`. Degraded status includes stale head observations and a log backlog over the larger of two blocks or two seconds.
The `http` counters describe the HTTP batcher only; they do not count direct HTTP requests.
Long-lived streams can retry a failed bounded read while reporting degradation. A `never` stream error type does not guarantee freshness.

Run the live Base comparison for 60 seconds per client:

```sh
BASE_RPC_HTTP_URL=https://your-base-rpc.example bun run bench:viem
```

Set `BENCH_DURATION_MS`, `BENCH_CONCURRENCY`, `BENCH_WORKLOAD`, or `BENCH_ADDRESS` to change the run. Workloads include `contractReads`, `distinct`, `dedupe`, `balance`, and `blockNumber`. Set `BENCH_HTTP_BATCH_WINDOW` or `BENCH_MULTICALL_WINDOW` to compare collection windows. Set `BENCH_OUTPUT` to write clean JSON to a file. The benchmark sends reads through isolated paths on one local counting proxy and reports latency, throughput, failure, byte, envelope, JSON-RPC item, and concurrency counts.

## Indexing

The `ether-state/indexer` subpath adds typed, resumable indexes without putting database policy in EvmClient. One EvmClient can supply many index definitions for one network. Each index has its own ID, version, start block, finality policy, schema, and checkpoint.

```ts
import { Effect, Schema } from "effect"
import { defineIndex, Indexer } from "ether-state/indexer"
import { pgliteStore } from "ether-state/indexer/pglite"

const blocks = defineIndex({
  id: "blocks",
  version: 1,
  startBlock: 1n,
  finality: { mode: "latest" },
  source: { transactions: true },
  valueSchema: Schema.Struct({ hash: Schema.String, transactions: Schema.Number }),
  transform: bundle => Effect.succeed([{
    key: "block",
    value: { hash: bundle.block.hash, transactions: bundle.transactions.length },
  }]),
})

const program = Effect.gen(function* () {
  const store = yield* pgliteStore(pglite)
  const indexer = yield* Indexer.make({ client: evm, index: blocks, store })
  return yield* indexer.sync()
})
```

The runtime fetches hash-pinned block inputs, transforms bootstrap windows concurrently, and commits blocks in chain order. A durable commit stores rows, canonical block metadata, and the checkpoint as one transaction. Restart validates the checkpoint against the canonical block at that number. A fork rolls back to a stored common ancestor and then replays. A conflict with the stored finalized anchor fails closed.

Run only one writer for each index ID. A version change with the same ID fails with `IndexMetadataMismatch`; migrate or remove the old index data before the new definition runs. Built-in adapters store encoded values in `ether_state_rows`, which applications can query through the database object that they supplied.

Storage integrations are structural adapters. The package does not import the database drivers at runtime:

- `ether-state/indexer/pglite` accepts a PGlite object for memory, Node/Bun filesystem, IndexedDB, or another caller-selected PGlite filesystem.
- `ether-state/indexer/libsql` accepts a local libSQL or remote Turso client.
- `ether-state/indexer/d1` accepts a Cloudflare D1 binding and uses one `batch()` for each apply or rollback commit.
- `callbackStore`, `indexChanges`, and `runIndexChanges` provide ordered apply and revert changes for a custom pipeline. Each change includes its checkpoint. Delivery is at least once unless the consumer stores that checkpoint atomically with its writes before it acknowledges the callback.

See [the indexer example](examples/indexer/README.md).

D1 rejects a block if its commit exceeds the platform batch or statement limits. The runtime does not split a block because the rows and checkpoint must stay atomic.

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

The runtime dependency is Effect. Ethers, Viem, Anvil, PGlite, libSQL, Miniflare, and their type packages are development-only dependencies. npm is used only by the release workflow for publishing.

## Source layout

```text
src/
  index.ts
  viem.ts            optional Viem Public Client transport
  indexer.ts         indexing definitions and runtime
  indexer-*.ts       storage adapter entry points
  indexer/           indexing runtime and storage implementations
  rpc/
    client.ts       client setup and orchestration
    schema.ts       RPC schemas and method types
    chainList.ts    cached chain metadata
    live.ts         receipt validation and block timing
    recovery.ts     exhaustive read and watch failure policies
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

- [Local state and simulation](https://github.com/0xjimmy/ether-state/issues/9)

See [the release flow](docs/releases.md). Changes go through a PR to `main`; publishing is a separate `main` to `release` step.

## Reusable indexers

Use `Indexer.define` to define sources and projections once, then create instances for separate pools or plans. See [the interface reference](docs/reusable-indexer.md) and [the examples](examples/indexer/README.md).

The examples cover live memory state, finite forward history, and persistent live candles with backward history. Reusable instances and EvmClient support `close()`. Their owning Effect scopes also close them automatically.
