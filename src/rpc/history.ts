import { RpcPriority } from "./priority.js"
import { Effect, Schedule, Stream } from "effect"
import type { EvmClient, EvmClientError } from "./client.js"
import type { RpcBlock, RpcFilter, RpcLog, RpcLogFilter, RpcTransaction, RpcReceipt } from "./schema.js"

export interface HistoricalLogsRequest {
	readonly fromBlock: bigint
	readonly toBlock: bigint
	readonly filter?: RpcLogFilter
	readonly chunkSize?: bigint
	readonly concurrency?: number
	readonly direction?: "forward" | "backward"
}

export interface HistoricalRpcLog extends RpcLog {
	readonly blockHash: string
	readonly blockNumber: bigint
	readonly transactionIndex: bigint
	readonly logIndex: bigint
}

export interface HistoricalLogPage {
	readonly fromBlock: bigint
	readonly toBlock: bigint
	readonly logs: readonly HistoricalRpcLog[]
}

export interface InvalidHistoricalRange {
	readonly _tag: "InvalidHistoricalRange"
	readonly fromBlock: bigint
	readonly toBlock: bigint
}

export interface HistoricalRangeUnavailable {
	readonly _tag: "HistoricalRangeUnavailable"
	readonly fromBlock: bigint
	readonly toBlock: bigint
	readonly cause: EvmClientError
}

export interface InvalidHistoricalLog {
	readonly _tag: "InvalidHistoricalLog"
	readonly fromBlock: bigint
	readonly toBlock: bigint
}

export type RpcHistoryError = InvalidHistoricalRange | HistoricalRangeUnavailable | InvalidHistoricalLog

interface BlockRange {
	readonly fromBlock: bigint
	readonly toBlock: bigint
}

export interface HistoricalBlocksRequest {
	readonly fromBlock: bigint
	readonly toBlock: bigint
	readonly concurrency?: number
	readonly full?: boolean
}

const defaultChunkSize = 1_000n
const defaultConcurrency = 4
const splitMessage = /block range|range limit|response size|result.*large|too many.*result|query returned/i


const ranges = function* (fromBlock: bigint, toBlock: bigint, chunkSize: bigint, direction: "forward" | "backward" = "forward"): Generator<BlockRange> {
	if (direction === "backward") {
		for (let end = toBlock; end >= fromBlock;) {
			const start = end - chunkSize + 1n > fromBlock ? end - chunkSize + 1n : fromBlock
			yield { fromBlock: start, toBlock: end }
			if (start === fromBlock) break
			end = start - 1n
		}
		return
	}
	for (let start = fromBlock; start <= toBlock; start += chunkSize) {
		const end = start + chunkSize - 1n
		yield { fromBlock: start, toBlock: end < toBlock ? end : toBlock }
	}
}

const shouldSplit = (error: EvmClientError): boolean => {
	if (error._tag === "EndpointRequestTimeout") return false
	if (error._tag === "RpcError") return splitMessage.test(error.message)
	if ("message" in error && typeof error.message === "string") return splitMessage.test(error.message)
	return false
}

const normalizeLogs = (
	logs: readonly RpcLog[],
	range: BlockRange,
): Effect.Effect<readonly HistoricalRpcLog[], InvalidHistoricalLog> => Effect.gen(function* () {
	const normalized: HistoricalRpcLog[] = []
	for (const log of logs) {
		if (log.blockHash === undefined || log.blockNumber === undefined || log.transactionIndex === undefined ||
			log.logIndex === undefined || log.blockNumber < range.fromBlock || log.blockNumber > range.toBlock) {
			return yield* Effect.fail<InvalidHistoricalLog>({ _tag: "InvalidHistoricalLog", ...range })
		}
		normalized.push({
			...log,
			blockHash: log.blockHash,
			blockNumber: log.blockNumber,
			transactionIndex: log.transactionIndex,
			logIndex: log.logIndex,
		})
	}
	const unique = new Map<string, HistoricalRpcLog>()
	for (const log of normalized) unique.set(`${log.blockHash}:${log.transactionHash}:${log.logIndex.toString()}`, log)
	return [...unique.values()].sort((left, right) => {
		if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1
		if (left.transactionIndex !== right.transactionIndex) return left.transactionIndex < right.transactionIndex ? -1 : 1
		if (left.logIndex === right.logIndex) return 0
		return left.logIndex < right.logIndex ? -1 : 1
	})
})

export class RpcHistory {
	constructor(private readonly client: EvmClient) {}

	streamLogPages(request: HistoricalLogsRequest): Stream.Stream<HistoricalLogPage, RpcHistoryError> {
		const chunkSize = request.chunkSize ?? defaultChunkSize
		const concurrency = request.concurrency ?? defaultConcurrency
		if (request.fromBlock < 0n || request.fromBlock > request.toBlock || chunkSize <= 0n || !Number.isSafeInteger(concurrency) || concurrency < 1) {
			return Stream.fail({
				_tag: "InvalidHistoricalRange",
				fromBlock: request.fromBlock,
				toBlock: request.toBlock,
			})
		}
		const direction = request.direction ?? "forward"
		return Stream.fromIterable(ranges(request.fromBlock, request.toBlock, chunkSize, direction)).pipe(Stream.grouped(concurrency),
			Stream.flatMap((window) => Stream.suspend(() => {
				let cursor = direction === "forward" ? window[0].fromBlock : window[0].toBlock
				const ready = new Map<bigint, HistoricalLogPage>()
				return Stream.mergeAll(window.map((range) => this.streamRange(range, request.filter ?? {}, direction)), { concurrency }).pipe(
					Stream.map((page) => {
						ready.set(direction === "forward" ? page.fromBlock : page.toBlock, page)
						const output: HistoricalLogPage[] = []
						while (ready.has(cursor)) {
							const next = ready.get(cursor)
							if (next === undefined) break
							ready.delete(cursor)
							output.push(next)
							cursor = direction === "forward" ? next.toBlock + 1n : next.fromBlock - 1n
						}
						return output
					}), Stream.flattenIterable)
			})), Stream.provideService(RpcPriority, "background"))
	}

