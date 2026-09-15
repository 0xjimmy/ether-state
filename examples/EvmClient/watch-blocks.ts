import { Effect, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { EvmClient } from "../../src/index.js"

const program = Effect.scoped(Effect.gen(function* () {
	const client = yield* EvmClient.make({ network: { chainId: BigInt(process.env["CHAIN_ID"] ?? "8453") } })
	console.log("Watching blocks. Press Ctrl+C to stop.", { chainId: client.config.network.chainId })
	yield* client.watchBlocks({ full: true, logs: true }).pipe(Stream.runForEach((head) => Effect.sync(() => {
		console.log({
			number: head.number,
			hash: head.hash,
			gasUsed: head.block.gasUsed,
			transactions: head.block.transactions.length,
			logs: head.logs.length,
			timestamp: head.timestamp,
			latencyMs: head.latencyMs,
		})
	})))
}))

await Effect.runPromise(program.pipe(
	Effect.provide(FetchHttpClient.layer),
	Effect.provide(Socket.layerWebSocketConstructorGlobal),
))
