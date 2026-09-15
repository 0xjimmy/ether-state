# Indexer

`base-blocks.ts` creates one EvmClient for Base, indexes the latest three blocks into an in-memory PGlite database, and then follows live head and reconciliation signals.

```sh
BASE_RPC_HTTP_URL=https://your-base-rpc.example bun examples/indexer/base-blocks.ts
```

Stop the script after it prints three checkpoints. Replace the in-memory PGlite object with a filesystem or browser-backed PGlite object to persist the checkpoint.

## Transfer and V3 event examples

Run `events.ts transfers` for ERC-20 transfers, or `events.ts v3` for V3 pool events. Both use Ethereum by default. Set `RPC_HTTP_URL` and `CHAIN_ID` to use another chain. `START_BLOCK` is required and is inclusive.

Index USDC transfers to or from a user:

```sh
START_BLOCK=20000000 END_BLOCK=20000010 \
TOKEN=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 \
USER_ADDRESS=0xYourUserAddress \
bun examples/indexer/events.ts transfers
```

Replace the user address. Omit `USER_ADDRESS` to select all users. Omit `TOKEN` to select all contracts with the ERC-20 Transfer event layout. Use `DIRECTION=from` or `DIRECTION=to` for one direction. The default is `both`. A self-transfer produces one row.

RPC topic filters use `null` as a wildcard. The incoming filter is `[Transfer, null, user]`. The outgoing filter is `[Transfer, user]`. Each topic position is an AND condition, so `[Transfer, user, user]` selects only self-transfers. For `both`, this example fetches Transfer events and checks either address in the transform. This can fetch many events if you omit `TOKEN`. ERC-721 Transfer events have a different layout and are excluded. A matching signature alone does not prove that a contract is a valid token.

Index swaps, added liquidity, removed liquidity, and collections for one pool:

```sh
START_BLOCK=20000000 END_BLOCK=20000020 \
POOLS=0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640 \
bun examples/indexer/events.ts v3
```

Use comma-separated `POOLS` for several pools. Use `EVENTS=swaps` or `EVENTS=liquidity` to select one group. The default is `all`, which selects Swap, Mint, Burn, and Collect. This does not include Flash or pool administration events.

Omit `POOLS` to match these event signatures across all contracts. This includes compatible forks and contracts that emit the same signatures. It does not verify Uniswap factory membership. To restrict indexing to official Uniswap pools, supply verified pool addresses. Automatic factory discovery is not part of this example.

The event fields follow the [Uniswap V3 pool interface](https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolEvents.sol). Amounts are decimal strings in raw token units. Swap amounts are signed changes to pool balances. Mint and Burn amounts measure liquidity. Collect records tokens collected and must not count as another liquidity removal. Pool position owners can be position manager contracts. These events do not identify the NFT owner by themselves.

### Follow new blocks and resume

Omit `END_BLOCK` to continue with live indexing. The example stays two blocks behind the head. Set `INDEX_DB=./event-index-data` to keep the database on disk. Stop with Ctrl+C. Run again with the same filters and start block to resume. Use a separate database for each chain. Run one process per index and database.

With `END_BLOCK`, the script indexes that inclusive range, prints the stored rows, and exits. The explicit end block overrides the two-block confirmation policy. Use a historical end block for a repeatable check. Without `INDEX_DB`, data stays in memory for that run only.

The tables store individual events and block metadata. They do not calculate current balances, current liquidity, or fees earned. A start block after a position was created provides only changes from that point.
