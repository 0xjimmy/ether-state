import { Effect, Schema } from "effect"
import { Interface, isAddress, id } from "ethers"
import { Indexer, Projection, Source } from "ether-state/indexer"
import type { ModelDefinition, ReadContext } from "ether-state/indexer"
import { isLogRangeLimit, type EvmClient } from "ether-state"
import type { IndexedBlock } from "ether-state/indexer"
import type { BlockLogBatch } from "ether-state"

const abi = new Interface([
	"function factory() view returns (address)",
	"function token0() view returns (address)",
	"function token1() view returns (address)",
	"function fee() view returns (uint24)",
	"function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
	"function liquidity() view returns (uint128)",
	"event Initialize(uint160 sqrtPriceX96, int24 tick)",
	"event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
	"event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
	"event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
])
const factoryAbi = new Interface(["event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"])
const signatures = ["Initialize(uint160,int24)", "Swap(address,address,int256,int256,uint160,uint128,int24)",
	"Mint(address,address,int24,int24,uint128,uint256,uint256)", "Burn(address,int24,int24,uint128,uint256,uint256)"].map(id)
const Params = Schema.Struct({ address: Schema.String.check(Schema.makeFilter((value) => isAddress(value))) })
export interface PoolParams { readonly address: string }
const EventSchema = Schema.Struct({ kind: Schema.Literals(["Initialize", "Swap", "Mint", "Burn"]),
	sqrtPriceX96: Schema.BigInt, tick: Schema.Number, liquidity: Schema.BigInt,
	amount0: Schema.BigInt, amount1: Schema.BigInt, lower: Schema.Number, upper: Schema.Number })
export interface PoolEvent {
	readonly kind: "Initialize" | "Swap" | "Mint" | "Burn"
	readonly sqrtPriceX96: bigint; readonly tick: number; readonly liquidity: bigint
	readonly amount0: bigint; readonly amount1: bigint; readonly lower: number; readonly upper: number
}
const StateSchema = Schema.Struct({ sqrtPriceX96: Schema.BigInt, tick: Schema.Number, liquidity: Schema.BigInt })
export interface PoolState { readonly sqrtPriceX96: bigint; readonly tick: number; readonly liquidity: bigint }
const CandleSchema = Schema.Struct({ open: Schema.NullOr(Schema.BigInt), high: Schema.NullOr(Schema.BigInt),
	low: Schema.NullOr(Schema.BigInt), close: Schema.NullOr(Schema.BigInt), volume0: Schema.BigInt, volume1: Schema.BigInt, swaps: Schema.Number })
export interface PoolCandle {
	/** Prices are sqrt(token1/token0) in Q96, before decimal adjustment. */
	readonly open: bigint | null; readonly high: bigint | null; readonly low: bigint | null; readonly close: bigint | null
	readonly volume0: bigint; readonly volume1: bigint; readonly swaps: number
}
const readPool = (address: string, context: ReadContext): Effect.Effect<PoolState, unknown> => Effect.gen(function* () {
	const data = yield* Effect.all({ slot: context.read({ to: address, data: abi.encodeFunctionData("slot0") }),
		liquidity: context.read({ to: address, data: abi.encodeFunctionData("liquidity") }) }, { concurrency: 2 })
	return yield* Effect.try(() => {
		const slot: readonly unknown[] = abi.decodeFunctionResult("slot0", data.slot)
		const liquidity: readonly unknown[] = abi.decodeFunctionResult("liquidity", data.liquidity)
		return Schema.decodeUnknownSync(StateSchema)({ sqrtPriceX96: slot[0], tick: Number(slot[1]), liquidity: liquidity[0] })
	})
})

