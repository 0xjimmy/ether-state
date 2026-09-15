import { PGlite } from "@electric-sql/pglite"
import { Effect, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { EvmClient } from "../../src/index.js"
import { Indexer } from "../../src/indexer.js"
import { pgliteStore } from "../../src/indexer-pglite.js"
import { eventIndex } from "./event-index.js"

const program = Effect.scoped(Effect.gen(function* () {
	const endpoint = process.env["RPC_HTTP_URL"] ?? "https://ethereum-rpc.publicnode.com"
	const start = process.env["START_BLOCK"]
	if (start === undefined) throw new Error("Set START_BLOCK to the first block to index")
	const startBlock = BigInt(start)
	const mode = process.argv[2] ?? "transfers"
	if (mode !== "transfers" && mode !== "v3") throw new Error("Use transfers or v3")
	const direction = process.env["DIRECTION"] ?? "both"
	if (direction !== "both" && direction !== "from" && direction !== "to") throw new Error("Use DIRECTION=both, from, or to")
	const events = process.env["EVENTS"] ?? "all"
	if (events !== "all" && events !== "swaps" && events !== "liquidity") throw new Error("Use EVENTS=all, swaps, or liquidity")
	const token = process.env["TOKEN"]
	const user = process.env["USER_ADDRESS"]
	const pools = process.env["POOLS"]?.split(",").map((pool) => pool.trim())
	const index = eventIndex(mode === "transfers"
		? { kind: mode, startBlock, direction, ...(token === undefined ? {} : { token }), ...(user === undefined ? {} : { user }) }
		: { kind: mode, startBlock, events, ...(pools === undefined ? {} : { pools }) })
	const database = new PGlite(process.env["INDEX_DB"])
	yield* Effect.addFinalizer(() => Effect.promise(() => database.close()))
	const client = yield* EvmClient.make({
		endpoints: { http: [endpoint], ws: [] },
		network: { chainId: BigInt(process.env["CHAIN_ID"] ?? "1"), blockTime: 12_000 },
	})
	const store = yield* pgliteStore(database)
	const indexer = yield* Indexer.make({ client, index, store })
	const end = process.env["END_BLOCK"]
	if (end !== undefined) {
		const toBlock = BigInt(end)
		if (toBlock < startBlock) throw new Error("END_BLOCK must be at or after START_BLOCK")
		yield* indexer.sync(toBlock)
	} else {
		yield* indexer.run().pipe(Stream.runForEach((checkpoint) => Effect.log("Indexed events", checkpoint)))
	}
	const result = yield* Effect.promise(() => database.query(
		"SELECT block_number, value_json FROM ether_state_rows WHERE index_id = $1 ORDER BY CAST(block_number AS NUMERIC), row_key", [index.id],
	))
	yield* Effect.log("Stored events", result.rows)
}))

await Effect.runPromise(program.pipe(
	Effect.provide(FetchHttpClient.layer),
	Effect.provide(Socket.layerWebSocketConstructorGlobal),
))
