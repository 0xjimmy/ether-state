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
	const endpoint = process.env["BASE_RPC_HTTP_URL"]
	const client = yield* EvmClient.make({
		...(endpoint === undefined ? {} : { endpoints: { http: [endpoint], ws: [] } }),
		network: { chainId: 8453n, blockTime: 2_000 },
	})
	const head = yield* client.getBlock()
	const index = defineIndex({
		id: "base-blocks",
		version: 1,
		startBlock: head.number > 2n ? head.number - 2n : 0n,
		finality: { mode: "latest" },
		source: { transactions: true },
		valueSchema: Schema.Struct({ hash: Schema.String, transactionCount: Schema.Number }),
		transform: (bundle) => Effect.succeed([{
			key: "block",
			value: { hash: bundle.block.hash, transactionCount: bundle.transactions.length },
		}]),
	})
	const store = yield* pgliteStore(database)
	const indexer = yield* Indexer.make({ client, index, store })
	yield* indexer.run().pipe(
		Stream.take(3),
		Stream.runForEach((checkpoint) => Effect.log("Indexed Base", checkpoint)),
	)
}))

await Effect.runPromise(program.pipe(
	Effect.provide(FetchHttpClient.layer),
	Effect.provide(Socket.layerWebSocketConstructorGlobal),
))
