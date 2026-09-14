# Chainlist utilities

[discover.ts](discover.ts) finds Base RPC endpoints and explorers, reads its metadata, and shows an unknown-chain error.

```sh
bun examples/chainlist-utilities/discover.ts
```

- `getChainList()` returns the parsed Chainlist dataset.
- `getChain(chainId)` returns one chain and its metadata.
- `getRpcEndpoints(chainId)` returns `{ http, ws }` with duplicates and unusable URL templates removed.
- `getExplorers(chainId)` returns explorer records. An empty list is valid.

Use bigint chain IDs, such as `1n` or `8453n`. Each helper returns an Effect and needs an HTTP client layer. The first successful download of `rpcs.json` is cached for the runtime; failed downloads are not retained. These helpers discover URLs, but do not test endpoint health or validate the remote chain ID. EvmClient performs that validation during setup.

Errors are `ChainListUnavailable`, `ChainNotFound`, or `NoRpcEndpoints`, depending on the method. Use `Effect.exit` to inspect them or Effect error handlers to recover.
