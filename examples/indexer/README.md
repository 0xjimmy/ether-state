# Indexer examples

Run the commands below from the repository root after `bun install` and `bun run build`. The default commands need no settings. Definition and type-check files are not standalone programs. Each example gives EvmClient a chain ID. The client selects RPC endpoints and estimates the block time.

## Watch blocks

```sh
bun examples/indexer/base-blocks.ts
```

Starts two blocks before the Base head, stores block hashes and transaction counts in an in-memory PGlite database, and follows new blocks. It prints each checkpoint. Stop with Ctrl+C.

For a block stream without storage, run `bun examples/EvmClient/watch-blocks.ts`.

## ERC-20 transfers and metadata

```sh
bun examples/indexer/erc20-transfers.ts
```

Starts four blocks before the Ethereum head and follows transfers across all token addresses. For each new address, it attempts `name`, `symbol`, and `decimals` calls. It caches the result, then stores and prints the transfers. Calls run in small concurrent groups.

There are two data tables:

- `ether_state_rows` stores transfers with their transaction hash, log index, and block hash.
- `erc20_metadata` stores one metadata result per chain and token address.

The store also maintains internal block and checkpoint tables. PGlite runs in memory by default. Set `INDEX_DB=./erc20-data` to keep data on disk. With the same filters, the script reads the stored start block and resumes from its checkpoint. Use a separate database for each chain and run one writer per index.

Metadata is a first-observed cache from the latest state. It is not historical token state. Missing methods, invalid results, and failed calls become `NULL` fields. The cache keeps these failed attempts too, so repeated transfers do not repeat the calls. Delete a token's cache row to try again. Metadata can change after the first read. A reorg removes orphaned transfers but keeps this cache.

ERC-721 Transfer logs are excluded by their different topic layout. An ERC-20-shaped log does not prove that the contract is a valid token. Amounts stay as decimal strings in raw token units.

## Uniswap V3 pool events

```sh
bun examples/indexer/uniswap-v3.ts
```

Starts four blocks before the Ethereum head. One index selects all nine V3 pool event types: Initialize, Mint, Burn, Collect, Swap, Flash, IncreaseObservationCardinalityNext, SetFeeProtocol, and CollectProtocol.

The callback store prints each event to the console. It keeps only the checkpoint and the last 128 block records in memory. It prints `Revert` with orphaned block hashes when the index detects a reorg. Console output is not durable storage.

Mint adds liquidity. Burn removes liquidity. Collect withdraws tokens. Swap amounts are signed changes to pool balances. The output shows each token moving in or out of the pool. A buy or sale depends on which token you select as the base asset. V3 has no Sync event. See the [official V3 pool event interface](https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolEvents.sol).

By default, the index matches these signatures across all contracts, including compatible forks. It does not check Uniswap factory membership. Set `POOLS` to comma-separated verified pool addresses to restrict the stream.

## Optional settings

| Setting | Effect |
| --- | --- |
| `CHAIN_ID` | Select another chain. Block examples default to Base, `8453`. Event examples default to Ethereum, `1`. |
| `START_BLOCK` | Select the first block, inclusive. Otherwise, use recent blocks or the stored ERC-20 checkpoint. |
| `END_BLOCK` | Index through this block, inclusive, then exit. Otherwise, follow new blocks. |
| `TOKEN` | Select one ERC-20 contract. |
| `USER_ADDRESS` | Select ERC-20 transfers to or from this address. |
| `DIRECTION` | Select `both`, `from`, or `to`. Applies with `USER_ADDRESS`. The default is `both`. |
| `INDEX_DB` | Keep the ERC-20 PGlite database at this path. |
| `POOLS` | Select V3 pool addresses, separated by commas. |

For example, a finite transfer run:

```sh
START_BLOCK=20000000 END_BLOCK=20000002 \
TOKEN=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 \
bun examples/indexer/erc20-transfers.ts
```

The legacy ERC-20 and V3 event watchers stay two blocks behind the head. An explicit `END_BLOCK` overrides this policy. Public endpoints must support the selected historical range. All watchers stop with Ctrl+C.

The old `events.ts transfers` and `events.ts v3` commands still select the corresponding script. `event-index.ts` is the shared index definition. `storage-types.ts` is a type-check fixture, not a runnable example.

## Reusable pool definition with live candles and backfill

```sh
CHAIN_ID=8453 POOL=0x6c561B446416E1A00E8E93E221854d6eA4171372 \
INDEX_DB=./pool-history bun examples/indexer/pool-live-history.ts
```

`PoolIndex` in `pool-definition.ts` is reusable. Each `.make` call binds a pool address, chain client, store, and plan. It tracks price, active tick, and active liquidity. It builds one-minute OHLC candles and absolute token volumes from swaps. Prices remain square-root Q96 values and volumes remain raw token units.

The default plan starts live immediately, locates the factory creation event, repairs recent gaps, and fills older history backward. Set `START_BLOCK` to use a known lower bound instead of creation discovery. Reopen the same database to resume coverage. A separate namespace creates an independent copy.

Open candles update with live swaps. Empty blocks close old periods. Closed candles remain provisional with respect to reorgs. Partial coverage is reported separately from the period state. The example includes no automated trading or transaction submission.

See [reusable Indexer semantics](../../docs/reusable-indexer.md) for storage, recovery, and current limits.

## Live memory tracking and explicit close

```sh
bun examples/indexer/pool-live.ts
```

Creates two independent instances from `PoolIndex` on one client. It prints current state for ten seconds, then closes both instances and the client. Closing the first instance leaves the second instance and client open. Each instance uses private memory storage. No historical job runs.

## Finite forward history

```sh
bun examples/indexer/pool-forward.ts
```

Indexes the latest 21 blocks into memory, prints candles and coverage, then exits. Set `START_BLOCK` and `END_BLOCK` for another inclusive range. A range that starts after pool creation can produce partial candles. The current-state projection still seeds at startup head; only the candle history follows the requested range.

## Create your own definition

Start with `pool-definition.ts`. Its format has four parts:

1. `name` and `version` identify the stored model.
2. `params` is an Effect schema for instance parameters.
3. `build` creates log sources and returns named projections. A state projection has `seed` and `reduce` callbacks. A time projection has `intervalSeconds` and `rebuild`.
4. The optional `origin` callback resolves the lower bound for `history.from: "origin"`.

Call `YourDefinition.make({ client, params, plan, store })` inside an Effect scope. Omit `store` for private memory storage. Use `namespace` for separate copies with the same parameters. Call `run()` to start work. Fork that Effect with `Effect.forkScoped` when other work must run at the same time.

Use `watch("current")` or `watch("candles")` for changes and `read("candles")` for stored rows. Projection names follow the object returned by `build`. TypeScript checks names and output values. `model-types.ts` checks that contract during `bun run typecheck`.

The three reusable pool programs use `run-example.ts` for SIGINT and SIGTERM cleanup. Ctrl+C interrupts workers and waits for database and client finalizers. `close()` stops one resource early. Scope exit remains the default cleanup path.
