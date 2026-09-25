import { Effect, Semaphore } from "effect"
import { decodeModelBatch, decodeProjectionRow, encodeModelBatch, encodeProjectionRow, modelFailure, mergeBlockRanges, rangesFromBlocks,
	type ModelFailure, type ModelStore } from "./model-store.js"

export interface PostgresResult<Row> { readonly rows: readonly Row[] }
export interface PostgresTransaction {
	readonly query: <Row>(sql: string, params?: unknown[]) => Promise<PostgresResult<Row>>
}
export interface PostgresDatabase extends PostgresTransaction {
	readonly transaction: <A>(callback: (transaction: PostgresTransaction) => Promise<A>) => Promise<A>
}
const locks = new WeakMap<PostgresDatabase, Map<string, Semaphore.Semaphore>>()
const claims = new WeakMap<PostgresDatabase, Set<string>>()
// Drain writes before releasing their owning scope. Drivers must bound database waits.
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ModelFailure> =>
	Effect.tryPromise({ try: run, catch: (cause) => modelFailure("store", cause) }).pipe(Effect.uninterruptible)

/** Uses an initialized schema. The caller must enforce database ownership across processes. */
export const postgresModelStore = (database: PostgresDatabase): Effect.Effect<ModelStore, ModelFailure> => Effect.gen(function* () {
	const databaseLocks = locks.get(database) ?? new Map<string, Semaphore.Semaphore>()
	locks.set(database, databaseLocks)
	const transaction = <A>(id: string, callback: (tx: PostgresTransaction) => Promise<A>) => {
		let lock = databaseLocks.get(id)
		if (lock === undefined) { lock = Semaphore.makeUnsafe(1); databaseLocks.set(id, lock) }
		return lock.withPermit(io(() => database.transaction(callback)))
	}
	const writers = claims.get(database) ?? new Set<string>()
	claims.set(database, writers)
	return {
		claim: (id) => Effect.suspend(() => {
			if (writers.has(id)) return Effect.fail(modelFailure("running", "Instance already has a writer"))
			writers.add(id)
			return Effect.succeed(() => { writers.delete(id) })
		}),
		coverage: (id) => io(async () => {
			const result = await database.query<{ first: string; last: string }>(
				"SELECT first::text,last::text FROM ether_model_coverage WHERE instance=$1 ORDER BY first", [id])
			return result.rows.map((row) => ({ from: BigInt(row.first), through: BigInt(row.last) }))
		}),
		batches: (id, range = {}) => io(() => database.query<{ data: string }>(`SELECT data FROM ether_model_blocks WHERE instance = $1
			AND ($2::numeric IS NULL OR number >= $2::numeric) AND ($3::numeric IS NULL OR number <= $3::numeric)
			AND ($4::numeric IS NULL OR timestamp >= $4::numeric) AND ($5::numeric IS NULL OR timestamp < $5::numeric)
			ORDER BY number ${range.direction === "backward" ? "DESC" : "ASC"} LIMIT $6`, [id, range.from?.toString() ?? null, range.through?.toString() ?? null,
				range.startTime?.toString() ?? null, range.endTime?.toString() ?? null, range.limit ?? null])).pipe(
			Effect.flatMap((result) => Effect.forEach(result.rows, (row) => decodeModelBatch(row.data)))),
		rows: (id, projection) => io(() => database.query<{ data: string }>(
			"SELECT data FROM ether_model_rows WHERE instance = $1 AND projection = $2", [id, projection])).pipe(
			Effect.flatMap((result) => Effect.forEach(result.rows, (row) => decodeProjectionRow(row.data)))),
		commit: (id, commit) => Effect.gen(function* () {
			const batches = yield* Effect.forEach(commit.batches, (batch) => encodeModelBatch(batch).pipe(Effect.map((data) => ({ batch, data }))))
			const rows = yield* Effect.forEach(commit.rows, (row) => encodeProjectionRow(row).pipe(Effect.map((data) => ({ row, data }))))
			yield* transaction(id, async (tx) => {
				const current = await tx.query<{ first: string; last: string }>("SELECT first::text,last::text FROM ether_model_coverage WHERE instance=$1", [id])
				const spans = mergeBlockRanges([...current.rows.map(row => ({ from: BigInt(row.first), through: BigInt(row.last) })),
					...(commit.coverage ?? rangesFromBlocks(commit.batches.map(batch => batch.block.number)))])
				await tx.query("DELETE FROM ether_model_coverage WHERE instance=$1", [id])
				for (const span of spans) await tx.query("INSERT INTO ether_model_coverage VALUES($1,$2,$3)", [id,span.from.toString(),span.through.toString()])
				for (const { batch, data } of batches) await tx.query(`INSERT INTO ether_model_blocks VALUES ($1,$2,$3,$4)
					ON CONFLICT(instance,number) DO UPDATE SET timestamp=excluded.timestamp,data=excluded.data`,
				[id, batch.block.number.toString(), batch.block.timestamp.toString(), data])
				for (const { row, data } of rows) await tx.query(`INSERT INTO ether_model_rows VALUES ($1,$2,$3,$4)
					ON CONFLICT(instance,projection,key) DO UPDATE SET data=excluded.data`, [id, row.projection, row.key, data])
			})
		}),
		invalidate: (id, from) => transaction(id, async (tx) => {
			const fork = await tx.query<{ timestamp: string }>("SELECT timestamp::text AS timestamp FROM ether_model_blocks WHERE instance=$1 AND number <= $2 ORDER BY number DESC LIMIT 1", [id, from.toString()])
			const time = fork.rows[0]?.timestamp ?? "0"
			await tx.query("DELETE FROM ether_model_coverage WHERE instance=$1 AND first >= $2", [id,from.toString()])
			await tx.query("UPDATE ether_model_coverage SET last=$2::numeric-1 WHERE instance=$1 AND last >= $2", [id,from.toString()])
			await tx.query("DELETE FROM ether_model_blocks WHERE instance=$1 AND number >= $2", [id, from.toString()])
			await tx.query("DELETE FROM ether_model_rows WHERE instance=$1 AND ((data::jsonb)->>'endTime' IS NULL OR ((data::jsonb)->>'endTime')::numeric > $2)", [id, time])
		}),
		retain: (id, retention) => transaction(id, async (tx) => {
			await tx.query("DELETE FROM ether_model_coverage WHERE instance=$1 AND last < $2", [id,retention.fromBlock.toString()])
			await tx.query("UPDATE ether_model_coverage SET first=$2 WHERE instance=$1 AND first < $2", [id,retention.fromBlock.toString()])
			await tx.query("DELETE FROM ether_model_blocks WHERE instance=$1 AND number < $2", [id, retention.fromBlock.toString()])
			await tx.query(`DELETE FROM ether_model_rows WHERE instance=$1
				AND (data::jsonb)->>'period' <> 'state'
				AND ((data::jsonb)->>'period' <> 'closed' OR (data::jsonb)->>'coverage' <> 'complete'
					OR ((data::jsonb)->>'endTime')::numeric <= $2)`, [id, retention.fromTime.toString()])
		}),
	}
})
