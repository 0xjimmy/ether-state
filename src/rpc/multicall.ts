import { Effect, Exit, Schema } from "effect"
import type { Scope } from "effect"
import { Interface } from "ethers"
import { BatchQueue } from "./transport/queue.js"
import type { EvmClientError } from "./client.js"
import type { RpcBlockReference, RpcTransactionRequest } from "./schema.js"

const address = "0xcA11bde05977b3631167028862bE2a173976CA11"
const abi = new Interface([
	"function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
	"function getBlockNumber() view returns (uint256)",
])
const Results = Schema.Array(Schema.Tuple([Schema.Boolean, Schema.String]))

export interface ContractReverted { readonly _tag: "ContractReverted"; readonly data: string }
export interface InvalidMulticall { readonly _tag: "InvalidMulticall"; readonly message: string }
export type CallError = EvmClientError | ContractReverted | InvalidMulticall
export interface ContractRead {
	readonly transaction: RpcTransactionRequest
	readonly block?: RpcBlockReference
	readonly multicall?: boolean
}

export class MulticallReads {
	private readonly groups = new Map<string, BatchQueue<RpcTransactionRequest, string, CallError>>()
	readonly stats = { batches: 0, calls: 0, singles: 0, fallbacks: 0 }

	constructor(private readonly options: {
		readonly scope: Scope.Scope; readonly window: number; readonly size: number; readonly capacity: number
		readonly maxCalldataBytes: number
		readonly fetch: (transaction: RpcTransactionRequest, block: RpcBlockReference) => Effect.Effect<string, EvmClientError>
		readonly code: (block: RpcBlockReference) => Effect.Effect<string, EvmClientError>
	}) {}

	request(read: ContractRead & { readonly block: RpcBlockReference; readonly blockNumber: bigint }): Effect.Effect<string, CallError> {
		if (read.multicall === false || typeof read.transaction.to !== "string" || read.transaction.to.toLowerCase() === address.toLowerCase() ||
			Object.keys(read.transaction).some((key) => key !== "to" && key !== "data" && key !== "input")) {
			this.stats.singles++
			return this.options.fetch(read.transaction, read.block)
		}
		const key = JSON.stringify(read.block, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value)
		let queue = this.groups.get(key)
		if (queue === undefined) {
			queue = new BatchQueue({ ...this.options, maxWeight: this.options.maxCalldataBytes,
				weight: (call) => Math.max(0, ((call.data ?? call.input ?? "0x").length - 2) / 2),
				run: (calls) => this.run(calls, read.block, read.blockNumber) })
			this.groups.set(key, queue)
		}
		const selected = queue
		return selected.request(read.transaction).pipe(Effect.ensuring(Effect.sync(() => {
			if (selected.size === 0 && this.groups.get(key) === selected) this.groups.delete(key)
		})))
	}

	private run(calls: readonly RpcTransactionRequest[], block: RpcBlockReference, blockNumber: bigint): Effect.Effect<readonly Exit.Exit<string, CallError>[], CallError> {
		const singles = () => {
			this.stats.singles += calls.length
			return Effect.forEach(calls, (call) => Effect.exit(this.options.fetch(call, block)), { concurrency: 4 })
		}
		if (calls.length === 1) return singles()
		return Effect.gen({ self: this }, function* () {
			if ((yield* this.options.code(block)) === "0x") {
				this.stats.fallbacks++
				return yield* singles()
			}
			this.stats.batches++
			this.stats.calls += calls.length
			const data = abi.encodeFunctionData("aggregate3", [[
				...calls.map((call) => [call.to, true, call.data ?? call.input ?? "0x"]),
				[address, false, abi.encodeFunctionData("getBlockNumber")],
			]])
			const raw = yield* this.options.fetch({ to: address, data }, block)
			const decoded = yield* Effect.try({ try: (): unknown => abi.decodeFunctionResult("aggregate3", raw)[0],
				catch: (): InvalidMulticall => ({ _tag: "InvalidMulticall", message: "Invalid aggregate return data" }) })
			const results = yield* Schema.decodeUnknownEffect(Results)(decoded)
			const metadata = results[calls.length]
			if (results.length !== calls.length + 1 || metadata?.[0] !== true || !/^0x[\da-f]{64}$/i.test(metadata[1]) || BigInt(metadata[1]) !== blockNumber) {
				return yield* Effect.fail<InvalidMulticall>({ _tag: "InvalidMulticall", message: "Multicall block verification failed" })
			}
			return results.slice(0, calls.length).map(([success, data]): Exit.Exit<string, CallError> => success
				? Exit.succeed(data) : Exit.fail<ContractReverted>({ _tag: "ContractReverted", data }))
		}).pipe(Effect.catch(() => Effect.sync(() => { this.stats.fallbacks++ }).pipe(Effect.andThen(singles()))))
	}
}

export const multicallAddress: string = address
