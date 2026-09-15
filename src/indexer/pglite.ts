import type { Effect } from "effect"
import type { IndexCommit, IndexRollback, IndexStore } from "./index.js"
import { blockStatement, checkpointStatement, parseBlock, parseCheckpoint, rowStatement, storeEffect, tables,
	type IndexStoreError, type StoredCheckpointRow, type StoredRow } from "./storage.js"

export interface PGliteResult<Row> { readonly rows: readonly Row[] }
export interface PGliteTransaction {
	readonly query: <Row>(sql: string, params?: unknown[]) => Promise<PGliteResult<Row>>
}
export interface PGliteDatabase extends PGliteTransaction {
	readonly exec: (sql: string) => Promise<unknown>
	readonly transaction: <A>(callback: (transaction: PGliteTransaction) => Promise<A>) => Promise<A>
}

const query = <Row>(database: PGliteTransaction, sql: string, args: readonly unknown[] = []): Promise<PGliteResult<Row>> =>
	database.query<Row>(sql, [...args])

const execute = (database: PGliteTransaction, statement: { readonly sql: string; readonly args: readonly unknown[] }): Promise<unknown> =>
	query(database, statement.sql.replaceAll("?", (_, offset: number) => `$${String(statement.sql.slice(0, offset).split("?").length)}`), statement.args)

export const pgliteStore = <Value>(database: PGliteDatabase): Effect.Effect<IndexStore<Value, IndexStoreError>, IndexStoreError> =>
	storeEffect("pglite", "initialize", async () => {
		for (const statement of tables) await database.exec(statement)
		return {
			load: (indexId) => storeEffect("pglite", "load", async () => {
				const result = await query<StoredCheckpointRow>(database,
					"SELECT data_json FROM ether_state_checkpoints WHERE index_id = $1", [indexId])
				const row = result.rows[0]
				return row === undefined ? null : parseCheckpoint(row.data_json)
			}),
			recent: (indexId, version, limit) => storeEffect("pglite", "recent", async () => {
				const result = await query<StoredRow>(database, `SELECT block_number, block_hash, parent_hash, block_timestamp
					FROM ether_state_blocks WHERE index_id = $1 AND index_version = $2
					ORDER BY CAST(block_number AS NUMERIC) DESC LIMIT $3`, [indexId, version, limit])
				return result.rows.map(parseBlock)
			}),
			commit: (commit: IndexCommit<Value>) => storeEffect("pglite", "commit", () => database.transaction(async (transaction) => {
				for (const row of commit.rows) await execute(transaction, rowStatement(commit.checkpoint.indexId, commit.checkpoint.version, row, "?"))
				await execute(transaction, blockStatement(commit.checkpoint, "?"))
				await execute(transaction, checkpointStatement(commit.checkpoint, "?"))
			})),
			rollback: (rollback: IndexRollback) => storeEffect("pglite", "rollback", () => database.transaction(async (transaction) => {
				for (const block of rollback.orphaned) {
					await query(transaction, "DELETE FROM ether_state_rows WHERE index_id = $1 AND index_version = $2 AND block_hash = $3",
						[rollback.indexId, rollback.version, block.hash])
					await query(transaction, "DELETE FROM ether_state_blocks WHERE index_id = $1 AND index_version = $2 AND block_hash = $3",
						[rollback.indexId, rollback.version, block.hash])
				}
				if (rollback.checkpoint === null) {
					await query(transaction, "DELETE FROM ether_state_checkpoints WHERE index_id = $1", [rollback.indexId])
				} else await execute(transaction, checkpointStatement(rollback.checkpoint, "?"))
			})),
		}
	})
