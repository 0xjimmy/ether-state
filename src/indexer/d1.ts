import type { Effect } from "effect"
import type { IndexCommit, IndexRollback, IndexStore } from "./index.js"
import { blockStatement, checkpointStatement, parseBlock, parseCheckpoint, rowStatement, storeEffect, tables,
	type IndexStoreError, type SqlStatement, type StoredCheckpointRow, type StoredRow } from "./storage.js"

type D1Value = string | number | null
export interface D1Result<Row = unknown> { readonly results?: readonly Row[] }
export interface D1PreparedStatement<Self = D1PreparedStatement<unknown>> {
	readonly bind: (...values: readonly D1Value[]) => Self
	readonly first: <Row = Readonly<Record<string, unknown>>>() => Promise<Row | null>
	readonly all: <Row = Readonly<Record<string, unknown>>>() => Promise<D1Result<Row>>
}
type AnyD1PreparedStatement = D1PreparedStatement<AnyD1PreparedStatement>
export interface D1Database<Statement extends D1PreparedStatement<Statement> = AnyD1PreparedStatement> {
	readonly prepare: (sql: string) => Statement
	readonly batch: (statements: Statement[]) => Promise<readonly D1Result[]>
}

const prepared = <Statement extends D1PreparedStatement<Statement>>(database: D1Database<Statement>, statement: SqlStatement): Statement => database.prepare(statement.sql).bind(
	...statement.args.map((value) => typeof value === "bigint" ? value.toString() : value),
)

export const d1Store = <Value, Statement extends D1PreparedStatement<Statement>>(
	database: D1Database<Statement>,
): Effect.Effect<IndexStore<Value, IndexStoreError>, IndexStoreError> =>
	storeEffect("d1", "initialize", async () => {
		await database.batch(tables.map((statement) => database.prepare(statement)))
		return {
			load: (indexId) => storeEffect("d1", "load", async () => {
				const row = await database.prepare(
					"SELECT data_json FROM ether_state_checkpoints WHERE index_id = ?",
				).bind(indexId).first<StoredCheckpointRow>()
				return row === null ? null : parseCheckpoint(row.data_json)
			}),
			recent: (indexId, version, limit) => storeEffect("d1", "recent", async () => {
				const result = await database.prepare(`SELECT block_number, block_hash, parent_hash, block_timestamp
					FROM ether_state_blocks WHERE index_id = ? AND index_version = ?
					ORDER BY CAST(block_number AS INTEGER) DESC LIMIT ?`).bind(indexId, version, limit).all<StoredRow>()
				return (result.results ?? []).map(parseBlock)
			}),
			commit: (commit: IndexCommit<Value>) => storeEffect("d1", "commit", async () => {
				const statements = commit.rows.map((row) => prepared(database,
					rowStatement(commit.checkpoint.indexId, commit.checkpoint.version, row, "?")))
				statements.push(prepared(database, blockStatement(commit.checkpoint, "?")),
					prepared(database, checkpointStatement(commit.checkpoint, "?")))
				await database.batch(statements)
			}),
			rollback: (rollback: IndexRollback) => storeEffect("d1", "rollback", async () => {
				const statements: Statement[] = []
				for (const block of rollback.orphaned) {
					statements.push(
						database.prepare("DELETE FROM ether_state_rows WHERE index_id = ? AND index_version = ? AND block_hash = ?")
							.bind(rollback.indexId, rollback.version, block.hash),
						database.prepare("DELETE FROM ether_state_blocks WHERE index_id = ? AND index_version = ? AND block_hash = ?")
							.bind(rollback.indexId, rollback.version, block.hash),
					)
				}
				statements.push(rollback.checkpoint === null
					? database.prepare("DELETE FROM ether_state_checkpoints WHERE index_id = ?").bind(rollback.indexId)
					: prepared(database, checkpointStatement(rollback.checkpoint, "?")))
				await database.batch(statements)
			}),
		}
	})
