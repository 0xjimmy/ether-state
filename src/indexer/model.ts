import { Cause, Effect, PubSub, Queue, Schedule, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import { makeLifetime } from "../internal/lifetime.js"
import type { Scope } from "effect"
import type { EvmClient } from "../rpc/client.js"
import type { RpcLog } from "../rpc/schema.js"
import type { BlockLogBatch } from "../rpc/watch.js"
import { matchesLog } from "../rpc/watch.js"
import { RpcHistory } from "../rpc/history.js"
import type { IndexedBlock } from "./index.js"
import { readContext, type LogSource, type Projection, type SourceCaptureContext } from "./model-definition.js"
import { memoryModelStore, missingRange, missingForwardRange, modelFailure, type BlockRange, type ModelBatch, type ModelFailure,
	type ModelStore, type ProjectionRow } from "./model-store.js"

/** Evaluated once before scheduling each historical request window. */
export type ModelHistoryBatch =
	| { readonly unit: "minutes"; readonly size: number; readonly bufferSeconds?: number; readonly concurrency?: number }
	| { readonly unit: "blocks"; readonly size: number; readonly concurrency?: number }

export interface ModelPlan {
	readonly live?: { readonly start: "head" | "checkpoint" }
	readonly history?: { readonly from: bigint | "origin"; readonly through?: bigint; readonly batchSize?: number; readonly batch?: ModelHistoryBatch | (() => ModelHistoryBatch); readonly direction?: "forward" | "backward"; readonly maxLiveLagBlocks?: bigint }
	readonly retention?: {
		/** Retain source batches for at least this many recent blocks. */
		readonly blocks?: bigint
		/** Retain source batches and completed partitions for at least this many recent seconds. */
		readonly seconds?: bigint
		/** Run periodic retention after this many newly applied live blocks. Defaults to 64. */
		readonly everyBlocks?: number
		/** Do not run periodic retention more often than this many seconds. Defaults to 60. */
		readonly everySeconds?: number
	}
}
export interface ModelStatus {
	readonly live: "idle" | "starting" | "following" | "recovering" | "failed" | "closed"
	readonly head: IndexedBlock | null
	readonly applied: IndexedBlock | null
	readonly history: "disabled" | "resolving" | "backfilling" | "complete" | "blocked"
	readonly coverage: readonly BlockRange[]
	readonly error: ModelFailure | null
}
export interface ProjectionUpdate<A> {
	readonly kind: "upsert" | "reset"
	readonly key: string
	readonly value: A | null
	readonly block: IndexedBlock
	readonly period: ProjectionRow["period"]
	readonly coverage: ProjectionRow["coverage"]
}
export type SourceUpdate<A> =
	| { readonly kind: "apply"; readonly block: IndexedBlock; readonly events: readonly A[] }
	| { readonly kind: "revert"; readonly from: bigint }
export type RawSourceUpdate =
	| { readonly kind: "apply"; readonly block: IndexedBlock; readonly logs: readonly RpcLog[] }
	| { readonly kind: "revert"; readonly from: bigint }
export interface ModelOptions {
	readonly client: EvmClient
	readonly store?: ModelStore
	readonly namespace?: string
	readonly plan: ModelPlan
}
export interface ModelDefinition<P, Outputs extends Readonly<Record<string, unknown>>> {
	readonly name: string
	readonly version: number
	readonly make: (options: ModelOptions & { readonly params: P }) => Effect.Effect<ModelInstance<Outputs>, ModelFailure, Scope.Scope>
}
export type ModelValue<P> = P extends Projection<infer A> ? A : never
export interface ModelInstance<Outputs extends Readonly<Record<string, unknown>>> {
	readonly id: string
	readonly isClosed: boolean
	readonly close: () => Effect.Effect<void>
	readonly run: () => Effect.Effect<void, ModelFailure, Scope.Scope>
	readonly status: Effect.Effect<ModelStatus>
	readonly watchStatus: () => Stream.Stream<ModelStatus>
	readonly watchSource: <A>(source: LogSource<A>) => Stream.Stream<SourceUpdate<A>, ModelFailure>
	readonly watchLogs: (source: LogSource<unknown>) => Stream.Stream<RawSourceUpdate, ModelFailure>
	readonly read: <K extends keyof Outputs & string>(name: K) => Effect.Effect<readonly ProjectionUpdate<Outputs[K]>[], ModelFailure>
	readonly watch: <K extends keyof Outputs & string>(name: K) => Stream.Stream<ProjectionUpdate<Outputs[K]>, ModelFailure>
}

const canonical = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
	if (typeof value === "bigint") return `{"bigint":${JSON.stringify(value.toString())}}`
	if (value === undefined) return "{\"undefined\":true}"
	if (typeof value === "function" || typeof value === "symbol") throw new Error("Parameters must have a stable JSON encoding")
	return JSON.stringify(typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : value)
}
const mergeCoverage = (ranges: readonly BlockRange[], batches: readonly ModelBatch[], scanned: readonly BlockRange[] = []): readonly BlockRange[] => {
	const all = [...ranges, ...scanned, ...batches.map(({ block }) => ({ from: block.number, through: block.number }))].sort((a, b) => a.from < b.from ? -1 : 1)
	const result: { from: bigint; through: bigint }[] = []
	for (const range of all) {
		const last = result[result.length - 1]
		if (last !== undefined && range.from <= last.through + 1n) { if (range.through > last.through) last.through = range.through }
		else result.push({ ...range })
	}
	return result
}
const header = (block: IndexedBlock): IndexedBlock => ({ number: block.number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp })
const blockAt = (client: EvmClient, number: bigint | "latest"): Effect.Effect<IndexedBlock, ModelFailure> =>
	client.fetchOne({ method: "eth_getBlockByNumber", params: [number, false] }).pipe(
		Effect.mapError((cause) => modelFailure("source", cause)),
		Effect.flatMap((block) => block === null || (number !== "latest" && block.number !== number)
			? Effect.fail(modelFailure("source", "Requested block is unavailable")) : Effect.succeed(header(block))))

