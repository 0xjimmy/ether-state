import { Cause, Effect, Queue, Schedule, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import { makeLifetime } from "../internal/lifetime.js"
import type { Scope } from "effect"
import type { EvmClient } from "../rpc/client.js"
import type { BlockLogBatch } from "../rpc/watch.js"
import type { IndexedBlock } from "./index.js"
import { readContext, type LogSource, type Projection } from "./model-definition.js"
import { memoryModelStore, missingRange, missingForwardRange, modelFailure, type BlockRange, type ModelBatch, type ModelFailure,
	type ModelStore, type ProjectionRow } from "./model-store.js"

export interface ModelPlan {
	readonly live?: { readonly start: "head" | "checkpoint" }
	readonly history?: { readonly from: bigint | "origin"; readonly through?: bigint; readonly batchSize?: number; readonly direction?: "forward" | "backward"; readonly maxLiveLagBlocks?: bigint }
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
const mergeCoverage = (ranges: readonly BlockRange[], batches: readonly ModelBatch[]): readonly BlockRange[] => {
	const all = [...ranges, ...batches.map(({ block }) => ({ from: block.number, through: block.number }))].sort((a, b) => a.from < b.from ? -1 : 1)
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
		const size = options.plan.history?.batchSize ?? 16
		if (!Number.isSafeInteger(size) || size < 1 || size > 256 || !Number.isSafeInteger(definition.version) || definition.version < 1 || definition.name.length === 0 || sources.size === 0 ||
			(options.plan.live === undefined && options.plan.history === undefined) ||
			(options.plan.history?.maxLiveLagBlocks !== undefined && options.plan.history.maxLiveLagBlocks < 0n) ||
			(typeof options.plan.history?.from === "bigint" && (options.plan.history.from < 0n || (options.plan.history.through !== undefined && options.plan.history.through < options.plan.history.from)))) return yield* Effect.fail(modelFailure("definition", "Invalid definition or plan"))
		const lifetime = yield* makeLifetime
		const store = options.store ?? memoryModelStore()
		const lock = yield* Semaphore.make(1)
		const status = yield* SubscriptionRef.make<ModelStatus>({ live: "idle", head: null, applied: null,
			history: options.plan.history === undefined ? "disabled" : "resolving", coverage: [], error: null })
		const updates = yield* SubscriptionRef.make<ProjectionRow | { readonly reset: IndexedBlock } | null>(null)
		const sourceUpdates = yield* SubscriptionRef.make<ModelBatch | { readonly revert: bigint } | null>(null)
		let running = false
		let applied: IndexedBlock | null = null
		let head: IndexedBlock | null = null
		let coverage: readonly BlockRange[] = []
		let origin: bigint | null = null
		let revision = 0
		const current = new Map<string, ProjectionRow>()
		const publishStatus = (patch: Partial<ModelStatus>) => SubscriptionRef.update(status, (value) => ({ ...value, head, applied, coverage, ...patch }))
		const capture = (batch: BlockLogBatch): Effect.Effect<ModelBatch, ModelFailure> => Effect.gen(function* () {
			const keys = new Set<string>()
			for (const log of batch.logs) {
				if (log.blockHash !== batch.block.hash || log.blockNumber !== batch.block.number || log.logIndex === undefined || log.transactionIndex === undefined || log.removed === true)
					return yield* Effect.fail(modelFailure("chain", "Logs do not match the block"))
				const key = `${log.transactionHash}:${String(log.logIndex)}`
				if (keys.has(key)) return yield* Effect.fail(modelFailure("chain", "Duplicate log"))
				keys.add(key)
			}
			const logs = [...batch.logs].sort((a, b) => (a.logIndex ?? 0n) < (b.logIndex ?? 0n) ? -1 : 1)
			const entries = yield* Effect.forEach([...sources], ([name, source]) => source.capture(logs).pipe(Effect.map((events): readonly [string, readonly unknown[]] => [name, events])))
			return { block: header(batch.block), sources: Object.fromEntries(entries) }
		})
		const fetchBatch = (number: bigint): Effect.Effect<ModelBatch, ModelFailure> => Effect.gen(function* () {
			const block = yield* blockAt(options.client, number)
			const groups = yield* Effect.forEach([...sources.values()], (source) => options.client.fetchOne({ method: "eth_getLogs", params: [{ ...source.filter, blockHash: block.hash }] }).pipe(Effect.mapError((cause) => modelFailure("source", cause))), { concurrency: 2 })
			const logs = new Map(groups.flat().map((log) => [`${log.transactionHash}:${String(log.logIndex)}`, log]))
			return yield* capture({ block: { ...block, logsBloom: "0x" }, observedAt: Date.now(), logs: [...logs.values()] })
		})
		const seed = (block: IndexedBlock): Effect.Effect<void, ModelFailure> => Effect.gen(function* () {
			const rows = yield* Effect.forEach(entries.filter(([, projection]) => projection.kind === "state"), ([name, projection]) =>
				projection.seed(readContext(options.client, block)).pipe(Effect.map((value): ProjectionRow => ({ projection: name, key: "current", value, block, endTime: null, period: "state", coverage: "complete" }))))
			yield* store.commit(id, { batches: [], rows })
			for (const row of rows) { current.set(row.projection, row); yield* SubscriptionRef.set(updates, row) }
			applied = block
		})
		const commit = (batches: readonly ModelBatch[], live: boolean, expectedRevision = revision): Effect.Effect<void, ModelFailure> => lock.withPermits(1)(Effect.gen(function* () {
			const last = batches[batches.length - 1]
			if (last === undefined) return
			if (expectedRevision !== revision) return yield* Effect.fail(modelFailure("chain", "History fetch was invalidated by a reorg"))
			const firstBatch = batches[0]
			if (!live && firstBatch !== undefined) {
				const before = (yield* store.batches(id, { from: firstBatch.block.number - 1n, through: firstBatch.block.number - 1n }))[0]
				const after = (yield* store.batches(id, { from: last.block.number + 1n, through: last.block.number + 1n }))[0]
				if ((before !== undefined && before.block.hash !== firstBatch.block.parentHash) || (after !== undefined && after.block.parentHash !== last.block.hash))
					return yield* Effect.fail(modelFailure("chain", "Historical range does not join stored coverage"))
			}
			for (let i = 1; i < batches.length; i++) if (batches[i]?.block.parentHash !== batches[i - 1]?.block.hash)
				return yield* Effect.fail(modelFailure("chain", "Discontinuous batch"))
			const progress = live ? last.block : applied ?? last.block
			const nextCoverage = mergeCoverage(coverage, batches)
			const rows: ProjectionRow[] = []
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
				const periods = new Set(batches.map(({ block }) => block.timestamp / interval * interval))
				const firstBatch = batches[0]
				if (firstBatch !== undefined && firstBatch.block.number > 0n) {
					const predecessor = (yield* store.batches(id, { from: firstBatch.block.number - 1n, through: firstBatch.block.number - 1n }))[0]
					if (predecessor !== undefined) periods.add(predecessor.block.timestamp / interval * interval)
				}
				// Empty blocks close the previous open partition too.
				if (live && applied !== null) periods.add(applied.timestamp / interval * interval)
				for (const start of periods) {
					const saved = yield* store.batches(id, { startTime: start, endTime: start + interval })
					const combined = new Map(saved.map((batch) => [batch.block.number, batch]))
					for (const batch of batches) if (batch.block.timestamp >= start && batch.block.timestamp < start + interval) combined.set(batch.block.number, batch)
					const ordered = [...combined.values()].sort((a, b) => a.block.number < b.block.number ? -1 : 1)
					const first = ordered[0]
					const end = ordered[ordered.length - 1]
					if (first === undefined || end === undefined) continue
					const before = first.block.number === 0n ? null : batches.find((batch) => batch.block.number === first.block.number - 1n) ?? (yield* store.batches(id, { from: first.block.number - 1n, through: first.block.number - 1n }))[0]
					const startsCovered = (origin === first.block.number && (origin === 0n || options.plan.history?.from === "origin")) || (before !== undefined && before !== null && before.block.timestamp < start)
					const closes = progress.timestamp >= start + interval
					const after = batches.find((batch) => batch.block.number === end.block.number + 1n) ?? (yield* store.batches(id, { from: end.block.number + 1n, through: end.block.number + 1n }))[0]
					const through = closes ? after?.block.number : progress.number
					const complete = startsCovered && through !== undefined && nextCoverage.some((range) => range.from <= first.block.number && range.through >= through) && (!closes || (after !== undefined && after.block.timestamp >= start + interval))
					const value = yield* projection.project(null, { ...readContext(options.client, progress), batches: ordered })
					rows.push({ projection: name, key: start.toString(), value, block: progress, endTime: start + interval, period: closes ? "closed" : "open", coverage: complete ? "complete" : "partial" })
				}
			}
			yield* Effect.uninterruptible(store.commit(id, { batches, rows }))
			coverage = nextCoverage
			for (const batch of batches) yield* SubscriptionRef.set(sourceUpdates, batch)
			if (live) applied = last.block
			for (const row of rows) { if (row.period === "state") current.set(row.projection, row); yield* SubscriptionRef.set(updates, row) }
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
				yield* Effect.uninterruptible(store.invalidate(id, ancestor === null ? 0n : ancestor.number + 1n))
				yield* SubscriptionRef.set(sourceUpdates, { revert: ancestor === null ? 0n : ancestor.number + 1n })
				yield* SubscriptionRef.set(updates, { reset: latest })
				for (const [name] of entries) {
					for (const row of yield* store.rows(id, name)) yield* SubscriptionRef.set(updates, row)
				}
				coverage = yield* store.coverage(id)
				current.clear()
				yield* seed(latest)
				head = latest
				yield* publishStatus({ live: "following", error: null })
			}))
			const retained = yield* store.batches(id, { startTime: forkTime > maxInterval ? forkTime - maxInterval : 0n })
			if (retained.length > 0) yield* commit(retained, false)
		})
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
				yield* commit(missing, true)
			}
			if (batch.block.parentHash !== applied.hash) { yield* recover(); return }
			yield* commit([yield* capture(batch)], true)
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
			const through = plan.through ?? applied.number
			const range = options.plan.history?.direction === "forward"
				? missingForwardRange(coverage, origin, through, size)
				: missingRange(coverage, origin, through, size)
			if (range === null) { yield* publishStatus({ history: "complete", error: null }); return false }
			yield* publishStatus({ history: "backfilling", error: null })
			const numbers: bigint[] = []
			for (let n = range.from; n <= range.through; n++) numbers.push(n)
			const fetchRevision = revision
			const batches = yield* Effect.forEach(numbers, fetchBatch, { concurrency: 2 })
			// Check the window's final hash again before accepting historical coverage.
			const last = batches[batches.length - 1]
			if (last !== undefined && (yield* blockAt(options.client, last.block.number)).hash !== last.block.hash)
				return yield* Effect.fail(modelFailure("chain", "Historical range changed during fetch"))
			yield* commit(batches, false, fetchRevision)
			return true
		})
		const run = (): Effect.Effect<void, ModelFailure, Scope.Scope> => lifetime.run(Effect.suspend(() => {
			if (running) return Effect.fail(modelFailure("running", "Instance is already running"))
			running = true
			return Effect.scoped(Effect.gen(function* () {
				yield* Effect.acquireRelease(store.claim(id), (release) => Effect.sync(release))
				coverage = yield* store.coverage(id)
				yield* publishStatus({ live: "starting", error: null })
				const queue = yield* Queue.bounded<BlockLogBatch>(2048)
				if (options.plan.live !== undefined) yield* options.client.watchLogBlocks().pipe(Stream.runForEach((batch) => Effect.sync(() => { if (head === null || batch.block.number >= head.number) head = batch.block }).pipe(Effect.andThen(Queue.offer(queue, batch)))), Effect.forkScoped)
				head = yield* blockAt(options.client, "latest")
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
				else yield* seed(head)
				// Validate the most recent persisted coverage after downtime.
				for (const range of coverage) {
					const old = (yield* store.batches(id, { from: range.through, through: range.through }))[0]
					if (old !== undefined && (yield* blockAt(options.client, old.block.number)).hash !== old.block.hash) { yield* recover(range.through); break }
				}
				yield* publishStatus({ live: options.plan.live === undefined ? "idle" : "following" })
				const history = Effect.gen(function* () {
					if (options.plan.history === undefined) return yield* Effect.never
					for (;;) {
						if (head !== null && applied !== null && head.number - applied.number > (options.plan.history.maxLiveLagBlocks ?? 8n)) { yield* Effect.sleep(100); continue }
						const worked = yield* historyStep().pipe(Effect.catch((error) => publishStatus({ history: "blocked", error }).pipe(Effect.flatMap(() => options.plan.live === undefined ? Effect.fail(error) : (error.stage === "source" || error.stage === "chain") ? Effect.succeed(false) : Effect.never))))
						if (options.plan.live === undefined && !worked) return
						yield* Effect.sleep(worked ? 100 : 5_000)
					}
				})
				if (options.plan.live === undefined) yield* history
				else yield* Effect.all([history, Effect.forever(Queue.take(queue).pipe(Effect.flatMap((batch) => liveBatch(batch).pipe(Effect.retry({ times: 3, schedule: Schedule.exponential(100), while: (error) => error.stage === "source" })))))], { concurrency: "unbounded", discard: true })
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
				return lifetime.watch(SubscriptionRef.changes(sourceUpdates).pipe(Stream.filter((value) => value !== null), Stream.mapEffect((value): Effect.Effect<SourceUpdate<A>, ModelFailure> =>
					"revert" in value ? Effect.succeed({ kind: "revert", from: value.revert }) : source.decode(value.sources[source.name] ?? []).pipe(Effect.map((events) => ({ kind: "apply", block: value.block, events }))))))
			},
			read: (name) => {
				const projection = projections[name]
				if (!(name in projections)) return Effect.fail(modelFailure("definition", "Unknown projection"))
				return store.rows(id, name).pipe(Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRow(projection, row))))
			},
			watch: (name) => {
				const projection = projections[name]
				if (!(name in projections)) return Stream.fail(modelFailure("definition", "Unknown projection"))
				return lifetime.watch(SubscriptionRef.changes(updates).pipe(Stream.filter((row): row is ProjectionRow | { readonly reset: IndexedBlock } => row !== null && ("reset" in row || row.projection === name)), Stream.mapEffect((row) => "reset" in row ? Effect.succeed({ kind: "reset", key: "", value: null, block: row.reset, period: "state", coverage: "partial" } satisfies ProjectionUpdate<Outputs[typeof name]>) : decodeRow(projection, row))))
			},
		}
	}),
})
