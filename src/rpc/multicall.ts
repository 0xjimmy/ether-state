import { Effect, Exit, Schema } from "effect"
import type { Scope } from "effect"
import { BatchQueue } from "./transport/queue.js"
import type { EvmClientError } from "./client.js"
import type { RpcBlockReference, RpcTransactionRequest } from "./schema.js"

const address = "0xcA11bde05977b3631167028862bE2a173976CA11"
const aggregate3Selector = "0x82ad56cb"
const getBlockNumberSelector = "0x42cbb15c"
const wordBytes = 32
const maxWord = (1n << 256n) - 1n
const Results = Schema.Array(Schema.Tuple([Schema.Boolean, Schema.String]))

type AggregateCall = readonly [target: string, allowFailure: boolean, callData: string]

const word = (value: bigint): string => {
	if (value < 0n || value > maxWord) throw new Error("Invalid ABI word")
	return value.toString(16).padStart(wordBytes * 2, "0")
}

const hex = (value: string): string => {
	if (!/^0x(?:[\da-f]{2})*$/i.test(value)) throw new Error("Invalid hex data")
	return value.slice(2).toLowerCase()
}

const encodeBytes = (value: string): string => {
	const data = hex(value)
	return word(BigInt(data.length / 2)) + data.padEnd(Math.ceil(data.length / (wordBytes * 2)) * wordBytes * 2, "0")
}

const encodeAddress = (value: string): string => {
	if (!/^0x[\da-f]{40}$/i.test(value)) throw new Error("Invalid address")
	return value.slice(2).toLowerCase().padStart(wordBytes * 2, "0")
}

const encodeAggregate3 = (calls: readonly AggregateCall[]): string => {
	const tuples = calls.map(([target, allowFailure, callData]) =>
		encodeAddress(target) + word(allowFailure ? 1n : 0n) + word(96n) + encodeBytes(callData))
	let offset = BigInt(calls.length * wordBytes)
	const offsets = tuples.map((tuple) => {
		const current = word(offset)
		offset += BigInt(tuple.length / 2)
		return current
	})
	return aggregate3Selector + word(32n) + word(BigInt(calls.length)) + offsets.join("") + tuples.join("")
}

const bytes = (value: string): Uint8Array => {
	const data = hex(value)
	const result = new Uint8Array(data.length / 2)
	for (let index = 0; index < result.length; index++) result[index] = Number.parseInt(data.slice(index * 2, index * 2 + 2), 16)
	return result
}

const readWord = (data: Uint8Array, offset: number): bigint => {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset + wordBytes > data.length) throw new Error("Invalid ABI offset")
	let value = 0n
	for (let index = 0; index < wordBytes; index++) {
		const byte = data[offset + index]
		if (byte === undefined) throw new Error("Invalid ABI word")
		value = (value << 8n) + BigInt(byte)
	}
	return value
}

const safeNumber = (value: bigint): number => {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ABI value exceeds the safe integer range")
	return Number(value)
}

const addOffset = (left: number, right: number): number => {
	const value = left + right
	if (!Number.isSafeInteger(value)) throw new Error("ABI offset exceeds the safe integer range")
	return value
}

const readBytes = (data: Uint8Array, offset: number): string => {
	const length = safeNumber(readWord(data, offset))
	const start = addOffset(offset, wordBytes)
	const end = addOffset(start, length)
	if (end > data.length) throw new Error("Invalid ABI byte range")
	return `0x${Array.from(data.slice(start, end), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

const decodeAggregate3 = (value: string): readonly (readonly [boolean, string])[] => {
	const data = bytes(value)
	const array = safeNumber(readWord(data, 0))
	const length = safeNumber(readWord(data, array))
	const heads = addOffset(array, wordBytes)
	if (addOffset(heads, length * wordBytes) > data.length) throw new Error("Invalid ABI array")
	const results: (readonly [boolean, string])[] = []
	for (let index = 0; index < length; index++) {
		const tuple = addOffset(heads, safeNumber(readWord(data, heads + index * wordBytes)))
		const success = readWord(data, tuple)
		if (success !== 0n && success !== 1n) throw new Error("Invalid ABI boolean")
		const output = addOffset(tuple, safeNumber(readWord(data, tuple + wordBytes)))
		results.push([success === 1n, readBytes(data, output)])
	}
	return results
}

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
			const data = encodeAggregate3([
				...calls.map((call): AggregateCall => [call.to ?? "", true, call.data ?? call.input ?? "0x"]),
				[address, false, getBlockNumberSelector],
			])
			const raw = yield* this.options.fetch({ to: address, data }, block)
			const decoded = yield* Effect.try({ try: (): unknown => decodeAggregate3(raw),
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
