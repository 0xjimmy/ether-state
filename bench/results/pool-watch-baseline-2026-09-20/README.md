# Pool watch baseline before reusable Indexer definitions

These measurements use the request-policy fixes committed with this report. The app uses the sibling ether-state checkout.

Run from library-tests:

```sh
TRACE_CHAIN=robinhood TRACE_DURATION_MS=60000 bun run trace:pools
TRACE_CHAIN=base TRACE_DURATION_MS=60000 bun run trace:pools
```

The JSON summaries include endpoints, pool addresses, startup time, applied log batch counts, gap counts, lag samples, HTTP timings, errors, and request metrics. Raw traces remain in the app's `.data/traces` directory. Lag is measured against an independent endpoint head every five seconds. WebSocket requests are excluded from HTTP envelope counts.

The Robinhood run overlapped the library validation suite. Treat it as an observed baseline, not an isolated throughput comparison. The earlier isolated three-minute run processed 1807 log batches with no gaps or app errors, median lag five blocks, and maximum lag eight blocks. Its source manifest is included for reference.

These short public-endpoint measurements do not establish an upper latency bound. Compare block coverage and errors as well as latency when evaluating the new Indexer.