/** Try upstream archive state, then filtered factory ranges. Verify the creation event in either path. */
export const findPoolCreation = (client: EvmClient, address: string): Effect.Effect<IndexedBlock, unknown> => Effect.gen(function* () {
	const metadata = yield* Effect.forEach(["factory", "token0", "token1", "fee"], (name) => client.call({
		transaction: { to: address, data: abi.encodeFunctionData(name) },
	}).pipe(Effect.flatMap((data) => Effect.try(() => {
		const values: readonly unknown[] = abi.decodeFunctionResult(name, data)
		return String(values[0])
	}))), { concurrency: 2 })
	const [factory, token0, token1, fee] = metadata
	if (factory === undefined || token0 === undefined || token1 === undefined || fee === undefined)
		return yield* Effect.fail(new Error("Pool metadata is unavailable"))
	const head = yield* client.getBlock()
	const topics = [id("PoolCreated(address,address,uint24,int24,address)"),
		`0x${token0.slice(2).toLowerCase().padStart(64, "0")}`, `0x${token1.slice(2).toLowerCase().padStart(64, "0")}`,
		`0x${BigInt(fee).toString(16).padStart(64, "0")}`]
	const creationFromLogs = (logs: BlockLogBatch["logs"]): Effect.Effect<IndexedBlock | null, unknown> => Effect.gen(function* () {
		for (const log of logs) {
			const matches = yield* Effect.try(() => {
				if (log.data === undefined || log.topics === undefined) return false
				const parsed = factoryAbi.parseLog({ data: log.data, topics: [...log.topics] })
				if (parsed === null) return false
				const args: Readonly<Record<string, unknown>> = parsed.args.toObject()
				return String(args["pool"]).toLowerCase() === address.toLowerCase()
			})
			if (!matches || log.blockNumber === undefined) continue
			const block = yield* client.fetchOne({ method: "eth_getBlockByNumber", params: [log.blockNumber, false] })
			if (block === null || block.hash !== log.blockHash) return yield* Effect.fail(new Error("Creation event is not canonical"))
			return block
		}
		return null
	})
	// Archive support belongs to each endpoint. EvmClient rotates capability failures.
	// If no configured endpoint can serve this search, use factory log ranges below.
	const archive = yield* Effect.gen(function* () {
		let low = 0n
		let high = head.number
		while (low < high) {
			const middle = (low + high) / 2n
			const code = yield* client.fetchOne({ method: "eth_getCode", params: [address, middle] })
			if (code === "0x") low = middle + 1n
			else high = middle
		}
		const block = yield* client.fetchOne({ method: "eth_getBlockByNumber", params: [low, false] })
		if (block === null) return null
		const logs = yield* client.fetchOne({ method: "eth_getLogs", params: [{ address: factory, topics, blockHash: block.hash }] })
		return yield* creationFromLogs(logs)
	}).pipe(Effect.result)
	if (archive._tag === "Success" && archive.success !== null) return archive.success
	let through = head.number
	let window = 100_000n
	while (through >= 0n) {
		const from = through >= window ? through - window + 1n : 0n
		const result = yield* client.fetchOne({ method: "eth_getLogs", params: [{ address: factory, topics, fromBlock: from, toBlock: through }] }).pipe(Effect.result)
		if (result._tag === "Failure") {
			if (!isLogRangeLimit(result.failure) || through - from + 1n <= 1n) return yield* Effect.fail(result.failure)
			window = (through - from + 1n) / 2n
			continue
		}
		const found = yield* creationFromLogs(result.success)
		if (found !== null) return found
		through = from - 1n
		yield* Effect.sleep(100)
	}
	return yield* Effect.fail(new Error("Factory creation event was not found"))
})

export const PoolIndex: ModelDefinition<PoolParams, { readonly current: PoolState; readonly candles: PoolCandle }> = Indexer.define({
	name: "uniswap-v3-pool", version: 1, params: Params,
	origin: ({ params, client }) => findPoolCreation(client, params.address),
	build: ({ params }) => {
		const events = Source.logs({ name: "events", filter: { address: params.address.toLowerCase(), topics: [signatures] }, schema: EventSchema,
			decode: (log) => Effect.try((): PoolEvent => {
				if (log.data === undefined || log.topics === undefined) throw new Error("Incomplete pool event")
				const event = abi.parseLog({ data: log.data, topics: [...log.topics] })
				if (event === null) throw new Error("Unknown pool event")
				const args: Readonly<Record<string, unknown>> = event.args.toObject()
				return Schema.decodeUnknownSync(EventSchema)({ kind: event.name, sqrtPriceX96: args["sqrtPriceX96"] ?? 0n,
					tick: Number(args["tick"] ?? 0), liquidity: args["liquidity"] ?? args["amount"] ?? 0n,
					amount0: args["amount0"] ?? 0n, amount1: args["amount1"] ?? 0n,
					lower: Number(args["tickLower"] ?? 0), upper: Number(args["tickUpper"] ?? 0) })
			}),
		})
		return {
			current: Projection.state({ source: events, schema: StateSchema, seed: (context) => readPool(params.address, context),
				reduce: ({ state, events }) => Effect.sync(() => {
					let next = state
					for (const event of events) {
						if (event.kind === "Swap") next = { sqrtPriceX96: event.sqrtPriceX96, tick: event.tick, liquidity: event.liquidity }
						else if (event.kind === "Initialize") next = { ...next, sqrtPriceX96: event.sqrtPriceX96, tick: event.tick }
						else if (event.lower <= next.tick && next.tick < event.upper) next = { ...next, liquidity: next.liquidity + (event.kind === "Mint" ? event.liquidity : -event.liquidity) }
					}
					return next
				}),
			}),
			candles: Projection.partitioned({ source: events, schema: CandleSchema, intervalSeconds: 60n,
				rebuild: ({ events }) => Effect.sync(() => {
					const swaps = events.filter(({ value }) => value.kind === "Swap").map(({ value }) => value)
					const prices = swaps.map((swap) => swap.sqrtPriceX96)
					const abs = (value: bigint) => value < 0n ? -value : value
					return { open: prices[0] ?? null, close: prices[prices.length - 1] ?? null,
						high: prices.length === 0 ? null : prices.reduce((a, b) => a > b ? a : b),
						low: prices.length === 0 ? null : prices.reduce((a, b) => a < b ? a : b),
						volume0: swaps.reduce((total, swap) => total + abs(swap.amount0), 0n),
						volume1: swaps.reduce((total, swap) => total + abs(swap.amount1), 0n), swaps: swaps.length }
				}),
			}),
		}
	},
})