export const defineModel = <P, Outputs extends Readonly<Record<string, unknown>>>(definition: {
	readonly name: string
	readonly version: number
	readonly params: Schema.Codec<P>
	readonly build: (context: { readonly params: P }) => { readonly [K in keyof Outputs]: Projection<Outputs[K]> }
	readonly origin?: (context: { readonly params: P; readonly client: EvmClient }) => Effect.Effect<IndexedBlock, unknown>
}): ModelDefinition<P, Outputs> => ({
	name: definition.name, version: definition.version,
	make: (options) => Effect.gen(function* () {
		const params = yield* Schema.decodeUnknownEffect(definition.params)(options.params).pipe(Effect.mapError((cause) => modelFailure("definition", cause)))
		const projections = yield* Effect.try(() => definition.build({ params })).pipe(Effect.mapError((cause) => modelFailure("definition", cause)))
		const id = yield* Effect.try(() => canonical({ name: definition.name, version: definition.version,
			chain: options.client.config.network.chainId.toString(), params, namespace: options.namespace ?? "default" })).pipe(Effect.mapError((cause) => modelFailure("definition", cause)))
		const entries: readonly (readonly [string, Projection<unknown>])[] = Object.entries(projections)
		const sources = new Map<string, LogSource<unknown>>()
		for (const projection of entries.map(([, projection]) => projection)) {
			if (projection.interval !== null && projection.interval <= 0n) return yield* Effect.fail(modelFailure("definition", "Partition interval must be positive"))
			const existing = sources.get(projection.source.name)
			if (existing !== undefined && existing !== projection.source) return yield* Effect.fail(modelFailure("definition", "Source names must be unique"))
			sources.set(projection.source.name, projection.source)
		}
		const hasPartitionedProjections = entries.some(([, projection]) => projection.kind === "partitioned")
		const historyBatch = () => Effect.try({
			try: () => {
				const setting = options.plan.history?.batch
				if (setting !== undefined && options.plan.history?.batchSize !== undefined) throw new Error("Use batch or batchSize, not both")
				const batch = typeof setting === "function" ? setting() : setting
				const concurrency = batch?.concurrency ?? 1
				let size = batch?.size ?? options.plan.history?.batchSize ?? 256
				if (batch?.unit === "minutes") {
					const blockTime = options.client.config.network.blockTime
					const buffer = batch.bufferSeconds ?? 15
					if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(buffer) || buffer < 0 || !Number.isFinite(blockTime) || blockTime <= 0) throw new Error("Invalid history time window or network block time")
					size = Math.ceil((size * 60 + buffer) * 1000 / blockTime)
				}
				if (!Number.isSafeInteger(size) || size < 1 || size > 100_000 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("History batches require 1–100000 blocks and concurrency 1–16")
				return { size, concurrency }
			},
			catch: (cause) => modelFailure("definition", cause),
		})
		// Static plans fail at construction. Runtime callbacks are read only when work is scheduled.
		if (typeof options.plan.history?.batch !== "function") yield* historyBatch()
		const retention = options.plan.retention
		const retentionEvery = retention?.everyBlocks ?? 64
		const retentionEverySeconds = retention?.everySeconds ?? 60
		if (!Number.isSafeInteger(definition.version) || definition.version < 1 || definition.name.length === 0 || sources.size === 0 ||
			(options.plan.live === undefined && options.plan.history === undefined) ||
			(options.plan.history?.maxLiveLagBlocks !== undefined && options.plan.history.maxLiveLagBlocks < 0n) ||
			(retention !== undefined && retention.blocks === undefined && retention.seconds === undefined) ||
			(retention?.blocks !== undefined && retention.blocks < 1n) || (retention?.seconds !== undefined && retention.seconds < 1n) ||
			!Number.isSafeInteger(retentionEvery) || retentionEvery < 1 || !Number.isSafeInteger(retentionEverySeconds) || retentionEverySeconds < 1 ||
			(typeof options.plan.history?.from === "bigint" && (options.plan.history.from < 0n || (options.plan.history.through !== undefined && options.plan.history.through < options.plan.history.from)))) return yield* Effect.fail(modelFailure("definition", "Invalid definition or plan"))
		const lifetime = yield* makeLifetime
		const store = options.store ?? memoryModelStore()
		const lock = yield* Semaphore.make(1)
		const status = yield* SubscriptionRef.make<ModelStatus>({ live: "idle", head: null, applied: null,
			history: options.plan.history === undefined ? "disabled" : "resolving", coverage: [], error: null })
		const updates = yield* PubSub.unbounded<ProjectionRow | { readonly reset: IndexedBlock }>()
		const sourceUpdates = yield* PubSub.unbounded<ModelBatch | { readonly revert: bigint }>()
		const rawUpdates = yield* PubSub.bounded<BlockLogBatch | { readonly revert: bigint }>(2048)
		let running = false
		let applied: IndexedBlock | null = null
		let head: IndexedBlock | null = null
		let rawApplied: IndexedBlock | null = null
		const rawRecent = new Map<bigint, IndexedBlock>()
		let coverage: readonly BlockRange[] = []
		let origin: bigint | null = null
		let liveHistoryThrough: bigint | null = null
		const livePartitionFrom = new Map<string, bigint>()
		const livePartitionPredecessor = new Map<string, IndexedBlock>()
		let revision = 0
		const current = new Map<string, ProjectionRow>()
		const volatile = new Map<string, ProjectionRow>()
		const partitionBatches = new Map<string, Map<bigint, ModelBatch>>()
		const completedPartitions = new Map<string, Set<string>>()
		let lastRetentionBlock: bigint | null = null
		let lastRetentionAt = 0
		let retentionBoundaryCache: { readonly number: bigint; readonly hash: string;
			readonly value: { readonly historyFrom: bigint; readonly storeFrom: bigint; readonly fromTime: bigint } } | null = null
		const publishStatus = (patch: Partial<ModelStatus>) => SubscriptionRef.update(status, (value) => ({ ...value, head, applied, coverage, ...patch }))
		const capture = (batch: BlockLogBatch, range?: SourceCaptureContext["range"]): Effect.Effect<ModelBatch, ModelFailure> => Effect.gen(function* () {
			const keys = new Set<string>()
			for (const log of batch.logs) {
				if (log.blockHash !== batch.block.hash || log.blockNumber !== batch.block.number || log.logIndex === undefined || log.transactionIndex === undefined || log.removed === true)
					return yield* Effect.fail(modelFailure("chain", "Logs do not match the block"))
				const key = `${log.transactionHash}:${String(log.logIndex)}`
				if (keys.has(key)) return yield* Effect.fail(modelFailure("chain", "Duplicate log"))
				keys.add(key)
			}
			const logs = [...batch.logs].sort((a, b) => (a.logIndex ?? 0n) < (b.logIndex ?? 0n) ? -1 : 1)
			const entries = yield* Effect.forEach([...sources], ([name, source]) => source.capture(logs, header(batch.block), range).pipe(Effect.map((events): readonly [string, readonly unknown[]] => [name, events])))
			return { block: header(batch.block), sources: Object.fromEntries(entries) }
		})
		const fetchBatch = (number: bigint): Effect.Effect<ModelBatch, ModelFailure> => Effect.gen(function* () {
			const block = yield* blockAt(options.client, number)
			const groups = yield* Effect.forEach([...sources.values()], (source) => options.client.fetchOne({ method: "eth_getLogs", params: [{ ...source.filter, blockHash: block.hash }] }).pipe(Effect.mapError((cause) => modelFailure("source", cause))), { concurrency: 2 })
			const logs = new Map(groups.flat().map((log) => [`${log.transactionHash}:${String(log.logIndex)}`, log]))
			return yield* capture({ block: { ...block, logsBloom: "0x" }, observedAt: Date.now(), logs: [...logs.values()] })
		})
		const rpcHistory = new RpcHistory(options.client)
		const onlySource = sources.size === 1 ? [...sources.values()][0] : undefined
		const rawFilter = onlySource?.filter ?? {}
		const fetchRawBatch = (number: bigint): Effect.Effect<BlockLogBatch, ModelFailure> => Effect.gen(function* () {
			const block = yield* blockAt(options.client, number)
			const logs = yield* options.client.fetchOne({ method: "eth_getLogs", params: [{ ...rawFilter, blockHash: block.hash }] }).pipe(
				Effect.mapError((cause) => modelFailure("source", cause)))
			if (logs.some((log) => log.blockHash !== block.hash || log.blockNumber !== block.number || log.removed === true || log.logIndex === undefined || log.transactionIndex === undefined))
				return yield* Effect.fail(modelFailure("chain", "Raw logs do not match the canonical block"))
			return { block: { ...block, logsBloom: "0x" }, observedAt: Date.now(), logs }
		})
		const sourceFilters = [...new Map([...sources.values()].map((source) => [canonical(source.filter), source.filter])).values()]
		const fetchRangePage = (from: bigint, through: bigint, pageLogs: readonly RpcLog[]): Effect.Effect<readonly ModelBatch[], ModelFailure> => Effect.gen(function* () {
			const numbers = [...new Set([from, through, ...pageLogs.flatMap((log) => log.blockNumber === undefined ? [] : [log.blockNumber])])].sort((a, b) => a < b ? -1 : 1)
			const blocks = yield* Effect.forEach(numbers, (number) => blockAt(options.client, number), { concurrency: 8 })
			const headers = new Map(blocks.map((block) => [block.number, header(block)]))
			const logsByBlock = new Map<bigint, Map<string, RpcLog>>()
			for (const log of pageLogs) {
				if (log.blockNumber === undefined || log.blockHash === undefined || log.logIndex === undefined) return yield* Effect.fail(modelFailure("chain", "Historical log is incomplete"))
				const block = headers.get(log.blockNumber)
				if (block === undefined || log.blockHash !== block.hash || log.removed === true) return yield* Effect.fail(modelFailure("chain", "Historical logs do not match canonical headers"))
				const logs = logsByBlock.get(log.blockNumber) ?? new Map<string, RpcLog>()
				logs.set(`${log.transactionHash}:${log.logIndex.toString()}`, log)
				logsByBlock.set(log.blockNumber, logs)
			}
			const rangeLogs = [...logsByBlock.values()].flatMap((logs) => [...logs.values()]).sort((left, right) => left.blockNumber === right.blockNumber
				? (left.logIndex ?? 0n) < (right.logIndex ?? 0n) ? -1 : 1 : (left.blockNumber ?? 0n) < (right.blockNumber ?? 0n) ? -1 : 1)
			const rangeFrom = headers.get(from)
			const rangeThrough = headers.get(through)
			if (rangeFrom === undefined || rangeThrough === undefined) return yield* Effect.fail(modelFailure("source", "Historical range boundaries are unavailable"))
			const range = { from: rangeFrom, through: rangeThrough, logs: rangeLogs }
			return yield* Effect.forEach([...headers.values()], (block) => capture({ block: { ...block, logsBloom: "0x" }, observedAt: Date.now(), logs: [...(logsByBlock.get(block.number)?.values() ?? [])] }, range), { concurrency: 4 })
		})
		const fetchRange = (from: bigint, through: bigint, direction: "forward" | "backward", batchSize = Number(through - from + 1n), concurrency = 1): Stream.Stream<readonly ModelBatch[], ModelFailure> => {
			const primary = sourceFilters[0] ?? {}
			return rpcHistory.streamLogPages({ fromBlock: from, toBlock: through, filter: primary,
				chunkSize: BigInt(batchSize), concurrency, direction }).pipe(
				Stream.mapError((cause) => modelFailure("source", cause)),
				Stream.mapEffect((page) => Effect.gen(function* () {
					const additional = yield* Effect.forEach(sourceFilters.slice(1), (filter) => rpcHistory.getLogs({
						fromBlock: page.fromBlock, toBlock: page.toBlock, filter, chunkSize: page.toBlock - page.fromBlock + 1n, concurrency: 1,
					}).pipe(Effect.mapError((cause) => modelFailure("source", cause))), { concurrency: 2 })
					return { ...page, logs: [page.logs, ...additional].flat() }
				})),
				Stream.flatMap((page) => {
					const eventBlocks = [...new Set(page.logs.map((log) => log.blockNumber))].sort((left, right) => left < right ? -1 : 1)
					const chunks: Array<{ readonly from: bigint; readonly through: bigint }> = []
					if (direction === "forward") {
						let from = page.fromBlock
						for (let index = 0; index < eventBlocks.length; index += 62) {
							const next = eventBlocks[index + 62]
							const through = next === undefined ? page.toBlock : next - 1n
							chunks.push({ from, through }); from = through + 1n
						}
						if (chunks.length === 0) chunks.push({ from: page.fromBlock, through: page.toBlock })
					} else {
						const descending = [...eventBlocks].reverse()
						let through = page.toBlock
						for (let index = 0; index < descending.length; index += 62) {
							const next = descending[index + 62]
							const from = next === undefined ? page.fromBlock : next + 1n
							chunks.push({ from, through }); through = from - 1n
						}
						if (chunks.length === 0) chunks.push({ from: page.fromBlock, through: page.toBlock })
					}
					return Stream.fromIterable(chunks).pipe(Stream.mapEffect((chunk) => Effect.gen(function* () {
						// Yield between processing chunks, not only after the entire request window.
						const maximumLag = options.plan.history?.maxLiveLagBlocks
						while (options.plan.live !== undefined && maximumLag !== undefined && head !== null && applied !== null && head.number - applied.number > maximumLag) yield* Effect.sleep(100)
						return yield* fetchRangePage(chunk.from, chunk.through,
							page.logs.filter((log) => log.blockNumber >= chunk.from && log.blockNumber <= chunk.through))
					})))
				}, { concurrency: 1 }))
		}

		const retentionBoundary = (block: IndexedBlock): Effect.Effect<{ readonly historyFrom: bigint; readonly storeFrom: bigint; readonly fromTime: bigint }, ModelFailure> => Effect.gen(function* () {
			if (retentionBoundaryCache?.number === block.number && retentionBoundaryCache.hash === block.hash) return retentionBoundaryCache.value
			let historyFrom = options.plan.history?.from === "origin" ? 0n : options.plan.history?.from ?? 0n
			if (retention?.blocks !== undefined) {
				const firstRetained = block.number >= retention.blocks ? block.number - retention.blocks + 1n : 0n
				const byBlocks = firstRetained > 0n ? firstRetained - 1n : 0n
				if (byBlocks > historyFrom) historyFrom = byBlocks
			}
			if (retention?.seconds !== undefined) {
				const target = block.timestamp > retention.seconds ? block.timestamp - retention.seconds : 0n
				let low = 0n
				let high = block.number
				while (low < high) {
					const middle = (low + high) / 2n
					if ((yield* blockAt(options.client, middle)).timestamp < target) low = middle + 1n
					else high = middle
				}
				const byTime = low > 0n ? low - 1n : 0n
				if (byTime > historyFrom) historyFrom = byTime
			}
			const recoveryFrom = block.number > 128n ? block.number - 128n : 0n
			const storeFrom = retention === undefined || historyFrom < recoveryFrom ? historyFrom : recoveryFrom
			const boundary = yield* blockAt(options.client, historyFrom)
			const value = { historyFrom: storeFrom, storeFrom, fromTime: boundary.timestamp }
			retentionBoundaryCache = { number: block.number, hash: block.hash, value }
			return value
		})
		const applyRetention = (block: IndexedBlock, force = false): Effect.Effect<void, ModelFailure> => Effect.gen(function* () {
			if (retention === undefined || (!force && lastRetentionBlock !== null &&
				(block.number - lastRetentionBlock < BigInt(retentionEvery) || Date.now() - lastRetentionAt < retentionEverySeconds * 1_000))) return
			const retentionRevision = revision
			const boundary = yield* retentionBoundary(block)
			yield* lock.withPermits(1)(Effect.gen(function* () {
				if (revision !== retentionRevision) return
				yield* store.retain(id, { fromBlock: boundary.storeFrom, fromTime: boundary.fromTime })
				for (const [key, row] of volatile) if (row.endTime !== null && row.endTime <= boundary.fromTime) volatile.delete(key)
				for (const key of partitionBatches.keys()) if (BigInt(key.slice(key.lastIndexOf(":") + 1)) < boundary.fromTime) partitionBatches.delete(key)
				for (const keys of completedPartitions.values()) for (const key of keys) if (BigInt(key) < boundary.fromTime) keys.delete(key)
				coverage = yield* store.coverage(id)
				lastRetentionBlock = block.number
				lastRetentionAt = Date.now()
			}))
		})
		const restorePartitions = (progress: IndexedBlock): Effect.Effect<void, ModelFailure> => Effect.gen(function* () {
			const retained = yield* store.batches(id)
			const atTime = (timestamp: bigint): number => {
				let low = 0, high = retained.length
				while (low < high) {
					const middle = Math.floor((low + high) / 2)
					const block = retained[middle]?.block
					if (block !== undefined && block.timestamp < timestamp) low = middle + 1
					else high = middle
				}
				return low
			}
			for (const [name, projection] of entries) {
				if (projection.kind !== "partitioned" || projection.interval === null) continue
				const interval = projection.interval
				const durable = new Set((yield* store.rows(id, name)).map((row) => row.key))
				const periods = new Set(retained.map(({ block }) => block.timestamp / interval * interval))
				for (let index = 1; index < retained.length; index++) {
					const previous = retained[index - 1]?.block
					const next = retained[index]?.block
					if (previous === undefined || next === undefined || !coverage.some((range) => range.from <= previous.number && range.through >= next.number)) continue
					for (let start = previous.timestamp / interval * interval + interval; start < next.timestamp / interval * interval; start += interval) periods.add(start)
				}
				for (const start of periods) {
					const endTime = start + interval
					if (durable.has(start.toString()) || progress.timestamp < endTime) continue
					const first = atTime(start), end = atTime(endTime)
					const before = retained[first - 1]?.block
					const after = retained[end]?.block
					const from = before?.number ?? (retained[first]?.block.number === 0n ? 0n : undefined)
					if (from === undefined || after === undefined || !coverage.some((range) => range.from <= from && range.through >= after.number)) continue
					const value = yield* projection.project(null, { ...readContext(options.client, progress), batches: retained.slice(first, end) })
					const row: ProjectionRow = { projection: name, key: start.toString(), value, block: progress,
						endTime, period: "closed", coverage: "complete" }
					yield* store.commit(id, { batches: [], rows: [row] })
					let keys = completedPartitions.get(name)
					if (keys === undefined) { keys = new Set(); completedPartitions.set(name, keys) }
					keys.add(row.key)
					yield* PubSub.publish(updates, row)
				}
			}
		})
		const seed = (block: IndexedBlock): Effect.Effect<void, ModelFailure> => Effect.gen(function* () {
			const rows = yield* Effect.forEach(entries.filter(([, projection]) => projection.kind === "state"), ([name, projection]) =>
				projection.seed(readContext(options.client, block)).pipe(Effect.map((value): ProjectionRow => ({ projection: name, key: "current", value, block, endTime: null, period: "state", coverage: "complete" }))))
			yield* store.commit(id, { batches: [], rows })
			for (const row of rows) { current.set(row.projection, row); yield* PubSub.publish(updates, row) }
			applied = block
		})
		const commit = (batches: readonly ModelBatch[], live: boolean, expectedRevision = revision, scanned: readonly BlockRange[] = []): Effect.Effect<void, ModelFailure> => lock.withPermits(1)(Effect.gen(function* () {
			const last = batches[batches.length - 1]
			if (last === undefined) return
			if (expectedRevision !== revision) return yield* Effect.fail(modelFailure("chain", "History fetch was invalidated by a reorg"))
			const firstBatch = batches[0]
			if (!live && firstBatch !== undefined) {
				const before = (yield* store.batches(id, { through: firstBatch.block.number - 1n, limit: 1, direction: "backward" }))[0]
				const after = (yield* store.batches(id, { from: last.block.number + 1n, limit: 1 }))[0]
				if ((before?.block.number === firstBatch.block.number - 1n && before.block.hash !== firstBatch.block.parentHash) ||
					(after?.block.number === last.block.number + 1n && after.block.parentHash !== last.block.hash))
					return yield* Effect.fail(modelFailure("chain", "Historical range does not join stored coverage"))
			}
			for (let i = 1; live && i < batches.length; i++) if (batches[i]?.block.parentHash !== batches[i - 1]?.block.hash)
				return yield* Effect.fail(modelFailure("chain", "Discontinuous batch"))
			const progress = live ? last.block : applied ?? last.block
			const nextCoverage = mergeCoverage(coverage, batches, scanned)
			const rows: ProjectionRow[] = []
			const resetProjections = new Set<string>()
			for (const [name, projection] of entries) {
				if (projection.kind === "state") {
					if (!live) continue
					const previous = current.get(name)
					if (previous === undefined) continue
					const value = yield* projection.project(previous.value, { ...readContext(options.client, progress), batches })
					rows.push({ projection: name, key: "current", value, block: progress, endTime: null, period: "state", coverage: "complete" })
					continue
				}
				const interval = projection.interval
				if (interval === null) continue
				const firstIncoming = batches[0]
				const lastIncoming = batches[batches.length - 1]
				const predecessor = firstIncoming !== undefined && firstIncoming.block.number > 0n
					? (yield* store.batches(id, { through: firstIncoming.block.number - 1n, limit: 1, direction: "backward" }))[0] : undefined
				const successor = lastIncoming !== undefined
					? (yield* store.batches(id, { from: lastIncoming.block.number + 1n, limit: 1 }))[0] : undefined
				const joined = [...(predecessor === undefined ? [] : [predecessor]), ...batches, ...(successor === undefined ? [] : [successor])]
				const periods = new Set(batches.map(({ block }) => block.timestamp / interval * interval))
				for (let index = 1; index < joined.length; index++) {
					const previous = joined[index - 1]?.block
					const next = joined[index]?.block
					if (previous === undefined || next === undefined) continue
					for (let start = previous.timestamp / interval * interval + interval; start < next.timestamp / interval * interval; start += interval) periods.add(start)
				}
				if (predecessor !== undefined) periods.add(predecessor.block.timestamp / interval * interval)
				if (successor !== undefined) periods.add(successor.block.timestamp / interval * interval)
				// Empty blocks close the previous open partition too.
				if (live && applied !== null) {
					const previousStart = applied.timestamp / interval * interval
					const currentStart = progress.timestamp / interval * interval
					for (let start = previousStart; start <= currentStart; start += interval) periods.add(start)
				}
				for (const start of periods) {
					const liveFrom = livePartitionFrom.get(name)
					if (completedPartitions.get(name)?.has(start.toString())) continue
					const cacheKey = `${name}:${start.toString()}`
					let combined = partitionBatches.get(cacheKey)
					if (combined === undefined) {
						const saved = yield* store.batches(id, { startTime: start, endTime: start + interval })
						combined = new Map(saved.map((batch) => [batch.block.number, batch]))
						partitionBatches.set(cacheKey, combined)
					}
					for (const batch of batches) if (batch.block.timestamp >= start && batch.block.timestamp < start + interval) combined.set(batch.block.number, batch)
					if (live && liveFrom === undefined) continue
					const ordered = [...combined.values()].sort((a, b) => a.block.number < b.block.number ? -1 : 1)
					const first = ordered[0]
					const end = ordered[ordered.length - 1]
					if (first === undefined || end === undefined) {
						const beforeEmpty = [...joined].reverse().find((batch) => batch.block.timestamp < start)?.block ?? (live ? applied : null)
						const afterEmpty = joined.find((batch) => batch.block.timestamp >= start + interval)?.block
							const closesEmpty = beforeEmpty !== null && afterEmpty !== undefined &&
							beforeEmpty.timestamp < start && afterEmpty.timestamp >= start + interval &&
							(beforeEmpty.number + 1n === afterEmpty.number || nextCoverage.some((range) => range.from <= beforeEmpty.number && range.through >= afterEmpty.number))
						if (!closesEmpty) continue
						const value = yield* projection.project(null, { ...readContext(options.client, progress), batches: [] })
						rows.push({ projection: name, key: start.toString(), value, block: progress, endTime: start + interval, period: "closed", coverage: "complete" })
						continue
					}
					const before = first.block.number === 0n ? null : [...joined].reverse().find((batch) => batch.block.timestamp < start) ??
						(yield* store.batches(id, { through: first.block.number - 1n, limit: 1, direction: "backward" }))[0]
					const liveBoundary = livePartitionPredecessor.get(name)
					const startsCovered = first.block.number === 0n || (origin === first.block.number && (origin === 0n || options.plan.history?.from === "origin")) || (before !== undefined && before !== null && before.block.timestamp < start && nextCoverage.some((range) => range.from <= before.block.number && range.through >= first.block.number)) ||
						(liveBoundary !== undefined && livePartitionFrom.get(name) === start && liveBoundary.timestamp < start) ||
						(live && applied?.number === first.block.number - 1n && applied.timestamp < start)
					const closes = progress.timestamp >= start + interval
					const after = joined.find((batch) => batch.block.timestamp >= start + interval) ?? (yield* store.batches(id, { from: end.block.number + 1n, limit: 1 }))[0]
					const through = closes ? after?.block.number : progress.number
					const complete = startsCovered && through !== undefined && nextCoverage.some((range) => range.from <= first.block.number && range.through >= through) && (!closes || (after !== undefined && after.block.timestamp >= start + interval))
					// A closed partition is observable only after its full source range is present.
					if (closes && !complete) {
						if (volatile.delete(cacheKey)) resetProjections.add(name)
						continue
					}
					// Startup history may cover the current minute, but live views start at the next boundary.
					if (!live && options.plan.live !== undefined && !closes) continue
					const value = yield* projection.project(null, { ...readContext(options.client, progress), batches: ordered })
					rows.push({ projection: name, key: start.toString(), value, block: progress, endTime: start + interval, period: closes ? "closed" : "open", coverage: complete ? "complete" : "partial" })
				}
			}
			const durableRows = rows.filter((row) => row.period === "state" || (row.period === "closed" && row.coverage === "complete" && !completedPartitions.get(row.projection)?.has(row.key)))
			yield* Effect.uninterruptible(store.commit(id, { batches, rows: durableRows, ...(scanned.length === 0 ? {} : { coverage: scanned }) }))
			coverage = nextCoverage
			for (const batch of batches) yield* PubSub.publish(sourceUpdates, batch)
			if (live) applied = last.block
			for (const row of rows) {
				if (row.period === "state") current.set(row.projection, row)
				else if (row.period === "closed" && row.coverage === "complete") {
					volatile.delete(`${row.projection}:${row.key}`)
					partitionBatches.delete(`${row.projection}:${row.key}`)
					let keys = completedPartitions.get(row.projection)
					if (keys === undefined) { keys = new Set(); completedPartitions.set(row.projection, keys) }
					keys.add(row.key)
				}
				else volatile.set(`${row.projection}:${row.key}`, row)
				yield* PubSub.publish(updates, row)
			}
			for (const name of resetProjections) {
				yield* PubSub.publish(updates, { reset: progress })
				for (const row of yield* store.rows(id, name)) yield* PubSub.publish(updates, row)
				for (const row of volatile.values()) if (row.projection === name) yield* PubSub.publish(updates, row)
			}
			yield* publishStatus({ live: options.plan.live === undefined ? "idle" : "following" })
		}))
		const recover = (conflictAt?: bigint): Effect.Effect<void, ModelFailure> => Effect.gen(function* () {
			yield* publishStatus({ live: "recovering" })
			const latest = yield* blockAt(options.client, "latest")
			// Find a canonical ancestor within the retained recent window.
			const ceiling = conflictAt ?? applied?.number ?? latest.number
			const recent = yield* store.batches(id, { from: ceiling > 128n ? ceiling - 128n : 0n, through: ceiling })
			let ancestor: IndexedBlock | null = null
			for (const batch of [...recent].reverse()) {
				if (batch.block.number > latest.number) continue
				const canonicalBlock = yield* blockAt(options.client, batch.block.number)
				if (canonicalBlock.hash === batch.block.hash) { ancestor = batch.block; break }
			}
			if (ancestor === null && recent.length > 0) return yield* Effect.fail(modelFailure("chain", "Reorg exceeds retained recovery window"))
			const forkTime = recent.find((batch) => ancestor === null || batch.block.number > ancestor.number)?.block.timestamp ?? latest.timestamp
			const maxInterval = entries.reduce((max, [, projection]) => projection.interval !== null && projection.interval > max ? projection.interval : max, 1n)
			yield* lock.withPermits(1)(Effect.gen(function* () {
					revision++
					retentionBoundaryCache = null
				yield* Effect.uninterruptible(store.invalidate(id, ancestor === null ? 0n : ancestor.number + 1n))
				yield* PubSub.publish(sourceUpdates, { revert: ancestor === null ? 0n : ancestor.number + 1n })
				yield* PubSub.publish(updates, { reset: latest })
				for (const [name] of entries) {
					for (const row of yield* store.rows(id, name)) yield* PubSub.publish(updates, row)
				}
				coverage = yield* store.coverage(id)
				current.clear()
				volatile.clear()
				partitionBatches.clear()
				completedPartitions.clear()
				livePartitionFrom.clear()
				livePartitionPredecessor.clear()
				liveHistoryThrough = null
				yield* seed(latest)
				if (options.plan.history !== undefined && hasPartitionedProjections) liveHistoryThrough = latest.number
				head = latest
				yield* publishStatus({ live: "following", error: null })
			}))
			const retained = yield* store.batches(id, { startTime: forkTime > maxInterval ? forkTime - maxInterval : 0n })
			if (retained.length > 0) yield* commit(retained, false)
		})
			const activateLivePartitions = (incoming: readonly ModelBatch[]): void => {
				const initial = applied
				if (initial === null) return
				for (const [name, projection] of entries) {
					if (projection.kind !== "partitioned" || projection.interval === null || livePartitionFrom.has(name)) continue
					const interval = projection.interval
					const index = incoming.findIndex((batch) => batch.block.timestamp / interval > initial.timestamp / interval)
					if (index < 0) continue
					const boundary = incoming.at(index)?.block
					if (boundary === undefined) continue
					livePartitionFrom.set(name, boundary.timestamp / interval * interval)
					const predecessor = index === 0 ? initial : incoming.at(index - 1)?.block ?? initial
				livePartitionPredecessor.set(name, predecessor)
				if (liveHistoryThrough === null || predecessor.number > liveHistoryThrough) liveHistoryThrough = predecessor.number
			}
		}
			const liveBatch = (batch: BlockLogBatch): Effect.Effect<void, ModelFailure> => Effect.gen(function* () {
			if (head === null || batch.block.number >= head.number) head = batch.block
			if (applied === null) return
			if (batch.block.number < applied.number) return
			if (batch.block.number === applied.number) { if (batch.block.hash !== applied.hash) yield* recover(); return }
			if (batch.block.number === applied.number + 1n && batch.block.parentHash !== applied.hash) { yield* recover(); return }
			while (applied.number + 1n < batch.block.number) {
				const numbers: bigint[] = []
				for (let n = applied.number + 1n; n < batch.block.number && numbers.length < 8; n++) numbers.push(n)
				const missing = yield* Effect.forEach(numbers, fetchBatch, { concurrency: 4 })
				if (missing[0]?.block.parentHash !== applied.hash) { yield* recover(); return }
				activateLivePartitions(missing)
				yield* commit(missing, true)
			}
			if (batch.block.parentHash !== applied.hash) { yield* recover(); return }
			const captured = yield* capture(batch)
			activateLivePartitions([captured])
				yield* commit([captured], true)
			})
			const liveGroup = (observed: readonly BlockLogBatch[]): Effect.Effect<void, ModelFailure> => Effect.gen(function* () {
				if (applied === null || observed.length < 2) {
					for (const batch of observed) yield* liveBatch(batch)
					return
				}
				let previous = applied
				for (const batch of observed) {
					if (batch.block.number !== previous.number + 1n || batch.block.parentHash !== previous.hash) {
						for (const fallback of observed) yield* liveBatch(fallback)
						return
					}
					previous = header(batch.block)
				}
				const captureRevision = revision
				const captured = yield* Effect.forEach(observed, (batch) => capture(batch), { concurrency: 4 })
				const last = captured.at(-1)
				if (last !== undefined && (yield* blockAt(options.client, last.block.number)).hash !== last.block.hash) {
					yield* recover(last.block.number)
					return
				}
				activateLivePartitions(captured)
				yield* commit(captured, true, captureRevision)
			})
		const publishRaw = (batch: BlockLogBatch): Effect.Effect<void, ModelFailure> => Effect.gen(function* () {
			let previous = rawApplied
			if (previous === null) return
			if (batch.block.number <= previous.number) {
				if (rawRecent.get(batch.block.number)?.hash === batch.block.hash) return
				const ancestor = rawRecent.get(batch.block.number - 1n)
				if (ancestor === undefined || ancestor.hash !== batch.block.parentHash) return
				yield* PubSub.publish(rawUpdates, { revert: batch.block.number })
				for (const number of rawRecent.keys()) if (number >= batch.block.number) rawRecent.delete(number)
				rawApplied = ancestor
				previous = ancestor
			}
			if (batch.block.number > previous.number + 1n) {
				for (let start = previous.number + 1n; start < batch.block.number; start += 32n) {
					const numbers: bigint[] = []
					for (let number = start; number < batch.block.number && number < start + 32n; number++) numbers.push(number)
					const missing = yield* Effect.forEach(numbers, fetchRawBatch, { concurrency: 4 })
					for (const recovered of missing) yield* publishRaw(recovered)
				}
			}
			const parent = rawApplied
			if (parent === null) return
			if (batch.block.number === parent.number) {
				if (batch.block.hash === parent.hash) return
				yield* PubSub.publish(rawUpdates, { revert: batch.block.number })
			} else {
				if (batch.block.number !== parent.number + 1n) return
				if (batch.block.parentHash !== parent.hash) {
					let ancestor: IndexedBlock | null = null
					for (const retained of [...rawRecent.values()].reverse()) {
						if ((yield* blockAt(options.client, retained.number)).hash === retained.hash) { ancestor = retained; break }
					}
					if (ancestor === null) return yield* Effect.fail(modelFailure("chain", "Raw reorg exceeds the retained recovery window"))
					if (ancestor.number === parent.number) return yield* Effect.fail(modelFailure("chain", "Raw live block has a stale canonical parent"))
					yield* PubSub.publish(rawUpdates, { revert: ancestor.number + 1n })
					for (const number of rawRecent.keys()) if (number > ancestor.number) rawRecent.delete(number)
					rawApplied = ancestor
					return yield* publishRaw(batch)
				}
			}
			rawApplied = header(batch.block)
			rawRecent.set(batch.block.number, rawApplied)
			while (rawRecent.size > 128) {
				const oldest = rawRecent.keys().next().value
				if (oldest === undefined) break
				rawRecent.delete(oldest)
			}
			yield* PubSub.publish(rawUpdates, batch)
		})
		const historyStep = (): Effect.Effect<boolean, ModelFailure> => Effect.gen(function* () {
			const plan = options.plan.history
			if (plan === undefined || applied === null) return false
			if (origin === null) {
				if (plan.from === "origin") {
					if (definition.origin === undefined) return yield* Effect.fail(modelFailure("definition", "Definition has no origin resolver"))
					yield* publishStatus({ history: "resolving", error: null })
					const saved = (yield* store.rows(id, "@origin"))[0]
					const resolved = saved !== undefined ? saved.block : yield* definition.origin({ params, client: options.client }).pipe(Effect.mapError((cause) => modelFailure("origin", cause)))
					if ((yield* blockAt(options.client, resolved.number)).hash !== resolved.hash) return yield* Effect.fail(modelFailure("origin", "Stored origin is no longer canonical"))
					yield* store.commit(id, { batches: [], rows: [{ projection: "@origin", key: "origin", value: null, block: resolved, endTime: null, period: "state", coverage: "complete" }] })
					origin = resolved.number
				} else origin = plan.from
				if (origin < 0n) return yield* Effect.fail(modelFailure("definition", "Origin must be non-negative"))
			}
			const boundary = yield* retentionBoundary(applied)
			const requestedFrom = origin > boundary.historyFrom ? origin : boundary.historyFrom
			const through = plan.through ?? (options.plan.live !== undefined && hasPartitionedProjections ? liveHistoryThrough ?? -1n : applied.number)
			if (through < requestedFrom) { yield* publishStatus({ history: "complete", error: null }); return false }
			const batch = yield* historyBatch()
			const windowSize = batch.size * batch.concurrency
			const range = options.plan.history?.direction === "forward"
				? missingForwardRange(coverage, requestedFrom, through, windowSize)
				: missingRange(coverage, requestedFrom, through, windowSize)
			if (range === null) { yield* publishStatus({ history: "complete", error: null }); return false }
			yield* publishStatus({ history: "backfilling", error: null })
			const fetchRevision = revision
			yield* fetchRange(range.from, range.through, plan.direction === "forward" ? "forward" : "backward", batch.size, batch.concurrency).pipe(Stream.runForEach((batches) => Effect.gen(function* () {
				const last = batches[batches.length - 1]
				if (last !== undefined && (yield* blockAt(options.client, last.block.number)).hash !== last.block.hash)
					return yield* Effect.fail(modelFailure("chain", "Historical range changed during fetch"))
				yield* commit(batches, false, fetchRevision, [{ from: batches[0]?.block.number ?? range.from, through: batches[batches.length - 1]?.block.number ?? range.through }])
			})))
			return true
		})
		const run = (): Effect.Effect<void, ModelFailure, Scope.Scope> => lifetime.run(Effect.suspend(() => {
			if (running) return Effect.fail(modelFailure("running", "Instance is already running"))
			running = true
			return Effect.scoped(Effect.gen(function* () {
				yield* Effect.acquireRelease(store.claim(id), (release) => Effect.sync(release))
				// Remove rows written by older versions that exposed unfinished partitions.
				let hasLegacyPartitions = false
				for (const [name, projection] of entries) if (projection.kind === "partitioned" &&
					(yield* store.rows(id, name)).some((row) => row.period !== "closed" || row.coverage !== "complete")) hasLegacyPartitions = true
				if (hasLegacyPartitions) yield* store.retain(id, { fromBlock: 0n, fromTime: 0n })
				coverage = yield* store.coverage(id)
				for (const [name, projection] of entries) if (projection.kind === "partitioned")
					completedPartitions.set(name, new Set((yield* store.rows(id, name)).filter((row) => row.period === "closed" && row.coverage === "complete").map((row) => row.key)))
				yield* publishStatus({ live: "starting", error: null })
				const queue = yield* Queue.bounded<BlockLogBatch>(2048)
				head = yield* blockAt(options.client, "latest")
				const startupHead = head
				rawApplied = startupHead
				rawRecent.set(startupHead.number, startupHead)
				const liveLogs = options.plan.live === undefined ? Effect.never : options.client.watchLogBlocks(rawFilter).pipe(
					Stream.runForEach((batch) => Effect.sync(() => { if (head === null || batch.block.number >= head.number) head = batch.block })
						.pipe(Effect.andThen(publishRaw(batch).pipe(Effect.retry({ times: 3, schedule: Schedule.exponential(100), while: (error) => error.stage === "source" }))), Effect.andThen(Queue.offer(queue, batch)))))
				if (options.plan.live !== undefined) yield* options.client.watchBlocks().pipe(Stream.runForEach((block) => Effect.gen(function* () {
					if (block.hash !== null && block.parentHash !== null && block.timestamp !== null && (head === null || block.number >= head.number)) {
						head = { number: block.number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp }
						yield* publishStatus({})
					}
				})), Effect.forkScoped)
				// Resume only when all state projections share one canonical checkpoint.
				let resumed: IndexedBlock | null = null
				if (options.plan.live?.start === "checkpoint") {
					for (const [name, projection] of entries) {
						if (projection.kind !== "state") continue
						const row = (yield* store.rows(id, name))[0]
						if (row === undefined || (resumed !== null && resumed.hash !== row.block.hash)) { current.clear(); resumed = null; break }
						current.set(name, row); resumed = row.block
					}
					if (resumed !== null && (yield* blockAt(options.client, resumed.number)).hash !== resumed.hash) { current.clear(); resumed = null }
				}
				if (resumed !== null) applied = resumed
				else yield* seed(startupHead)
				if (options.plan.live !== undefined && options.plan.history !== undefined && hasPartitionedProjections) liveHistoryThrough = startupHead.number
				yield* restorePartitions(applied ?? startupHead)
				// Validate the most recent persisted coverage after downtime.
				for (const range of coverage) {
					const old = (yield* store.batches(id, { from: range.through, through: range.through }))[0]
					if (old !== undefined && (yield* blockAt(options.client, old.block.number)).hash !== old.block.hash) {
						revision++
						retentionBoundaryCache = null
						yield* store.invalidate(id, range.from)
						coverage = yield* store.coverage(id)
						current.clear(); volatile.clear(); partitionBatches.clear(); completedPartitions.clear()
						yield* seed(startupHead)
						for (const [name, projection] of entries) if (projection.kind === "partitioned")
							completedPartitions.set(name, new Set((yield* store.rows(id, name)).filter((row) => row.period === "closed" && row.coverage === "complete").map((row) => row.key)))
						break
					}
				}
				yield* publishStatus({ live: options.plan.live === undefined ? "idle" : "following" })
				const history = Effect.gen(function* () {
					if (options.plan.history === undefined) return yield* Effect.never
					yield* applyRetention(startupHead, true)
					for (;;) {
						if (options.plan.history.maxLiveLagBlocks !== undefined && head !== null && applied !== null && head.number - applied.number > options.plan.history.maxLiveLagBlocks) { yield* Effect.sleep(100); continue }
						const worked = yield* historyStep().pipe(Effect.catch((error) => publishStatus({ history: "blocked", error }).pipe(Effect.flatMap(() => options.plan.live === undefined ? Effect.fail(error) : (error.stage === "source" || error.stage === "chain") ? Effect.succeed(false) : Effect.never))))
						if (options.plan.live === undefined && !worked) return
						yield* Effect.sleep(100)
					}
				})
					const maintenance = retention === undefined ? Effect.never : Effect.gen(function* () {
						if (options.plan.history === undefined) yield* applyRetention(startupHead, true).pipe(Effect.catch((error) => publishStatus({ error })))
						for (;;) {
							yield* Effect.sleep(5_000)
							const progress = applied
							if (progress !== null) yield* applyRetention(progress).pipe(Effect.catch((error) => publishStatus({ error })))
						}
					})
					if (options.plan.live === undefined) yield* history
					else yield* Effect.all([
						history,
						liveLogs,
						maintenance,
						Effect.forever(Effect.gen(function* () {
							const pending = yield* Queue.takeBetween(queue, 1, 32)
							yield* liveGroup(pending).pipe(
								Effect.retry({ times: 3, schedule: Schedule.exponential(100), while: (error) => error.stage === "source" }))
						})),
				], { concurrency: "unbounded", discard: true })
			})).pipe(Effect.tapCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.void : publishStatus({ live: "failed", error: modelFailure("running", cause) })), Effect.ensuring(Effect.sync(() => { running = false })))
		}))
		// The projection's own decoder preserves each named output type.
		const decodeRow = <A>(projection: Projection<A>, row: ProjectionRow): Effect.Effect<ProjectionUpdate<A>, ModelFailure> =>
			projection.decode(row.value).pipe(Effect.map((value) => ({ kind: "upsert", key: row.key, value, block: row.block, period: row.period, coverage: row.coverage })))
		return {
			id, run, get isClosed() { return lifetime.isClosed },
			close: () => lifetime.close.pipe(Effect.andThen(publishStatus({ live: "closed" }))),
			status: SubscriptionRef.get(status).pipe(Effect.map((value) => lifetime.isClosed ? { ...value, live: "closed" } : value)),
			watchStatus: () => lifetime.watch(SubscriptionRef.changes(status)),
			watchSource: <A>(source: LogSource<A>): Stream.Stream<SourceUpdate<A>, ModelFailure> => {
				const configured = sources.get(source.name)
				if (configured === undefined || canonical(configured.filter) !== canonical(source.filter)) return Stream.fail(modelFailure("definition", "Source does not belong to this instance"))
				return lifetime.watch(Stream.fromPubSub(sourceUpdates).pipe(Stream.mapEffect((value): Effect.Effect<SourceUpdate<A>, ModelFailure> =>
					"revert" in value ? Effect.succeed({ kind: "revert", from: value.revert }) : source.decode(value.sources[source.name] ?? []).pipe(Effect.map((events) => ({ kind: "apply", block: value.block, events }))))))
			},
			watchLogs: (source): Stream.Stream<RawSourceUpdate, ModelFailure> => {
				const configured = sources.get(source.name)
				if (configured === undefined || canonical(configured.filter) !== canonical(source.filter)) return Stream.fail(modelFailure("definition", "Source does not belong to this instance"))
				return lifetime.watch(Stream.fromPubSub(rawUpdates).pipe(Stream.map((value): RawSourceUpdate => "revert" in value
					? { kind: "revert", from: value.revert }
					: { kind: "apply", block: header(value.block), logs: value.logs.filter((log) => matchesLog(log, source.filter)) })))
			},
			read: (name) => {
				const projection = projections[name]
				if (!(name in projections)) return Effect.fail(modelFailure("definition", "Unknown projection"))
				return store.rows(id, name).pipe(Effect.flatMap((rows) => {
					const partitioned = projection.kind === "partitioned"
					const combined = new Map(rows.filter((row) => !partitioned || (row.period === "closed" && row.coverage === "complete")).map((row) => [row.key, row]))
					for (const row of volatile.values()) if (row.projection === name && (!partitioned || (row.period === "open" && (applied === null || row.endTime === null || row.endTime > applied.timestamp)))) combined.set(row.key, row)
					return Effect.forEach([...combined.values()], (row) => decodeRow(projection, row))
				}))
			},
			watch: (name) => {
				const projection = projections[name]
				if (!(name in projections)) return Stream.fail(modelFailure("definition", "Unknown projection"))
				return lifetime.watch(Stream.fromPubSub(updates).pipe(Stream.filter((row): row is ProjectionRow | { readonly reset: IndexedBlock } => "reset" in row || row.projection === name), Stream.mapEffect((row) => "reset" in row ? Effect.succeed({ kind: "reset", key: "", value: null, block: row.reset, period: "state", coverage: "partial" } satisfies ProjectionUpdate<Outputs[typeof name]>) : decodeRow(projection, row))))
			},
		}
	}),
})
