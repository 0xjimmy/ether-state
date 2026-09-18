import { PGlite } from "@electric-sql/pglite"
import { Effect, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { EvmClient } from "../../src/index.js"
import { defineIndex, Indexer } from "../../src/indexer.js"
import { pgliteStore } from "../../src/indexer-pglite.js"

const program = Effect.scoped(Effect.gen(function* () {
	const database = new PGlite()
	yield* Effect.addFinalizer(() => Effect.promise(() => database.close()))
	const client = yield* EvmClient.make({
		network: { chainId: BigInt(process.env["CHAIN_ID"] ?? "8453") },
	})
	const head = yield* client.getBlock()
	const index = defineIndex({
		id: "base-blocks",
		version: 1,
		startBlock: process.env["START_BLOCK"] === undefined
			? head.number > 2n ? head.number - 2n : 0n
			: BigInt(process.env["START_BLOCK"]),
		finality: { mode: "latest" },
		source: {},
		valueSchema: Schema.Struct({ hash: Schema.String, transactionCount: Schema.Number }),
		transform: (bundle) => Effect.succeed([{
			key: "block",
			value: { hash: bundle.block.hash, transactionCount: bundle.block.transactions.length },
		}]),
	})
	const store = yield* pgliteStore(database)
	const indexer = yield* Indexer.make({ client, index, store })
	console.log("Watching blocks. Press Ctrl+C to stop.")
	const end = process.env["END_BLOCK"]
	if (end !== undefined) {
		const toBlock = BigInt(end)
		if (toBlock < index.startBlock) throw new Error("END_BLOCK must be at or after START_BLOCK")
		console.log("Indexed through", yield* indexer.sync(toBlock))
		return
	}
	yield* indexer.run().pipe(
		Stream.runForEach((checkpoint) => Effect.log("Indexed block", checkpoint)),
	)
}))

await Effect.runPromise(program.pipe(
	Effect.provide(FetchHttpClient.layer),
	Effect.provide(Socket.layerWebSocketConstructorGlobal),
))
