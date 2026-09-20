# Reusable Indexer definitions

`Indexer.define` creates a reusable definition. `Definition.make` creates an instance with validated parameters, a client, storage, and an execution plan. Defining an index performs no I/O. Creating an instance does not start a worker. `instance.run()` starts one scoped writer.

The existing `defineIndex`, `Indexer.make`, `sync`, and `run` interface remains supported.

## Define sources and projections

```ts
const Counter = Indexer.define({
  name: "counter",
  version: 1,
  params: Schema.Struct({ address: Schema.String }),
  build: ({ params }) => {
    const events = Source.logs({
      name: "events",
      filter: { address: params.address },
      schema: EventSchema,
      decode: decodeEvent,
    })
    return {
      current: Projection.state({
        source: events,
        schema: StateSchema,
        seed: ({ read, block }) => readInitialState(read, block),
        reduce: ({ state, events, block }) => reduceEvents(state, events, block),
      }),
      minutes: Projection.partitioned({
        source: events,
        schema: MinuteSchema,
        intervalSeconds: 60n,
        rebuild: ({ events, block }) => buildMinute(events, block),
      }),
    }
  },
})
```

The schema and callback names above are application definitions. The runnable pool definition is in `examples/indexer/pool-definition.ts`.

`Source.logs` validates and encodes decoded events with an Effect schema. The runtime checks log block identities and orders logs by log index. Each block is a complete source batch, including empty matches. A source name must refer to one source object within a definition.

State projections seed at a selected block. The supplied `read` function pins contract calls to that block hash. State reducers apply subsequent blocks in order. Historical batches do not change current state.

Partitioned projections receive canonical events in block and log order. Each event includes its block. Backfill rebuilds affected partitions from stored events. A retry replaces a block and its derived values; it does not add the same volume again. Use pure reducers. External side effects are not transactional with the store.

## Create independent instances

```ts
const instance = yield* Counter.make({
  params: { address },
  client,
  store: yield* pgliteModelStore(database),
  plan: {
    live: { start: "head" },
    history: { from: deploymentBlock, direction: "backward", batchSize: 8 },
  },
})

yield* instance.run()
```

An instance identity contains the definition name, version, chain ID, normalized parameters, and an optional namespace. Address strings are normalized for identity. Bump the definition version when source or reducer semantics change. Different versions keep separate data; this API does not migrate old data.

Omit the store to use a private memory store. Pass `memoryModelStore()` to share a memory store across instance restarts in one process. `pgliteModelStore` persists blocks, projection values, and resolved origins. One PGlite connection enforces one writer per instance. Applications that open the same browser database from multiple tabs must use one database owner. The companion app uses a Web Lock and falls back to session memory when Web Locks are unavailable. IndexedDB itself can work over HTTP. Web Locks requires a secure context, so the app guard is stricter than IndexedDB. An alternative owner protocol is needed to enable safe shared persistence on plain HTTP.

Storage retains collected history. There is no automatic pruning or retention policy in this version.

## Select coverage and resume behavior

- `live.start: "head"` seeds fresh current state and follows new blocks immediately.
- `live.start: "checkpoint"` restores a canonical stored state and applies missing blocks before it reaches head.
- `history.from: bigint` defines an inclusive requested lower bound.
- `history.from: "origin"` calls the definition's origin resolver and persists its verified block reference.
- `history.through: bigint` defines an inclusive upper bound. Without it, a live job fills through its applied block. A history-only job captures head at startup.
- `history.direction` defaults to `"backward"`. It fills the newest missing range first. `"forward"` fills the oldest missing range first.
- `history.batchSize` defaults to 16 and accepts 1 through 256 blocks. Historical RPC concurrency is two.
- `history.maxLiveLagBlocks` defaults to eight. The history worker pauses before another batch when observed head exceeds applied progress by more than this limit.

Live ingestion and historical fetches run independently. A short commit lock serializes storage and projection writes. Backfill does not cancel an in-flight batch when head advances. It is cooperative scheduling, not a reserved RPC priority queue.

Coverage advances only after an atomic block and projection commit. Disjoint coverage survives restarts. With backward history, recent restart gaps take priority over older backfill. Creation resolution runs before historical collection; live ingestion continues during that lookup. Explicit block bounds can bypass discovery.

A transient source error leaves coverage unchanged and reports a blocked history lane before another attempt. Origin, schema, or reducer failures leave history blocked for inspection and restart. A finite history job returns its error. Live processing retries source failures three times; exhausted or permanent failures set live status to failed and fail the run Effect. EvmClient owns endpoint rotation and per-request hedging.

## Observe values and progress

```ts
instance.watch("current")
instance.watch("minutes")
instance.read("minutes")
instance.watchStatus()
instance.watchSource(source)
```