	streamLogs(request: HistoricalLogsRequest): Stream.Stream<HistoricalRpcLog, RpcHistoryError> {
		return this.streamLogPages(request).pipe(Stream.flatMap((page) => Stream.fromIterable(page.logs)))
	}

	getLogs(request: HistoricalLogsRequest): Effect.Effect<readonly HistoricalRpcLog[], RpcHistoryError> {
		return this.streamLogs(request).pipe(Stream.runCollect)
	}

	streamBlocks(request: HistoricalBlocksRequest): Stream.Stream<RpcBlock, RpcHistoryError> {
		if (request.fromBlock < 0n || request.fromBlock > request.toBlock || !Number.isSafeInteger(request.concurrency ?? 4) || (request.concurrency ?? 4) < 1) {
			return Stream.fail<InvalidHistoricalRange>({ _tag: "InvalidHistoricalRange", ...request })
		}
		return Stream.fromIterable(ranges(request.fromBlock, request.toBlock, 1n)).pipe(Stream.mapEffect((range) =>
			this.client.fetchOne({ method: "eth_getBlockByNumber", params: [range.fromBlock, request.full ?? false] }).pipe(
				Effect.flatMap((block) => block?.number === range.fromBlock ? Effect.succeed(block) : Effect.fail({ _tag: "BlockUnavailable" } as const)),
				Effect.mapError((cause): HistoricalRangeUnavailable => ({ _tag: "HistoricalRangeUnavailable", ...range, cause }))),
		{ concurrency: request.concurrency ?? 4, unordered: false }), Stream.provideService(RpcPriority, "background"))
	}

	getBlocks(request: HistoricalBlocksRequest): Effect.Effect<readonly RpcBlock[], RpcHistoryError> {
		return this.streamBlocks(request).pipe(Stream.runCollect)
	}

	streamTransactions(request: HistoricalBlocksRequest): Stream.Stream<RpcTransaction, RpcHistoryError> {
		return this.streamBlocks({ ...request, full: true }).pipe(Stream.map((block) => block.transactions.filter((tx) => typeof tx !== "string")), Stream.flattenIterable)
	}

	getTransactions(request: HistoricalBlocksRequest): Effect.Effect<readonly RpcTransaction[], RpcHistoryError> {
		return this.streamTransactions(request).pipe(Stream.runCollect)
	}

	streamReceipts(request: HistoricalBlocksRequest): Stream.Stream<RpcReceipt, RpcHistoryError> {
		return this.streamBlocks(request).pipe(Stream.mapEffect((block) => this.client.fetchOne({ method: "eth_getBlockReceipts", params: [block.number] }).pipe(
			Effect.flatMap((receipts) => receipts !== null && receipts.length === block.transactions.length && receipts.every((receipt) => receipt.blockHash === block.hash)
				? Effect.succeed(receipts) : Effect.fail({ _tag: "BlockUnavailable" } as const)),
			Effect.mapError((cause): HistoricalRangeUnavailable => ({ _tag: "HistoricalRangeUnavailable", fromBlock: block.number, toBlock: block.number, cause }))),
		{ concurrency: request.concurrency ?? 4, unordered: false }), Stream.flattenIterable, Stream.provideService(RpcPriority, "background"))
	}

	getReceipts(request: HistoricalBlocksRequest): Effect.Effect<readonly RpcReceipt[], RpcHistoryError> {
		return this.streamReceipts(request).pipe(Stream.runCollect)
	}

	private streamRange(
		range: BlockRange,
		filter: RpcLogFilter,
		direction: "forward" | "backward" = "forward",
	): Stream.Stream<HistoricalLogPage, RpcHistoryError> {
		const rpcFilter: RpcFilter = { ...filter, ...range }
		return Stream.fromEffect(this.client.fetchOne({ method: "eth_getLogs", params: [rpcFilter] }).pipe(
			Effect.retry({ times: 2, schedule: Schedule.spaced(500), while: (error) => !shouldSplit(error) && error._tag !== "SchemaError" &&
				!(error._tag === "RpcError" && (error.code === -32602 || error.code === -32601)) }),
			Effect.flatMap((logs) => normalizeLogs(logs, range)),
			Effect.map((logs) => ({ ...range, logs })),
		)).pipe(Stream.catchIf(
				(error): error is EvmClientError => "_tag" in error && error._tag !== "InvalidHistoricalLog",
				(error) => {
					if (!shouldSplit(error) || range.fromBlock === range.toBlock) {
						return Stream.fail<HistoricalRangeUnavailable>({ _tag: "HistoricalRangeUnavailable", ...range, cause: error })
					}
					const middle = (range.fromBlock + range.toBlock) / 2n
					const lower = this.streamRange({ fromBlock: range.fromBlock, toBlock: middle }, filter, direction)
					const upper = this.streamRange({ fromBlock: middle + 1n, toBlock: range.toBlock }, filter, direction)
					return direction === "forward" ? Stream.concat(lower, upper) : Stream.concat(upper, lower)
				},
			),
		)
	}
}
