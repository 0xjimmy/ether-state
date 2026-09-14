import { Effect, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { EvmClient } from "../../src/index.js"

const program = Effect.gen(function* () {
	const client = yield* EvmClient.make({
		endpoints: { http: ["https://ethereum-rpc.publicnode.com"], ws: [] },
		network: { chainId: 1n, blockTime: 12_000 },
	})
	const head = yield* client.getBlock()
	const range = { fromBlock: head.number - 10n, toBlock: head.number - 8n, concurrency: 2 }
	const blocks = yield* client.history.getBlocks(range)
	console.log("blocks", blocks.map(block => block.number))
	yield* client.history.streamLogPages({ ...range, chunkSize: 1n,
		filter: { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
	}).pipe(Stream.runForEach(page => Effect.sync(() => { console.log({ from: page.fromBlock, to: page.toBlock, logs: page.logs.length }) })))
})

await Effect.runPromise(Effect.scoped(program).pipe(
	Effect.provide(FetchHttpClient.layer), Effect.provide(Socket.layerWebSocketConstructorGlobal), Effect.timeout(60_000)))
