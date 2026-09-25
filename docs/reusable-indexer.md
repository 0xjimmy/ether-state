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
    history: { from: deploymentBlock, direction: "backward", batchSize: 256 },
	retention: { seconds: 86_400n },
  },
})

yield* instance.run()
```

### Runtime history batches

Use `history.batch` to select request ranges in minutes or blocks. A callback is
read once before each request window. It can read a signal or a controller's
current settings without restarting the index.

```ts
let minutes = 1
let concurrency = 2

const history = {
  from: deploymentBlock,
  direction: "backward" as const,
  batch: () => ({
    unit: "minutes" as const,
    size: minutes,
    bufferSeconds: 15,
    concurrency,
  }),
}

// Subsequent request windows use these settings.
minutes = 2
concurrency = 3
```

A minute batch uses `ceil((size * 60 + bufferSeconds) * 1000 / blockTime)`
blocks. `blockTime` is the client's resolved network estimate in milliseconds.
The default buffer is 15 seconds. This is an estimated fetch duration; partition
boundaries still use block timestamps. The buffer does not cause overlapping
ranges. For block ranges, use `{ unit: "blocks", size: 750, concurrency: 2 }`.

Concurrency defaults to 1 and must be an integer from 1 to 16. Each request must
cover 1 to 100,000 blocks. One window schedules up to `concurrency` contiguous
requests from the next coverage gap. Results are processed in the selected
direction. Each block's events remain together. In-flight requests keep their
original settings. Provider limits can split a request into smaller pages.

A callback can implement application-specific adaptation. The indexer does not
increase concurrency or duration automatically. Invalid callback values or
callback failures produce a definition-stage error before the next window is
requested. Fixed settings are validated during instance creation. The existing
`batchSize` option remains supported, but it cannot be combined with `batch`.
Neither option changes live subscriptions, projection schemas, or fee processing.

An instance identity contains the definition name, version, chain ID, normalized parameters, and an optional namespace. Address strings are normalized for identity. Bump the definition version when source or reducer semantics change. Different versions keep separate data; this API does not migrate old data.

Omit the store to use a private memory store. Pass `memoryModelStore()` to share a memory store across instance restarts in one process. `pgliteModelStore` persists blocks, projection values, and resolved origins. One PGlite connection enforces one writer per instance. Applications that open the same browser database from multiple tabs must use one database owner. The companion app uses a SharedWorker to own PGlite and share each pool tracker across tabs. IndexedDB persistence works over HTTP without Web Locks. Tabs exchange updates with the worker; they do not open separate PGlite connections. If SharedWorker is unavailable, the app uses a Web Lock for persistent storage. It uses session memory only when neither ownership mechanism is available.

Without `plan.retention`, storage retains collected history. Retention accepts `blocks`, `seconds`, or both. The runtime keeps the wider range when both apply. It also keeps the preceding source boundary block and at least 128 recent blocks for reorg recovery. `everyBlocks` controls periodic live pruning and defaults to 64. Retention runs at startup and on a scoped maintenance timer. Boundary lookups run outside the commit lock; only the storage changes use the serialized writer lane. Each store adapter removes older source batches and completed partition rows.

## Select coverage and resume behavior

- `live.start: "head"` seeds fresh current state and follows new blocks immediately.
- `live.start: "checkpoint"` restores a canonical stored state and applies missing blocks before it reaches head.
- `history.from: bigint` defines an inclusive requested lower bound.
- `history.from: "origin"` calls the definition's origin resolver and persists its verified block reference.
- `history.through: bigint` defines an inclusive upper bound. A history-only job captures head at startup. A live job with no explicit bound starts history through its startup head immediately. Later boundaries extend that bound. Historical closed periods can publish before the first live boundary; the startup open period stays hidden until it closes with complete coverage.
- `history.direction` defaults to `"backward"`. It fills the newest missing range first. `"forward"` fills the oldest missing range first.
- `history.batchSize` defaults to 256 and accepts 1 through 100,000 blocks. It controls the missing log-query range. Each provider response is processed and committed in bounded groups of event blocks and boundary headers. Provider range, response-size, and timeout limits cause the log query to split.
- `history.maxLiveLagBlocks` is optional. When set, the history worker pauses before another batch when observed head exceeds applied progress by more than this limit. By default, history remains independent so fast chains cannot starve backfill.
- `retention.blocks` limits history and storage by recent block count. The preceding block remains available to prove a partition boundary.
- `retention.seconds` limits history and storage by block timestamp. The runtime resolves the boundary with canonical block reads.
- `retention.everyBlocks` defaults to 64 and controls periodic pruning during live ingestion.
- `retention.everySeconds` defaults to 60. Periodic pruning requires both the block and time intervals. Timestamp-boundary lookup runs in a maintenance lane and does not hold the live commit lock.

Live ingestion and historical fetches run independently. A short commit lock serializes storage and projection writes. Backfill does not cancel an in-flight batch when head advances. It is cooperative scheduling, not a reserved RPC priority queue.

Historical collection sends one log-range request for the selected history window. Provider range limits split that request automatically. Backward history yields the newest split first. Each result is processed and committed in groups of at most 62 event blocks plus two range boundaries. Header reads use concurrency eight. Source capture uses concurrency four and returns each group in canonical block order. A later page failure preserves completed coverage.

Historical storage records the scanned block range separately from source batches. It reads and stores headers only for event blocks and range boundaries. This data proves empty partitions and reorg boundaries without one header request per empty block. Live capture remains dense. It uses concurrency four in groups of up to 32 blocks, then commits the group in canonical order. Source decoders must not depend on mutable cross-block execution order. Block-pinned reads and per-block caches are safe.

Historical decoders also receive `SourceCaptureContext.range`, with the group's `from` and `through` headers and ordered logs filtered for that source. A decoder can share one replay keyed by those boundary hashes, then return each event's result to its block capture. This avoids repeating starting-state reads for every block. Live capture omits `range`.

Coverage advances only after an atomic block and projection commit. Disjoint coverage survives restarts. With backward history, recent restart gaps take priority over older backfill. Creation resolution runs before historical collection; live ingestion continues during that lookup. Explicit block bounds can bypass discovery.

A transient source error leaves coverage unchanged and reports a blocked history lane before another attempt. Origin, schema, or reducer failures leave history blocked for inspection and restart. A finite history job returns its error. Live processing retries source failures three times; exhausted or permanent failures set live status to failed and fail the run Effect. EvmClient owns endpoint rotation and per-request hedging.

## Observe values and progress

```ts
instance.watch("current")
instance.watch("minutes")
instance.read("minutes")
instance.watchStatus()
instance.watchSource(source)
instance.watchLogs(source)
```

Projection names and values are inferred from the definition. `read` returns durable rows plus the instance's current memory-only partition rows. `watch` reports every projection replacement and reset notification to each active subscriber. Source subscriptions accept a source handle whose name and filter match the instance. They report every committed apply batch and revert to each active subscriber. The event feeds use non-lossy per-subscriber queues. Backfill source batches can arrive in reverse windows; events inside each batch remain ordered.

`watchLogs` is the low-latency live path. It reports filtered canonical logs before source decoding, projection work, and durable commit finish. It runs independently from slow source capture. Its updates are provisional and at least once. Consumers must deduplicate log identities and apply every `revert` before they use the replacement branch. Use `watchSource` when the consumer needs committed, decoded source values.

A projection update contains its key, value, block reference, period, and coverage. A reset has a null value. Consumers must clear cached values on reset. The runtime republishes retained rows after a reset.

`period: "open"` describes a time window that started after this run observed its first boundary. Open rows stay in instance memory and remain available through `read` and `watch`. The runtime does not publish the period that was open at startup. Historical backfill runs immediately. At the next boundary, the startup period can close from the already scanned history and captured live events; any missing portion remains a gap for backfill. The store and public views contain a closed partition only when its source coverage is complete. Startup removes legacy open or partial rows and rebuilds missing complete rows from retained source batches. Scanned coverage between timestamp anchors also identifies complete empty periods. Empty candles have null OHLC values; this example does not carry forward the previous close.

Closed periods are not necessarily finalized. This API currently follows latest head and does not attach finalized candle status.

## Recover a reorg

The runtime verifies stored coverage on restart and detects parent-hash conflicts during live application. It searches up to 128 recent block heights for a canonical ancestor. It invalidates orphaned blocks and affected projection rows, reseeds current state, and repairs missing history. A historical window fetched before a reorg cannot commit afterward. Reorgs beyond the recovery window fail explicitly.

## Scope of this implementation

The reusable API currently supports log sources, block-pinned state bootstrap, state reducers, and time partitions. Periodic call sources, every-N-block sampling, arbitrary partition keys, and additional database adapters are not part of this implementation. The existing atomic Indexer still supports block bundles with calls, transactions, and receipts.

The pool example tracks current price, active tick, and active liquidity. The app retains its existing nearby-tick depth tracker and slot0 confirmation path alongside the new instance. Both share EvmClient's log feed. Candle prices use square-root Q96 values internally; the app converts them to token1 per token0 with token decimals.


## Upstream-specific capabilities

Archive state and log range support vary by endpoint. A failed request is not a chain-wide capability result. EvmClient rotates historical capability errors, including `unsupported block number`, without disabling current reads. Learned unfiltered-range restrictions apply only to unfiltered range requests.

The pool origin resolver first attempts archive-state binary search through EvmClient. It verifies the factory creation event at the resulting block. If that path fails, it scans filtered factory logs. Only explicit range-size errors reduce the window; rate limits and transport failures do not. All attempts remain subject to the client's bounded request policy. The client does not yet retain a full per-method archive-depth map.

Backfill streams range queries and reads headers for event blocks and range boundaries. It does not fetch every empty block. Source decoders can still perform extra reads; exact pool fee replay is one example. Historical throughput therefore depends on the source decoder and provider latency as well as log-query size. The existing benchmarks do not measure completion of a pool's entire lifetime.

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


## Shared live chain acquisition

`EvmClient.watchChain()` emits complete block applications and canonical reverts.
An apply includes full transactions and ordered logs. It includes receipts when
the provider supports block receipt requests; otherwise `receipts` is null. A revert includes
its first invalid height and the retained canonical ancestor. Fetches can run
concurrently, but applications stay ordered. Missing data retries in the shared
chain worker before it publishes later blocks.

Live log filters and transaction filters run locally over this stream. The
`watchFilteredLogBlocks` method is a compatibility alias for `watchLogBlocks`.
It does not make filtered live RPC requests. Full-block watchers also wait for
receipts. Raw `watchBlocks()` still reports observed heads before acquisition is
complete. Use the difference between observed and applied heights to measure lag.

The client retains 128 complete blocks for canonical recovery and matching block
and receipt reads. Providers without `eth_getBlockReceipts` use one unfiltered `eth_getLogs`
request for the block. Live acquisition never expands into individual receipt
requests. Explicit historical receipt queries keep their own fallback. Retries, head discovery, historical reads, and contract calls remain
additional RPC work. Subscriber count does not multiply live block acquisition.

Models consume shared reverts and roll back their persisted branch. They report a
live stall when the head is ahead and their applied block stops advancing for
three seconds. History errors remain separate from live progress.

Viem head and log subscriptions use the same complete stream. Log subscriptions
emit removed logs after a shared revert. They do not query live logs separately.

## PostgreSQL model storage

`ether-state/indexer/postgres` exports `postgresModelStore(database)`. Supply
`query(sql, parameters)` and `transaction(callback)` methods. A query returns
`{ rows }`. The transaction callback must use one connection and roll back on
failure. Bind parameters; do not interpolate them into SQL. Configure finite
statement and lock timeouts in the driver.

The adapter uses the same `ether_model_blocks`, `ether_model_rows`, and
`ether_model_coverage` tables as the PGlite model store. The caller creates the
schema explicitly before opening the adapter. Opening a Postgres model store
performs no DDL or legacy coverage conversion. The PGlite wrapper retains its
existing initialization behavior.

Stores using the same database object share writer claims and serialize mutations
for each model identity. The caller must also enforce ownership across processes,
for example with a database advisory lock held for the backend lifetime. An
in-memory claim does not replace that lock. Stop work if ownership is lost.

The indexer still accepts any implementation of `ModelStore`; this adapter does
not require other storage implementations to use PostgreSQL or SQL.