Projection names and values are inferred from the definition. `read` returns stored rows. `watch` reports committed replacements and reset notifications. Source subscriptions accept a source handle whose name and filter match the instance. They report decoded apply batches and reverts. Backfill source batches can arrive in reverse windows; events inside each batch remain ordered.

A projection update contains its key, value, block reference, period, and coverage. A reset has a null value. Consumers must clear cached values on reset. The runtime republishes retained rows after a reset.

`period: "open"` describes the current time window. `coverage: "complete"` means coverage through the reported progress block, not through future time. A closed period can remain partial. Starting midway through a period does not prove that its earlier events are absent. A verified creation block can establish that lower bound. Empty blocks close periods. Empty candles have null OHLC values; this example does not carry forward the previous close.

Closed periods are not necessarily finalized. This API currently follows latest head and does not attach finalized candle status.

## Recover a reorg

The runtime verifies stored coverage on restart and detects parent-hash conflicts during live application. It searches up to 128 recent block heights for a canonical ancestor. It invalidates orphaned blocks and affected projection rows, reseeds current state, and repairs missing history. A historical window fetched before a reorg cannot commit afterward. Reorgs beyond the recovery window fail explicitly.

## Scope of this implementation

The reusable API currently supports log sources, block-pinned state bootstrap, state reducers, and time partitions. Periodic call sources, every-N-block sampling, arbitrary partition keys, and additional database adapters are not part of this implementation. The existing atomic Indexer still supports block bundles with calls, transactions, and receipts.

The pool example tracks current price, active tick, and active liquidity. The app retains its existing nearby-tick depth tracker and slot0 confirmation path alongside the new instance. Both share EvmClient's log feed. Candle prices use square-root Q96 values internally; the app converts them to token1 per token0 with token decimals.


## Upstream-specific capabilities

Archive state and log range support vary by endpoint. A failed request is not a chain-wide capability result. EvmClient rotates historical capability errors, including `unsupported block number`, without disabling current reads. Learned unfiltered-range restrictions apply only to unfiltered range requests.

The pool origin resolver first attempts archive-state binary search through EvmClient. It verifies the factory creation event at the resulting block. If that path fails, it scans filtered factory logs. Only explicit range-size errors reduce the window; rate limits and transport failures do not. All attempts remain subject to the client's bounded request policy. The client does not yet retain a full per-method archive-depth map.

Backfill currently reads headers and hash-pinned logs per block. It prioritizes live progress over historical throughput. The benchmarks cover a 100-block backfill, not completion of a pool's entire lifetime. Large histories need a later range-fetch optimization before this should be treated as a high-throughput historical indexer.

## Close an instance or client

```ts
yield* instance.run().pipe(Effect.forkScoped)
// Later, stop this instance and wait for its worker finalizers.
yield* instance.close()
// After all users of the shared client have stopped:
yield* client.close()
```

`EvmClient` is the client type. There is no separate `EvmState` class.
Both objects belong to the Effect scope in which `make` runs. Scope exit closes them automatically, including on failure or interruption. Explicit `close()` is idempotent and terminal. `isClosed` becomes true when cleanup starts. Await `close()` to wait for cleanup.

Closing a reusable instance interrupts its run, releases its writer claim, and ends its observation streams. The PGlite adapter waits for active queries and transactions, because its promises cannot be cancelled. Its `status` reports `live: "closed"`. Stored data remains available through `read`, provided the store remains open. Create a new instance to restart. Closing an instance does not close its shared client or database.

Closing a client interrupts requests and polling, stops probes and shared streams, and closes its WebSocket connections. New request Effects are interrupted after close. New observation streams are empty. Cancellation uses Effect interruption, not a retryable RPC error. `watchState` workers stop when either their caller scope or client closes. Close dependent indexers before their shared client.

The older `Indexer.make` API has no separate close method. Its `run` stream owns its work. Interrupt the consuming fiber or close its scope to stop it.

The application owns a supplied database. Acquire it with `Effect.acquireRelease` and close it after its indexers. Garbage collection is not a shutdown mechanism. The pool examples handle SIGINT and SIGTERM through an AbortController, so normal process shutdown runs scoped finalizers. A forced process kill or browser tab termination cannot guarantee finalizer execution.

See [the runnable examples](../examples/indexer/README.md) for live memory tracking, a finite forward job, and persistent live tracking with backward history.

See [the cleanup and tick-window checks](../bench/results/indexer-cleanup-2026-09-20/README.md) for current validation and live traces.

Upstream recovery stays in EvmClient. HTTP failures, response decoding failures, and provider parameter rejections do not stop a logical read before the client tries its recovery policy. Contract reverts and local encoding failures are terminal. An origin resolver receives an upstream failure only after the client exhausts its attempt or time budget. A blocked origin still needs a new run after an unrecoverable failure.
