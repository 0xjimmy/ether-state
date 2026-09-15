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

The adapter uses EvmClient for retries, batching, endpoint selection, and shared block and log streams. It rejects wallet methods and node-managed filter lifecycle methods. It accepts `eth_sendRawTransaction` only for an already signed transaction.

Run the live Base comparison for 60 seconds per client:

```sh
BASE_RPC_HTTP_URL=https://your-base-rpc.example bun run bench:viem
```

Set `BENCH_DURATION_MS`, `BENCH_CONCURRENCY`, `BENCH_WORKLOAD`, or `BENCH_ADDRESS` to change the run. Set `BENCH_OUTPUT` to write clean JSON to a file. The benchmark sends reads through one local counting proxy and reports latency, throughput, failure, byte, envelope, JSON-RPC item, retry, and concurrency counts.

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

Runtime dependencies are Effect and ethers. Viem, Anvil, PGlite, libSQL, Miniflare, and their type packages are development-only integration-test dependencies. npm is used only by the release workflow for publishing.

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

- [Local state and simulation](https://github.com/0xjimmy/ether-state/issues/9)

See [the release flow](docs/releases.md). Changes go through a PR to `main`; publishing is a separate `main` to `release` step.
