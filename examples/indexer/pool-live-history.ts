import { Effect, Stream } from "effect"
import { PGlite } from "@electric-sql/pglite"
import { EvmClient } from "ether-state"
import { pgliteModelStore } from "ether-state/indexer/pglite"
import { PoolIndex } from "./pool-definition.js"
import { runExample } from "./run-example.js"

const program = Effect.scoped(Effect.gen(function* () {
	const client = yield* EvmClient.make({ network: { chainId: BigInt(process.env["CHAIN_ID"] ?? "8453") } })
	const database = yield* Effect.acquireRelease(Effect.promise(() => PGlite.create(process.env["INDEX_DB"] ?? "./pool-history")),
		(database) => Effect.promise(() => database.close()))
	const from = process.env["START_BLOCK"]
	const pool = yield* PoolIndex.make({ client, store: yield* pgliteModelStore(database),
		params: { address: (process.env["POOL"] ?? "0x6c561B446416E1A00E8E93E221854d6eA4171372").toLowerCase() },
		plan: { live: { start: "head" }, history: { from: from === undefined ? "origin" : BigInt(from), direction: "backward", batchSize: 8 } },
	})
	yield* pool.watchStatus().pipe(Stream.runForEach((status) => Effect.log("Pool index", status)), Effect.forkScoped)
	yield* pool.watch("candles").pipe(Stream.runForEach((candle) => Effect.log("Candle", candle)), Effect.forkScoped)
	yield* pool.run()
}))
await runExample(program)
