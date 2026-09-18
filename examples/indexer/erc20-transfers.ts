import { PGlite } from "@electric-sql/pglite"
import { Effect, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { Interface } from "ethers"
import { EvmClient } from "../../src/index.js"
import { Indexer } from "../../src/indexer.js"
import { pgliteStore } from "../../src/indexer-pglite.js"
import { eventIndex, type EventValue } from "./event-index.js"

const metadataAbi = new Interface([
	"function name() view returns (string)",
	"function symbol() view returns (string)",
	"function decimals() view returns (uint8)",
])

const program = Effect.scoped(Effect.gen(function* () {
	const client = yield* EvmClient.make({ network: { chainId: BigInt(process.env["CHAIN_ID"] ?? "1") } })
	const head = yield* client.getBlock()
	const start = process.env["START_BLOCK"]
	let startBlock = start === undefined ? head.number > 4n ? head.number - 4n : 0n : BigInt(start)
	const direction = process.env["DIRECTION"] ?? "both"
	if (direction !== "both" && direction !== "from" && direction !== "to") throw new Error("Use DIRECTION=both, from, or to")
	const token = process.env["TOKEN"]
	const user = process.env["USER_ADDRESS"]
	const makeIndex = () => eventIndex({
		kind: "transfers", startBlock, direction,
		...(token === undefined ? {} : { token }), ...(user === undefined ? {} : { user }),
	})
	let index = makeIndex()
	const end = process.env["END_BLOCK"]
	const toBlock = end === undefined ? undefined : BigInt(end)

	const database = new PGlite(process.env["INDEX_DB"])
	yield* Effect.addFinalizer(() => Effect.promise(() => database.close()))
	const stored = yield* pgliteStore<EventValue>(database)
	const checkpoint = yield* stored.load(index.id, index.version)
	if (start === undefined && checkpoint !== null) {
		startBlock = checkpoint.startBlock
		index = makeIndex()
	}
	if (toBlock !== undefined && toBlock < startBlock) throw new Error("END_BLOCK must be at or after START_BLOCK")
	yield* Effect.promise(() => database.exec(`CREATE TABLE IF NOT EXISTS erc20_metadata (
		chain_id TEXT NOT NULL, address TEXT NOT NULL, name TEXT, symbol TEXT, decimals INTEGER,
		PRIMARY KEY (chain_id, address)
	)`))
	const chainId = client.config.network.chainId.toString()
	const metadata = (address: string) => Effect.gen(function* () {
		const cached = yield* Effect.promise(() => database.query(
			"SELECT address FROM erc20_metadata WHERE chain_id = $1 AND address = $2", [chainId, address],
		))
		if (cached.rows.length > 0) return
		const read = (field: "name" | "symbol" | "decimals") => client.call({
			transaction: { to: address, data: metadataAbi.encodeFunctionData(field) },
		}).pipe(
			Effect.flatMap((data) => Effect.try((): string | number => {
				const value: unknown = metadataAbi.decodeFunctionResult(field, data)[0]
				if (field === "decimals" && typeof value === "bigint" && value >= 0n && value <= 255n) return Number(value)
				if (field !== "decimals" && typeof value === "string") return value
				throw new Error(`Invalid ${field}`)
			})),
			Effect.timeout("10 seconds"),
			Effect.catch(() => Effect.succeed(null)),
		)
		const [name, symbol, decimals] = yield* Effect.all([read("name"), read("symbol"), read("decimals")], { concurrency: 3 })
		yield* Effect.promise(() => database.query(
			"INSERT INTO erc20_metadata (chain_id, address, name, symbol, decimals) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
			[chainId, address, name, symbol, decimals],
		))
		console.log("Cached token metadata", { address, name, symbol, decimals })
	})
	const indexer = yield* Indexer.make({
		client, index,
		store: {
			...stored,
			commit: (commit) => Effect.gen(function* () {
				const addresses = [...new Set(commit.rows.map((row) => row.value.address.toLowerCase()))]
				yield* Effect.forEach(addresses, metadata, { concurrency: 4 })
				yield* stored.commit(commit)
				for (const row of commit.rows) console.log({ kind: "Apply", block: row.blockNumber, blockHash: row.blockHash, ...row.value })
			}),
			rollback: (change) => stored.rollback(change).pipe(Effect.tap(() => Effect.sync(() => {
				console.log({ kind: "Revert", orphaned: change.orphaned })
			}))),
		},
	})
	console.log("Watching ERC-20 transfers and metadata", { chainId, startBlock })
	if (toBlock !== undefined) yield* indexer.sync(toBlock)
	else yield* indexer.run().pipe(Stream.runForEach((checkpoint) => Effect.log("Indexed transfers", checkpoint?.number)))
	console.log("Cached tokens", (yield* Effect.promise(() => database.query("SELECT * FROM erc20_metadata"))).rows)
}))

await Effect.runPromise(program.pipe(
	Effect.provide(FetchHttpClient.layer),
	Effect.provide(Socket.layerWebSocketConstructorGlobal),
))
