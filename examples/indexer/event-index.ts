import { Effect, Schema } from "effect"
import { getAddress, Interface, zeroPadValue } from "ethers"
import { defineIndex, type IndexDefinition } from "../../src/indexer.js"

const transferAbi = ["event Transfer(address indexed from, address indexed to, uint256 value)"]
const poolAbi = [
	"event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
	"event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
	"event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
	"event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)",
]

const eventSchema: Schema.Struct<{
	address: typeof Schema.String
	event: typeof Schema.String
	transactionHash: typeof Schema.String
	logIndex: typeof Schema.String
	args: Schema.$Record<typeof Schema.String, typeof Schema.String>
}> = Schema.Struct({
	address: Schema.String,
	event: Schema.String,
	transactionHash: Schema.String,
	logIndex: Schema.String,
	args: Schema.Record(Schema.String, Schema.String),
})
type EventValue = typeof eventSchema.Type

type EventOptions = {
	readonly startBlock: bigint
} & (
	| { readonly kind: "transfers"; readonly token?: string; readonly user?: string; readonly direction: "both" | "from" | "to" }
	| { readonly kind: "v3"; readonly pools?: readonly string[]; readonly events: "all" | "swaps" | "liquidity" }
)

export const eventIndex = (options: EventOptions): IndexDefinition<EventValue, EventValue, Error> => {
	const abi = new Interface(options.kind === "transfers" ? transferAbi : poolAbi)
	const names = options.kind === "transfers" ? ["Transfer"]
		: options.events === "swaps" ? ["Swap"] : options.events === "liquidity" ? ["Mint", "Burn", "Collect"]
			: ["Swap", "Mint", "Burn", "Collect"]
	const signatures = names.map((name) => {
		const event = abi.getEvent(name)
		if (event === null) throw new Error(`Missing ABI event: ${name}`)
		return event.topicHash
	})
	const user = options.kind === "transfers" && options.user !== undefined ? getAddress(options.user).toLowerCase() : undefined
	const address = options.kind === "transfers"
		? options.token === undefined ? undefined : getAddress(options.token)
		: options.pools?.map((pool) => getAddress(pool))
	if (Array.isArray(address) && address.length === 0) throw new Error("Supply a pool address or omit the pool filter")
	const topics: (string | string[] | null)[] = [signatures]
	if (options.kind === "transfers" && user !== undefined && options.direction !== "both") {
		if (options.direction === "to") topics.push(null)
		topics.push(zeroPadValue(user, 32))
	}
	return defineIndex({
		id: JSON.stringify({ kind: options.kind, address, topics, user }),
		version: 1,
		startBlock: options.startBlock,
		finality: { mode: "confirmations", count: 2n },
		source: { logs: { ...(address === undefined ? {} : { address }), topics } },
		valueSchema: eventSchema,
		transform: (bundle) => Effect.try({
			try: () => bundle.logs.flatMap((log) => {
				if (log.address === undefined || log.topics === undefined || log.data === undefined || log.logIndex === undefined) {
					throw new Error("Incomplete event log")
				}
				if (options.kind === "transfers" && log.topics.length !== 3) return []
				const decoded = abi.parseLog({ topics: [...log.topics], data: log.data })
				if (decoded === null) throw new Error(`Cannot decode log ${log.transactionHash}:${log.logIndex.toString()}`)
				const args = Object.fromEntries(decoded.fragment.inputs.map((input, index) => [input.name, String(decoded.args[index])]))
				if (user !== undefined && args["from"]?.toLowerCase() !== user && args["to"]?.toLowerCase() !== user) return []
				return [{
					key: `${log.transactionHash}:${log.logIndex.toString()}`,
					value: { address: log.address, event: decoded.name, transactionHash: log.transactionHash,
						logIndex: log.logIndex.toString(), args },
				}]
			}),
			catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
		}),
	})
}
