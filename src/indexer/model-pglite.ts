import { Effect } from "effect"
import type { PGliteDatabase } from "./pglite.js"
import { decodeModelBatch, decodeProjectionRow, encodeModelBatch, encodeProjectionRow, modelFailure,
	type ModelFailure, type ModelStore } from "./model-store.js"

const claims = new WeakMap<PGliteDatabase, Set<string>>()
// PGlite promises cannot be cancelled. Drain them before releasing the writer or database.
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ModelFailure> =>
	Effect.tryPromise({ try: run, catch: (cause) => modelFailure("store", cause) }).pipe(Effect.uninterruptible)

/** One PGlite connection owns the writer lock. Use a browser Web Lock across tabs. */
export const pgliteModelStore = (database: PGliteDatabase): Effect.Effect<ModelStore, ModelFailure> => Effect.gen(function* () {
	yield* io(() => database.exec(`CREATE TABLE IF NOT EXISTS ether_model_blocks (
		instance TEXT NOT NULL, number NUMERIC(78,0) NOT NULL, timestamp NUMERIC(78,0) NOT NULL,
		data TEXT NOT NULL, PRIMARY KEY(instance, number));
		CREATE INDEX IF NOT EXISTS ether_model_time ON ether_model_blocks(instance, timestamp);
		CREATE TABLE IF NOT EXISTS ether_model_rows (
		instance TEXT NOT NULL, projection TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL,
		PRIMARY KEY(instance, projection, key));`))
	const writers = claims.get(database) ?? new Set<string>()
	claims.set(database, writers)
	return {
		claim: (id) => Effect.suspend(() => {
			if (writers.has(id)) return Effect.fail(modelFailure("running", "Instance already has a writer"))
			writers.add(id)
			return Effect.succeed(() => { writers.delete(id) })
		}),
		coverage: (id) => io(async () => {
			const result = await database.query<{ first: string; last: string }>(`SELECT min(number)::text AS first, max(number)::text AS last FROM (
				SELECT number, number - row_number() OVER (ORDER BY number) AS grouping
				FROM ether_model_blocks WHERE instance=$1
			) covered GROUP BY grouping ORDER BY min(number)`, [id])
			return result.rows.map((row) => ({ from: BigInt(row.first), through: BigInt(row.last) }))
		}),
		batches: (id, range = {}) => io(() => database.query<{ data: string }>(`SELECT data FROM ether_model_blocks WHERE instance = $1
			AND ($2::numeric IS NULL OR number >= $2::numeric) AND ($3::numeric IS NULL OR number <= $3::numeric)
			AND ($4::numeric IS NULL OR timestamp >= $4::numeric) AND ($5::numeric IS NULL OR timestamp < $5::numeric)
			ORDER BY number`, [id, range.from?.toString() ?? null, range.through?.toString() ?? null,
				range.startTime?.toString() ?? null, range.endTime?.toString() ?? null])).pipe(
			Effect.flatMap((result) => Effect.forEach(result.rows, (row) => decodeModelBatch(row.data)))),
		rows: (id, projection) => io(() => database.query<{ data: string }>(
			"SELECT data FROM ether_model_rows WHERE instance = $1 AND projection = $2", [id, projection])).pipe(
			Effect.flatMap((result) => Effect.forEach(result.rows, (row) => decodeProjectionRow(row.data)))),
		commit: (id, commit) => Effect.gen(function* () {
			const batches = yield* Effect.forEach(commit.batches, (batch) => encodeModelBatch(batch).pipe(Effect.map((data) => ({ batch, data }))))
			const rows = yield* Effect.forEach(commit.rows, (row) => encodeProjectionRow(row).pipe(Effect.map((data) => ({ row, data }))))
			yield* io(() => database.transaction(async (tx) => {
				for (const { batch, data } of batches) await tx.query(`INSERT INTO ether_model_blocks VALUES ($1,$2,$3,$4)
					ON CONFLICT(instance,number) DO UPDATE SET timestamp=excluded.timestamp,data=excluded.data`,
				[id, batch.block.number.toString(), batch.block.timestamp.toString(), data])
				for (const { row, data } of rows) await tx.query(`INSERT INTO ether_model_rows VALUES ($1,$2,$3,$4)
					ON CONFLICT(instance,projection,key) DO UPDATE SET data=excluded.data`, [id, row.projection, row.key, data])
			}))
		}),
		invalidate: (id, from) => io(() => database.transaction(async (tx) => {
			const fork = await tx.query<{ timestamp: string }>("SELECT timestamp::text AS timestamp FROM ether_model_blocks WHERE instance=$1 AND number >= $2 ORDER BY number LIMIT 1", [id, from.toString()])
			const time = fork.rows[0]?.timestamp ?? "0"
			await tx.query("DELETE FROM ether_model_blocks WHERE instance=$1 AND number >= $2", [id, from.toString()])
			await tx.query("DELETE FROM ether_model_rows WHERE instance=$1 AND ((data::jsonb)->>'endTime' IS NULL OR ((data::jsonb)->>'endTime')::numeric > $2)", [id, time])
		})),
	}
})
