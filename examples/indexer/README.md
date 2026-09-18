# Indexer examples

Run each file from the repository root after `bun install`. No settings are required. Each example gives EvmClient a chain ID. The client selects RPC endpoints and estimates the block time.

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

Event watchers stay two blocks behind the head. An explicit `END_BLOCK` overrides this policy. Public endpoints must support the selected historical range. All watchers stop with Ctrl+C.

The old `events.ts transfers` and `events.ts v3` commands still select the corresponding script. `event-index.ts` is the shared index definition. `storage-types.ts` is a type-check fixture, not a runnable example.
