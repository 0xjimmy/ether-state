import { Effect } from "effect"
import type { FinalizedAnchor, IndexCheckpoint, IndexedBlock, IndexRow } from "./index.js"

export interface IndexStoreError {
	readonly _tag: "IndexStoreError"
	readonly adapter: "pglite" | "libsql" | "d1"
	readonly operation: string
	readonly cause: unknown
}

export interface StoredRow extends Readonly<Record<string, unknown>> {
	readonly block_number: string | number | bigint
	readonly block_hash: string
	readonly parent_hash: string
	readonly block_timestamp: string | number | bigint
}

export interface StoredCheckpointRow extends Readonly<Record<string, unknown>> { readonly data_json: string }

export interface SqlStatement {
	readonly sql: string
	readonly args: readonly (string | number | bigint | null)[]
}

export const tables = [
	`CREATE TABLE IF NOT EXISTS ether_state_rows (
		index_id TEXT NOT NULL, index_version INTEGER NOT NULL, row_key TEXT NOT NULL,
		block_number TEXT NOT NULL, block_hash TEXT NOT NULL, block_timestamp TEXT NOT NULL, value_json TEXT NOT NULL,
		PRIMARY KEY (index_id, index_version, row_key, block_hash)
	)`,
	`CREATE TABLE IF NOT EXISTS ether_state_blocks (
		index_id TEXT NOT NULL, index_version INTEGER NOT NULL, block_number TEXT NOT NULL,
		block_hash TEXT NOT NULL, parent_hash TEXT NOT NULL, block_timestamp TEXT NOT NULL,
		PRIMARY KEY (index_id, index_version, block_hash)
	)`,
	`CREATE INDEX IF NOT EXISTS ether_state_blocks_number ON ether_state_blocks (index_id, index_version, block_number)`,
	`CREATE TABLE IF NOT EXISTS ether_state_checkpoints (
		index_id TEXT NOT NULL, index_version INTEGER NOT NULL, data_json TEXT NOT NULL,
		PRIMARY KEY (index_id)
	)`,
] as const

const checkpointJson = (checkpoint: IndexCheckpoint): string => JSON.stringify({
	...checkpoint,
	number: checkpoint.number.toString(),
	timestamp: checkpoint.timestamp.toString(),
	chainId: checkpoint.chainId.toString(),
	startBlock: checkpoint.startBlock.toString(),
	finalized: checkpoint.finalized === null ? null : {
		number: checkpoint.finalized.number.toString(), hash: checkpoint.finalized.hash,
	},
})

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === "object"
const stringField = (value: Readonly<Record<string, unknown>>, key: string): string | undefined =>
	typeof value[key] === "string" ? value[key] : undefined
const numberField = (value: Readonly<Record<string, unknown>>, key: string): number | undefined =>
	typeof value[key] === "number" ? value[key] : undefined

export const parseCheckpoint = (json: string): IndexCheckpoint => {
	const value: unknown = JSON.parse(json)
	if (!isRecord(value)) throw new Error("Stored checkpoint is not an object")
	const finalizedValue = value["finalized"]
	let finalized: FinalizedAnchor | null = null
	if (isRecord(finalizedValue)) {
		const number = stringField(finalizedValue, "number")
		const hash = stringField(finalizedValue, "hash")
		if (number === undefined || hash === undefined) throw new Error("Stored finalized anchor is invalid")
		finalized = { number: BigInt(number), hash }
	}
	const indexId = stringField(value, "indexId")
	const version = numberField(value, "version")
	const chainId = stringField(value, "chainId")
	const startBlock = stringField(value, "startBlock")
	const number = stringField(value, "number")
	const hash = stringField(value, "hash")
	const parentHash = stringField(value, "parentHash")
	const timestamp = stringField(value, "timestamp")
	if (indexId === undefined || version === undefined || chainId === undefined || startBlock === undefined ||
		number === undefined || hash === undefined || parentHash === undefined || timestamp === undefined) {
		throw new Error("Stored checkpoint fields are invalid")
	}
	return {
		indexId, version, chainId: BigInt(chainId), startBlock: BigInt(startBlock), number: BigInt(number), hash,
		parentHash, timestamp: BigInt(timestamp), finalized,
	}
}

export const parseBlock = (row: StoredRow): IndexedBlock => ({
	number: BigInt(row.block_number),
	hash: row.block_hash,
	parentHash: row.parent_hash,
	timestamp: BigInt(row.block_timestamp),
})

const jsonValue = (value: unknown): string => {
	const encoded: unknown = JSON.stringify(value)
	if (typeof encoded !== "string") throw new Error("Index value cannot be encoded as JSON")
	return encoded
}

export const rowStatement = <Value>(indexId: string, version: number, row: IndexRow<Value>, placeholder: string): SqlStatement => ({
	sql: `INSERT INTO ether_state_rows
		(index_id, index_version, row_key, block_number, block_hash, block_timestamp, value_json)
		VALUES (${placeholder}, ${placeholder}, ${placeholder}, ${placeholder}, ${placeholder}, ${placeholder}, ${placeholder})
		ON CONFLICT (index_id, index_version, row_key, block_hash) DO UPDATE SET value_json = excluded.value_json`,
	args: [indexId, version, row.key, row.blockNumber.toString(), row.blockHash, row.blockTimestamp.toString(), jsonValue(row.value)],
})

export const blockStatement = (checkpoint: IndexCheckpoint, placeholder: string): SqlStatement => ({
	sql: `INSERT INTO ether_state_blocks
		(index_id, index_version, block_number, block_hash, parent_hash, block_timestamp)
		VALUES (${placeholder}, ${placeholder}, ${placeholder}, ${placeholder}, ${placeholder}, ${placeholder})
		ON CONFLICT (index_id, index_version, block_hash) DO UPDATE SET
			block_number = excluded.block_number, parent_hash = excluded.parent_hash, block_timestamp = excluded.block_timestamp`,
	args: [checkpoint.indexId, checkpoint.version, checkpoint.number.toString(), checkpoint.hash,
		checkpoint.parentHash, checkpoint.timestamp.toString()],
})

export const checkpointStatement = (checkpoint: IndexCheckpoint, placeholder: string): SqlStatement => ({
	sql: `INSERT INTO ether_state_checkpoints (index_id, index_version, data_json)
		VALUES (${placeholder}, ${placeholder}, ${placeholder})
		ON CONFLICT (index_id) DO UPDATE SET index_version = excluded.index_version, data_json = excluded.data_json`,
	args: [checkpoint.indexId, checkpoint.version, checkpointJson(checkpoint)],
})

export const storeEffect = <A>(
	adapter: IndexStoreError["adapter"],
	operation: string,
	run: () => Promise<A>,
): Effect.Effect<A, IndexStoreError> => Effect.tryPromise({
	try: run,
	catch: (cause): IndexStoreError => ({ _tag: "IndexStoreError", adapter, operation, cause }),
})
