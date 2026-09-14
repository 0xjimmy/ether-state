# EvmClient examples

EvmClient manages endpoint selection, typed RPC calls, batching, cached reads, and shared watches. `EvmClient.make` is an Effect. Run it inside `Effect.scoped` so the client can close its connections and background tasks.

## Typed reads and batches

[read.ts](read.ts) fetches the chain ID and block, then reads USDC total supply and decimals at the same block. Results are raw ABI-encoded hex. `Effect.exit` keeps each success or error as a value.

```sh
bun examples/EvmClient/read.ts
```

`client.fetch({ method, params })` infers RPC input and output types. Compatible concurrent `client.call` reads can use Multicall3. The default batch window is 100 ms. Calls with sender or value context use direct reads; set `multicall: false` to force a direct read. Multicall changes the caller seen by the contract, so use direct reads when that matters.

## Shared block watches

[watch-blocks.ts](watch-blocks.ts) preserves the original live script. It watches Ethereum and chain 4663, prints block latency, and shares Ethereum data between number-only and full-block consumers.

```sh
bun examples/EvmClient/watch-blocks.ts
```

`watchBlocks()` gives block metadata. `{ full: true }` includes transactions. `{ full: true, logs: true }` also requests receipts and exposes their logs. Extra data can require extra RPC calls; subscribers reuse the fetched data. `watchLogs` filters that shared log data, and `watchTransactions` filters full transactions.

The second chain is configurable in the script. Change it to Base, `8453n`, to enable its USDC transfer formatter. That formatter reads the existing block logs and makes no RPC calls. `latencyMs` is local receive time minus block timestamp, not HTTP round-trip time.

`watchCall` reads a contract on new blocks. `watchState` exposes Loading, Ready, and Retrying state through a SubscriptionRef. These features still need broader recovery tests; reorg handling is not complete.

## Historical data

[history.ts](history.ts) collects three recent blocks and streams USDC log pages in block order.

```sh
bun examples/EvmClient/history.ts
```

Use `getBlocks`, `getLogs`, `getTransactions`, or `getReceipts` for collected results. Streaming variants emit data as it becomes available. Log ranges split on supported range-limit or timeout errors. Permanent failures remain errors; endpoint limits and archive support are not fully learned yet.

## Defaults and setup

`EvmClient.make({ network: { chainId: 1n } })` discovers endpoints from Chainlist and estimates block time from 32 blocks. Provide `endpoints` and a millisecond `blockTime` to skip those steps. Examples provide HTTP and WebSocket services through Effect layers.
