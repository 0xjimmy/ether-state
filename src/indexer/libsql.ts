import type { Effect } from "effect"
import type { IndexCommit, IndexRollback, IndexStore } from "./index.js"
import { blockStatement, checkpointStatement, parseBlock, parseCheckpoint, rowStatement, storeEffect, tables,
	type IndexStoreError, type SqlStatement, type StoredCheckpointRow, type StoredRow } from "./storage.js"

export type LibsqlValue = null | string | number | bigint | ArrayBuffer | boolean | Uint8Array | Date
export type LibsqlArgs = LibsqlValue[] | Record<string, LibsqlValue>
export interface LibsqlStatement { readonly sql: string; readonly args?: LibsqlArgs }
export interface LibsqlResult { readonly rows: readonly unknown[] }
export interface LibsqlClient {
	execute(statement: LibsqlStatement): Promise<LibsqlResult>
	execute(sql: string, args?: LibsqlArgs): Promise<LibsqlResult>
	readonly batch: (statements: (string | LibsqlStatement)[], mode?: "deferred" | "write" | "read") => Promise<unknown>
}

const input = (statement: SqlStatement): LibsqlStatement => ({ sql: statement.sql, args: [...statement.args] })

export const libsqlStore = <Value>(client: LibsqlClient): Effect.Effect<IndexStore<Value, IndexStoreError>, IndexStoreError> =>
	storeEffect("libsql", "initialize", async () => {
		for (const statement of tables) await client.execute(statement)
		return {
			load: (indexId) => storeEffect("libsql", "load", async () => {
				const result = await client.execute({
					sql: "SELECT data_json FROM ether_state_checkpoints WHERE index_id = ?", args: [indexId],
				})
				const row: unknown = result.rows[0]
				return isCheckpointRow(row) ? parseCheckpoint(row.data_json) : null
			}),
			recent: (indexId, version, limit) => storeEffect("libsql", "recent", async () => {
				const result = await client.execute({ sql: `SELECT block_number, block_hash, parent_hash, block_timestamp
					FROM ether_state_blocks WHERE index_id = ? AND index_version = ?
					ORDER BY CAST(block_number AS INTEGER) DESC LIMIT ?`, args: [indexId, version, limit] })
				return result.rows.filter(isStoredRow).map(parseBlock)
			}),
			commit: (commit: IndexCommit<Value>) => storeEffect("libsql", "commit", async () => {
				const statements = commit.rows.map((row) => input(rowStatement(commit.checkpoint.indexId, commit.checkpoint.version, row, "?")))
				statements.push(input(blockStatement(commit.checkpoint, "?")), input(checkpointStatement(commit.checkpoint, "?")))
				await client.batch(statements, "write")
			}),
			rollback: (rollback: IndexRollback) => storeEffect("libsql", "rollback", async () => {
				const statements: LibsqlStatement[] = []
				for (const block of rollback.orphaned) {
					statements.push(
						{ sql: "DELETE FROM ether_state_rows WHERE index_id = ? AND index_version = ? AND block_hash = ?", args: [rollback.indexId, rollback.version, block.hash] },
						{ sql: "DELETE FROM ether_state_blocks WHERE index_id = ? AND index_version = ? AND block_hash = ?", args: [rollback.indexId, rollback.version, block.hash] },
					)
				}
				statements.push(rollback.checkpoint === null
					? { sql: "DELETE FROM ether_state_checkpoints WHERE index_id = ?", args: [rollback.indexId] }
					: input(checkpointStatement(rollback.checkpoint, "?")))
				await client.batch(statements, "write")
			}),
		}
	})

const isCheckpointRow = (value: unknown): value is StoredCheckpointRow => value !== null && typeof value === "object" &&
	"data_json" in value && typeof value.data_json === "string"
const isStoredRow = (value: unknown): value is StoredRow => value !== null && typeof value === "object" &&
	"block_number" in value && (typeof value.block_number === "string" || typeof value.block_number === "number" || typeof value.block_number === "bigint") &&
	"block_hash" in value && typeof value.block_hash === "string" && "parent_hash" in value && typeof value.parent_hash === "string" &&
	"block_timestamp" in value && (typeof value.block_timestamp === "string" || typeof value.block_timestamp === "number" || typeof value.block_timestamp === "bigint")
