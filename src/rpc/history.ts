import { Effect, Stream } from "effect"
import type { EvmClient, EvmClientError } from "./client.js"
import type { RpcFilter, RpcLog, RpcLogFilter } from "./schema.js"

export interface HistoricalLogsRequest {
	readonly fromBlock: bigint
	readonly toBlock: bigint
	readonly filter?: RpcLogFilter
	readonly chunkSize?: bigint
	readonly concurrency?: number
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

const defaultChunkSize = 1_000n
const defaultConcurrency = 4
const splitMessage = /block range|range limit|response size|result.*large|too many.*result|query returned|timeout|timed out/i

const ranges = function* (fromBlock: bigint, toBlock: bigint, chunkSize: bigint): Generator<BlockRange> {
	for (let start = fromBlock; start <= toBlock; start += chunkSize) {
		const end = start + chunkSize - 1n
		yield { fromBlock: start, toBlock: end < toBlock ? end : toBlock }
	}
}

const shouldSplit = (error: EvmClientError): boolean => {
	if (error._tag === "EndpointRequestTimeout") return true
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
		if (request.fromBlock > request.toBlock || chunkSize <= 0n || !Number.isSafeInteger(concurrency) || concurrency < 1) {
			return Stream.fail({
				_tag: "InvalidHistoricalRange",
				fromBlock: request.fromBlock,
				toBlock: request.toBlock,
			})
		}
		return Stream.fromIterable(ranges(request.fromBlock, request.toBlock, chunkSize)).pipe(
			Stream.mapEffect((range) => this.fetchRange(range, request.filter ?? {}), { concurrency, unordered: false }),
		)
	}

	streamLogs(request: HistoricalLogsRequest): Stream.Stream<HistoricalRpcLog, RpcHistoryError> {
		return this.streamLogPages(request).pipe(Stream.flatMap((page) => Stream.fromIterable(page.logs)))
	}

	getLogs(request: HistoricalLogsRequest): Effect.Effect<readonly HistoricalRpcLog[], RpcHistoryError> {
		return this.streamLogs(request).pipe(Stream.runCollect)
	}

	private fetchRange(
		range: BlockRange,
		filter: RpcLogFilter,
	): Effect.Effect<HistoricalLogPage, RpcHistoryError> {
		const rpcFilter: RpcFilter = { ...filter, ...range }
		return this.client.fetch({ method: "eth_getLogs", params: [rpcFilter] }).pipe(
			Effect.flatMap((logs) => normalizeLogs(logs, range)),
			Effect.map((logs) => ({ ...range, logs })),
			Effect.catchIf(
				(error): error is EvmClientError => "_tag" in error && error._tag !== "InvalidHistoricalLog",
				(error) => {
					if (!shouldSplit(error) || range.fromBlock === range.toBlock) {
						return Effect.fail<HistoricalRangeUnavailable>({ _tag: "HistoricalRangeUnavailable", ...range, cause: error })
					}
					const middle = (range.fromBlock + range.toBlock) / 2n
					return Effect.all([
						this.fetchRange({ fromBlock: range.fromBlock, toBlock: middle }, filter),
						this.fetchRange({ fromBlock: middle + 1n, toBlock: range.toBlock }, filter),
					], { concurrency: 1 }).pipe(Effect.map(([left, right]) => ({
						...range,
						logs: [...left.logs, ...right.logs],
					})))
				},
			),
		)
	}
}
