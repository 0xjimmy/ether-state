# Indexer

`base-blocks.ts` creates one EvmClient for Base, indexes the latest three blocks into an in-memory PGlite database, and then follows live head and reconciliation signals.

```sh
BASE_RPC_HTTP_URL=https://your-base-rpc.example bun examples/indexer/base-blocks.ts
```

Stop the script after it prints three checkpoints. Replace the in-memory PGlite object with a filesystem or browser-backed PGlite object to persist the checkpoint.
