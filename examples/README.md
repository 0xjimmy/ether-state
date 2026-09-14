# Examples

Run these from the repository root after `bun install`. They import the local source, so no build is needed. Installed consumers import from `ether-state` instead.

- [EvmClient](EvmClient/README.md): typed reads, Multicall3, shared block watches, and historical streams.
- [Chainlist utilities](chainlist-utilities/README.md): RPC endpoints, explorers, chain metadata, and errors.

All network examples use real public services. They are examples, not tests. Availability, rate limits, and historical data support vary by endpoint. The finite examples have timeouts; stop watchers with Ctrl+C.

`bun run check` checks the types and lint of all examples, then runs unit and live RPC tests. It does not execute the example scripts. Examples are not included in the package.
