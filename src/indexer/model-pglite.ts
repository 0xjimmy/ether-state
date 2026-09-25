import { Effect } from "effect"
import type { PGliteDatabase } from "./pglite.js"
import { modelFailure, type ModelFailure, type ModelStore } from "./model-store.js"
import { postgresModelStore } from "./model-postgres.js"
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ModelFailure> =>
	Effect.tryPromise({ try: run, catch: cause => modelFailure("store", cause) }).pipe(Effect.uninterruptible)

/** Compatibility initialization for embedded databases. */
export const pgliteModelStore = (database: PGliteDatabase): Effect.Effect<ModelStore, ModelFailure> => Effect.gen(function* () {
	yield* io(() => database.exec(`CREATE TABLE IF NOT EXISTS ether_model_blocks (
		instance TEXT NOT NULL, number NUMERIC(78,0) NOT NULL, timestamp NUMERIC(78,0) NOT NULL,
		data TEXT NOT NULL, PRIMARY KEY(instance, number));
		CREATE INDEX IF NOT EXISTS ether_model_time ON ether_model_blocks(instance, timestamp);
		CREATE TABLE IF NOT EXISTS ether_model_rows (
		instance TEXT NOT NULL, projection TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL,
		PRIMARY KEY(instance, projection, key));`))
	yield* io(() => database.transaction(async tx => {
		const existing = await tx.query<{ name: string | null }>("SELECT to_regclass('ether_model_coverage')::text AS name")
		if (existing.rows[0]?.name) return
		await tx.query(`CREATE TABLE ether_model_coverage (
			instance TEXT NOT NULL, first NUMERIC(78,0) NOT NULL, last NUMERIC(78,0) NOT NULL,
			CHECK(first >= 0 AND last >= first), PRIMARY KEY(instance, first))`)
		await tx.query(`INSERT INTO ether_model_coverage(instance,first,last)
			SELECT instance,min(number),max(number) FROM (
				SELECT instance,number,number-row_number() OVER(PARTITION BY instance ORDER BY number) AS grouping
				FROM ether_model_blocks
			) legacy GROUP BY instance,grouping`)
	}))
	return yield* postgresModelStore(database)
})
