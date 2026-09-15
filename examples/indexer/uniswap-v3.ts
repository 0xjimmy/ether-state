import { Effect, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { EvmClient } from "../../src/index.js"
import { callbackStore, Indexer, type IndexCheckpoint, type IndexedBlock } from "../../src/indexer.js"
import { eventIndex, type EventValue } from "./event-index.js"

const program = Effect.scoped(Effect.gen(function* () {
	const client = yield* EvmClient.make({ network: { chainId: BigInt(process.env["CHAIN_ID"] ?? "1") } })
	const head = yield* client.getBlock()
	const start = process.env["START_BLOCK"]
	const startBlock = start === undefined ? head.number > 4n ? head.number - 4n : 0n : BigInt(start)
	const pools = process.env["POOLS"]?.split(",").map((pool) => pool.trim())
	const index = eventIndex({ kind: "v3", startBlock, events: "all", ...(pools === undefined ? {} : { pools }) })
	const end = process.env["END_BLOCK"]
	const toBlock = end === undefined ? undefined : BigInt(end)
	let checkpoint: IndexCheckpoint | null = null
	let blocks: IndexedBlock[] = []
	const store = callbackStore<EventValue, never, never>({
		load: () => Effect.sync(() => checkpoint),
		recent: (_id, _version, limit) => Effect.sync(() => blocks.slice(0, limit)),
		write: (change) => Effect.sync(() => {
			if (change._tag === "Apply") {
				for (const row of change.rows) {
					const args = row.value.args
					const flow = (amount: string) => BigInt(amount) > 0n ? "in" : BigInt(amount) < 0n ? "out" : "unchanged"
					const direction = row.value.event === "Swap"
						? `token0 ${flow(args["amount0"] ?? "0")}, token1 ${flow(args["amount1"] ?? "0")}`
						: undefined
					console.log({ kind: "Apply", block: row.blockNumber, blockHash: row.blockHash, ...row.value, direction })
				}
				blocks = [change.block, ...blocks].slice(0, 128)
			} else {
				console.log({ kind: "Revert", orphaned: change.orphaned })
				const hashes = new Set(change.orphaned.map((block) => block.hash))
				blocks = blocks.filter((block) => !hashes.has(block.hash))
			}
			checkpoint = change.checkpoint
		}),
	})
	if (toBlock !== undefined && toBlock < startBlock) throw new Error("END_BLOCK must be at or after START_BLOCK")
	const indexer = yield* Indexer.make({ client, index, store })
	console.log("Watching V3 pool events", { chainId: client.config.network.chainId, startBlock })
	if (toBlock !== undefined) yield* indexer.sync(toBlock)
	else yield* indexer.run().pipe(Stream.runForEach((checkpoint) => Effect.log("Indexed V3", checkpoint?.number)))
}))

await Effect.runPromise(program.pipe(
	Effect.provide(FetchHttpClient.layer),
	Effect.provide(Socket.layerWebSocketConstructorGlobal),
))
