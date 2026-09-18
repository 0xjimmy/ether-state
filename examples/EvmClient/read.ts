import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { EvmClient } from "../../src/index.js"

const program = Effect.gen(function* () {
	const client = yield* EvmClient.make({
		endpoints: { http: ["https://ethereum-rpc.publicnode.com"], ws: [] },
		network: { chainId: 1n, blockTime: 12_000 },
	})
	const head = yield* client.getBlock()
	const chainId = yield* client.fetch({ method: "eth_chainId", params: [] })
	const results = yield* Effect.all(["0x18160ddd", "0x313ce567"].map(data =>
		Effect.exit(client.call({ transaction: { to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", data }, block: head.number }))),
		{ concurrency: "unbounded" })
	console.log({ chainId, block: head.number, results, metrics: client.metrics })
})

await Effect.runPromise(Effect.scoped(program).pipe(
	Effect.provide(FetchHttpClient.layer), Effect.provide(Socket.layerWebSocketConstructorGlobal), Effect.timeout(60_000)))
