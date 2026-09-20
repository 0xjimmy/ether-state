import { Effect, Schema } from "effect"
import type { IndexedBlock } from "./index.js"

export interface ModelFailure {
	readonly _tag: "ModelFailure"
	readonly stage: "definition" | "source" | "projection" | "store" | "origin" | "running" | "chain"
	readonly cause: unknown
}
export const modelFailure = (stage: ModelFailure["stage"], cause: unknown): ModelFailure => ({ _tag: "ModelFailure", stage, cause })
export interface BlockRange { readonly from: bigint; readonly through: bigint }
export interface ModelBatch {
	readonly block: IndexedBlock
	readonly sources: Readonly<Record<string, readonly unknown[]>>
}
export interface ProjectionRow {
	readonly projection: string
	readonly key: string
	readonly value: unknown
	readonly block: IndexedBlock
	readonly endTime: bigint | null
	readonly period: "open" | "closed" | "state"
	readonly coverage: "partial" | "complete"
}
export interface ModelCommit {
	readonly batches: readonly ModelBatch[]
	readonly rows: readonly ProjectionRow[]
}
export interface ModelStore {
	readonly claim: (id: string) => Effect.Effect<() => void, ModelFailure>
	readonly coverage: (id: string) => Effect.Effect<readonly BlockRange[], ModelFailure>
	readonly batches: (id: string, range?: { readonly from?: bigint; readonly through?: bigint; readonly startTime?: bigint; readonly endTime?: bigint }) => Effect.Effect<readonly ModelBatch[], ModelFailure>
	readonly rows: (id: string, projection: string) => Effect.Effect<readonly ProjectionRow[], ModelFailure>
	readonly commit: (id: string, commit: ModelCommit) => Effect.Effect<void, ModelFailure>
	readonly invalidate: (id: string, from: bigint) => Effect.Effect<void, ModelFailure>
}
export const rangesFromBlocks = (numbers: readonly bigint[]): readonly BlockRange[] => {
	const sorted = [...new Set(numbers)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
	const ranges: { from: bigint; through: bigint }[] = []
	for (const number of sorted) {
		const last = ranges[ranges.length - 1]
		if (last !== undefined && last.through + 1n === number) last.through = number
		else ranges.push({ from: number, through: number })
	}
	return ranges
}
export const missingRange = (ranges: readonly BlockRange[], from: bigint, through: bigint, size: number): BlockRange | null => {
	let end = through
	for (const range of [...ranges].reverse()) {
		if (range.from > end) continue
		if (range.through >= end) { end = range.from - 1n; continue }
		const start = end - BigInt(size) + 1n
		return end < from ? null : { from: start > range.through + 1n && start > from ? start : range.through + 1n > from ? range.through + 1n : from, through: end }
	}
	return end < from ? null : { from: end - BigInt(size) + 1n > from ? end - BigInt(size) + 1n : from, through: end }
}

export const missingForwardRange = (ranges: readonly BlockRange[], from: bigint, through: bigint, size: number): BlockRange | null => {
	let start = from
	for (const range of ranges) {
		if (range.through < start) continue
		if (range.from <= start) { start = range.through + 1n; continue }
		const end = start + BigInt(size) - 1n
		return start > through ? null : { from: start, through: end < range.from && end < through ? end : range.from - 1n < through ? range.from - 1n : through }
	}
	return start > through ? null : { from: start, through: start + BigInt(size) - 1n < through ? start + BigInt(size) - 1n : through }
}

export const memoryModelStore = (): ModelStore => {
	const batches = new Map<string, Map<bigint, ModelBatch>>()
	const rows = new Map<string, Map<string, ProjectionRow>>()
	const writers = new Set<string>()
	return {
		claim: (id) => Effect.suspend(() => {
			if (writers.has(id)) return Effect.fail(modelFailure("running", "Instance already has a writer"))
			writers.add(id)
			return Effect.succeed(() => { writers.delete(id) })
		}),
		coverage: (id) => Effect.sync(() => rangesFromBlocks([...(batches.get(id)?.keys() ?? [])])),
		batches: (id, range = {}) => Effect.sync(() => [...(batches.get(id)?.values() ?? [])]
			.filter(({ block }) => (range.from === undefined || block.number >= range.from) &&
				(range.through === undefined || block.number <= range.through) &&
				(range.startTime === undefined || block.timestamp >= range.startTime) &&
				(range.endTime === undefined || block.timestamp < range.endTime))
			.sort((a, b) => a.block.number < b.block.number ? -1 : 1)),
		rows: (id, projection) => Effect.sync(() => [...(rows.get(id)?.values() ?? [])].filter((row) => row.projection === projection)),
		commit: (id, commit) => Effect.sync(() => {
			const storedBatches = batches.get(id) ?? new Map<bigint, ModelBatch>()
			const storedRows = rows.get(id) ?? new Map<string, ProjectionRow>()
			for (const batch of commit.batches) storedBatches.set(batch.block.number, batch)
			for (const row of commit.rows) storedRows.set(`${row.projection}:${row.key}`, row)
			batches.set(id, storedBatches)
			rows.set(id, storedRows)
		}),
		invalidate: (id, from) => Effect.sync(() => {
			const forkTime = batches.get(id)?.get(from)?.block.timestamp ?? 0n
			for (const number of batches.get(id)?.keys() ?? []) if (number >= from) batches.get(id)?.delete(number)
			for (const [key, row] of rows.get(id) ?? []) if (row.endTime === null || row.endTime > forkTime) rows.get(id)?.delete(key)
		}),
	}
}

const BlockCodec = Schema.toCodecJson(Schema.Struct({ number: Schema.BigInt, hash: Schema.String,
	parentHash: Schema.String, timestamp: Schema.BigInt }))
const BatchCodec = Schema.Struct({ block: BlockCodec, sources: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)) })
const RowCodec = Schema.Struct({ projection: Schema.String, key: Schema.String, value: Schema.Unknown,
	block: BlockCodec, endTime: Schema.NullOr(Schema.toCodecJson(Schema.BigInt)), period: Schema.Literals(["open", "closed", "state"]), coverage: Schema.Literals(["partial", "complete"]) })
export const encodeModelBatch = (batch: ModelBatch): Effect.Effect<string, ModelFailure> =>
	Schema.encodeEffect(BatchCodec)(batch).pipe(Effect.flatMap((value) => Effect.try(() => JSON.stringify(value))), Effect.mapError((cause) => modelFailure("store", cause)))
export const decodeModelBatch = (json: string): Effect.Effect<ModelBatch, ModelFailure> =>
	Effect.try((): unknown => JSON.parse(json)).pipe(Effect.flatMap(Schema.decodeUnknownEffect(BatchCodec)), Effect.mapError((cause) => modelFailure("store", cause)))
export const encodeProjectionRow = (row: ProjectionRow): Effect.Effect<string, ModelFailure> =>
	Schema.encodeEffect(RowCodec)(row).pipe(Effect.flatMap((value) => Effect.try(() => JSON.stringify(value))), Effect.mapError((cause) => modelFailure("store", cause)))
export const decodeProjectionRow = (json: string): Effect.Effect<ProjectionRow, ModelFailure> =>
	Effect.try((): unknown => JSON.parse(json)).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RowCodec)), Effect.mapError((cause) => modelFailure("store", cause)))
