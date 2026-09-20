import { defineModel } from "./model.js"
import { Effect, Schedule, Schema, Stream } from "effect"
import type { EvmClient, EvmClientError } from "../rpc/client.js"
import type { RpcBlock, RpcBlockTag, RpcLog, RpcLogFilter, RpcReceipt, RpcTransaction, RpcTransactionRequest } from "../rpc/schema.js"
import { matchesLog } from "../rpc/watch.js"

export interface IndexValue<Value> {
	readonly key: string
	readonly value: Value
}

export interface IndexRow<Value> extends IndexValue<Value> {
	readonly blockNumber: bigint
	readonly blockHash: string
	readonly blockTimestamp: bigint
}

export interface IndexCall {
	readonly key: string
	readonly transaction: RpcTransactionRequest
}

export interface IndexSource {
	readonly transactions?: boolean
	readonly receipts?: boolean
	readonly logs?: RpcLogFilter
	readonly calls?: readonly IndexCall[]
}

export type IndexFinality =
	| { readonly mode: "latest" }
	| { readonly mode: "confirmations"; readonly count: bigint }
	| { readonly mode: "finalized" }

export interface IndexBlockBundle {
	readonly block: RpcBlock
	readonly transactions: readonly RpcTransaction[]
	readonly receipts: readonly RpcReceipt[]
	readonly logs: readonly RpcLog[]
	readonly calls: Readonly<Record<string, string>>
}

export interface IndexDefinition<Value, Encoded, TransformError = never> {
	readonly id: string
	readonly version: number
	readonly startBlock: bigint
	readonly finality: IndexFinality
	readonly source: IndexSource
	readonly valueSchema: Schema.Codec<Value, Encoded>
	readonly transform: (bundle: IndexBlockBundle) => Effect.Effect<readonly IndexValue<Value>[], TransformError>
}

export const defineIndex = <Value, Encoded, TransformError = never>(
	definition: IndexDefinition<Value, Encoded, TransformError>,
): IndexDefinition<Value, Encoded, TransformError> => definition

export interface IndexedBlock {
	readonly number: bigint
	readonly hash: string
	readonly parentHash: string
	readonly timestamp: bigint
}

export interface FinalizedAnchor {
	readonly number: bigint
	readonly hash: string
}

export interface IndexCheckpoint extends IndexedBlock {
	readonly indexId: string
	readonly version: number
	readonly chainId: bigint
	readonly startBlock: bigint
	readonly finalized: FinalizedAnchor | null
}

export interface IndexCommit<Value> {
	readonly checkpoint: IndexCheckpoint
	readonly rows: readonly IndexRow<Value>[]
}

export interface IndexRollback {
	readonly indexId: string
	readonly version: number
	readonly orphaned: readonly IndexedBlock[]
	readonly checkpoint: IndexCheckpoint | null
}

export interface IndexStore<Value, StoreError> {
	readonly load: (indexId: string, version: number) => Effect.Effect<IndexCheckpoint | null, StoreError>
	readonly recent: (indexId: string, version: number, limit: number) => Effect.Effect<readonly IndexedBlock[], StoreError>
	readonly commit: (commit: IndexCommit<Value>) => Effect.Effect<void, StoreError>
	readonly rollback: (rollback: IndexRollback) => Effect.Effect<void, StoreError>
}

export interface InvalidIndexDefinition {
	readonly _tag: "InvalidIndexDefinition"
	readonly reason: string
}
export interface IndexMetadataMismatch {
	readonly _tag: "IndexMetadataMismatch"
	readonly checkpoint: IndexCheckpoint
}
export interface IndexBlockUnavailable {
	readonly _tag: "IndexBlockUnavailable"
	readonly block: bigint | string
	readonly cause?: EvmClientError
}
export interface InconsistentIndexBundle {
	readonly _tag: "InconsistentIndexBundle"
	readonly blockNumber: bigint
	readonly blockHash: string
	readonly reason: string
}
export interface DuplicateIndexRow {
	readonly _tag: "DuplicateIndexRow"
	readonly key: string
	readonly blockHash: string
}
export interface IndexReorgTooDeep {
	readonly _tag: "IndexReorgTooDeep"
	readonly checkpoint: IndexCheckpoint
}
export interface FinalizedChainConflict {
	readonly _tag: "FinalizedChainConflict"
	readonly anchor: FinalizedAnchor
}

export type IndexerError = InvalidIndexDefinition | IndexMetadataMismatch | IndexBlockUnavailable |
	InconsistentIndexBundle | DuplicateIndexRow | IndexReorgTooDeep | FinalizedChainConflict | Schema.SchemaError

export type IndexChange<Value> =
	| {
		readonly _tag: "Apply"
		readonly block: IndexedBlock
		readonly rows: readonly IndexRow<Value>[]
		readonly checkpoint: IndexCheckpoint
	}
	| {
		readonly _tag: "Revert"
		readonly orphaned: readonly IndexedBlock[]
		readonly checkpoint: IndexCheckpoint | null
	}

export const callbackStore = <Value, LoadError, WriteError>(options: {
	readonly load: (indexId: string, version: number) => Effect.Effect<IndexCheckpoint | null, LoadError>
	readonly recent: (indexId: string, version: number, limit: number) => Effect.Effect<readonly IndexedBlock[], LoadError>
	readonly write: (change: IndexChange<Value>) => Effect.Effect<void, WriteError>
}): IndexStore<Value, LoadError | WriteError> => ({
	load: options.load,
	recent: options.recent,
	commit: ({ checkpoint, rows }) => options.write({ _tag: "Apply", block: checkpoint, rows, checkpoint }),
	rollback: ({ orphaned, checkpoint }) => options.write({ _tag: "Revert", orphaned, checkpoint }),
})

const validateDefinition = <Value, Encoded, TransformError>(
	index: IndexDefinition<Value, Encoded, TransformError>,
): Effect.Effect<void, InvalidIndexDefinition> => {
	if (index.id.length === 0) return Effect.fail({ _tag: "InvalidIndexDefinition", reason: "Index ID is empty" })
	if (!Number.isSafeInteger(index.version) || index.version < 1) {
		return Effect.fail({ _tag: "InvalidIndexDefinition", reason: "Index version must be a positive safe integer" })
	}
	if (index.startBlock < 0n) return Effect.fail({ _tag: "InvalidIndexDefinition", reason: "Start block is negative" })
	if (index.finality.mode === "confirmations" && index.finality.count < 0n) {
		return Effect.fail({ _tag: "InvalidIndexDefinition", reason: "Confirmation count is negative" })
	}
	const keys = index.source.calls?.map((call) => call.key) ?? []
	if (keys.some((key) => key.length === 0) || new Set(keys).size !== keys.length) {
		return Effect.fail({ _tag: "InvalidIndexDefinition", reason: "Call keys must be non-empty and unique" })
	}
	return Effect.void
}

const blockData = (block: RpcBlock): IndexedBlock => ({
	number: block.number,
	hash: block.hash,
	parentHash: block.parentHash,
	timestamp: block.timestamp,
})

type BlockReference = bigint | RpcBlockTag | { readonly hash: string }

const fetchBlock = (client: EvmClient, reference: BlockReference, full: boolean): Effect.Effect<RpcBlock, IndexBlockUnavailable> => {
	const label = typeof reference === "object" ? reference.hash : reference
	const request = typeof reference === "object"
		? client.fetchOne({ method: "eth_getBlockByHash", params: [reference.hash, full] })
		: client.fetchOne({ method: "eth_getBlockByNumber", params: [reference, full] })
	return request.pipe(
		Effect.mapError((cause): IndexBlockUnavailable => ({ _tag: "IndexBlockUnavailable", block: label, cause })),
		Effect.flatMap((block) => block === null
			? Effect.fail<IndexBlockUnavailable>({ _tag: "IndexBlockUnavailable", block: label })
			: Effect.succeed(block)),
	)
}

const fetchBundle = <Value, Encoded, TransformError>(
	client: EvmClient,
	index: IndexDefinition<Value, Encoded, TransformError>,
	number: bigint,
): Effect.Effect<IndexBlockBundle, IndexerError> => Effect.gen(function* () {
	const needsTransactions = index.source.transactions === true || index.source.receipts === true
	const block = yield* fetchBlock(client, number, needsTransactions)
	const transactions = block.transactions.filter((transaction) => typeof transaction !== "string")
	if (needsTransactions && transactions.length !== block.transactions.length) {
		return yield* Effect.fail<InconsistentIndexBundle>({
			_tag: "InconsistentIndexBundle", blockNumber: block.number, blockHash: block.hash,
			reason: "Full transactions were requested but were not returned",
		})
	}
	if (transactions.some((transaction, position) => transaction.blockHash !== block.hash ||
		transaction.blockNumber !== block.number || transaction.transactionIndex !== BigInt(position))) {
		return yield* Effect.fail<InconsistentIndexBundle>({
			_tag: "InconsistentIndexBundle", blockNumber: block.number, blockHash: block.hash,
			reason: "Transactions do not match the requested block",
		})
	}
	const receipts = index.source.receipts === true
		? yield* client.fetchOne({ method: "eth_getBlockReceipts", params: [{ blockHash: block.hash, requireCanonical: true }] }).pipe(
			Effect.catch((cause) => cause._tag === "RpcError" && (cause.code === -32601 || cause.code === -32004)
				? Effect.forEach(transactions, (transaction) => client.fetchOne({
					method: "eth_getTransactionReceipt", params: [transaction.hash],
				}).pipe(Effect.flatMap((receipt) => receipt === null
					? Effect.fail<EvmClientError>({ _tag: "RpcError", code: -32001, message: "Transaction receipt is unavailable" })
					: Effect.succeed(receipt))), { concurrency: 8 })
				: Effect.fail(cause)),
			Effect.mapError((cause): IndexBlockUnavailable => ({ _tag: "IndexBlockUnavailable", block: block.hash, cause })),
			Effect.flatMap((value) => value === null ? Effect.fail<IndexBlockUnavailable>({
				_tag: "IndexBlockUnavailable", block: block.hash,
			}) : Effect.succeed(value)))
		: []
	if (receipts.some((receipt, position) => receipt.blockHash !== block.hash || receipt.blockNumber !== block.number ||
		receipt.transactionHash !== transactions[position]?.hash || receipt.transactionIndex !== BigInt(position) ||
		receipt.logs.some((log) => log.blockHash !== block.hash || log.blockNumber !== block.number ||
			log.transactionHash !== receipt.transactionHash || log.transactionIndex !== receipt.transactionIndex || log.removed === true)) ||
		(index.source.receipts === true && receipts.length !== block.transactions.length)) {
		return yield* Effect.fail<InconsistentIndexBundle>({
			_tag: "InconsistentIndexBundle", blockNumber: block.number, blockHash: block.hash,
			reason: "Receipts do not match the requested block",
		})
	}
	const logFilter = index.source.logs
	const logs = logFilter === undefined ? []
		: index.source.receipts === true
			? receipts.flatMap((receipt) => receipt.logs).filter((log) => matchesLog(log, logFilter))
			: yield* client.fetchOne({ method: "eth_getLogs", params: [{ ...logFilter, blockHash: block.hash }] }).pipe(
				Effect.mapError((cause): IndexBlockUnavailable => ({ _tag: "IndexBlockUnavailable", block: block.hash, cause })))
	if (logs.some((log) => log.blockHash !== block.hash || log.blockNumber !== block.number)) {
		return yield* Effect.fail<InconsistentIndexBundle>({
			_tag: "InconsistentIndexBundle", blockNumber: block.number, blockHash: block.hash,
			reason: "Logs do not match the requested block",
		})
	}
	const callEntries = yield* Effect.forEach(index.source.calls ?? [], (call) => client.fetchOne({
		method: "eth_call", params: [call.transaction, { blockHash: block.hash, requireCanonical: true }],
	}).pipe(
		Effect.map((value): readonly [string, string] => [call.key, value]),
		Effect.mapError((cause): IndexBlockUnavailable => ({ _tag: "IndexBlockUnavailable", block: block.hash, cause })),
	), { concurrency: "unbounded" })
	return { block, transactions, receipts, logs, calls: Object.fromEntries(callEntries) }
})

const targetBlock = <Value, Encoded, TransformError>(
	client: EvmClient,
	index: IndexDefinition<Value, Encoded, TransformError>,
): Effect.Effect<RpcBlock, IndexBlockUnavailable> => Effect.gen(function* () {
	if (index.finality.mode === "finalized") return yield* fetchBlock(client, "finalized", false)
	const latest = yield* fetchBlock(client, "latest", false)
	if (index.finality.mode === "latest") return latest
	const number = latest.number > index.finality.count ? latest.number - index.finality.count : 0n
	return yield* fetchBlock(client, number, false)
})

const finalizedAnchor = (client: EvmClient): Effect.Effect<FinalizedAnchor | null> =>
	client.fetchOne({ method: "eth_getBlockByNumber", params: ["finalized", false] }).pipe(
		Effect.map((block) => block === null ? null : { number: block.number, hash: block.hash }),
		Effect.catch(() => Effect.succeed(null)),
	)

const transformBlock = <Value, Encoded, TransformError>(
	client: EvmClient,
	index: IndexDefinition<Value, Encoded, TransformError>,
	number: bigint,
): Effect.Effect<{ readonly bundle: IndexBlockBundle; readonly rows: readonly IndexRow<Encoded>[] }, IndexerError | TransformError> =>
	Effect.gen(function* () {
		const bundle = yield* fetchBundle(client, index, number)
		const values = yield* index.transform(bundle)
		const keys = new Set<string>()
		const rows: IndexRow<Encoded>[] = []
		for (const value of values) {
			if (keys.has(value.key)) return yield* Effect.fail<DuplicateIndexRow>({
				_tag: "DuplicateIndexRow", key: value.key, blockHash: bundle.block.hash,
			})
			keys.add(value.key)
			rows.push({
				key: value.key,
				value: yield* Schema.encodeEffect(index.valueSchema)(value.value),
				blockNumber: bundle.block.number,
				blockHash: bundle.block.hash,
				blockTimestamp: bundle.block.timestamp,
			})
		}
		return { bundle, rows }
	})

export const indexChanges = <Value, Encoded, TransformError>(options: {
	readonly client: EvmClient
	readonly index: IndexDefinition<Value, Encoded, TransformError>
	readonly fromBlock: bigint
	readonly toBlock: bigint
}): Stream.Stream<IndexChange<Encoded>, IndexerError | TransformError> => {
	if (options.fromBlock < options.index.startBlock || options.fromBlock > options.toBlock) {
		return Stream.fail({ _tag: "InvalidIndexDefinition", reason: "Invalid change range" })
	}
	return Stream.fromIterable((function* () {
		for (let number = options.fromBlock; number <= options.toBlock; number++) yield number
	})()).pipe(Stream.mapEffect((number) => transformBlock(options.client, options.index, number).pipe(
		Effect.map(({ bundle, rows }): IndexChange<Encoded> => {
			const block = blockData(bundle.block)
			return { _tag: "Apply", block, rows, checkpoint: {
				...block,
				indexId: options.index.id,
				version: options.index.version,
				chainId: options.client.config.network.chainId,
				startBlock: options.index.startBlock,
				finalized: null,
			} }
		}),
	))
	)
}

export const runIndexChanges = <Value, Error, Requirements, SinkError, SinkRequirements>(
	changes: Stream.Stream<IndexChange<Value>, Error, Requirements>,
	write: (change: IndexChange<Value>) => Effect.Effect<void, SinkError, SinkRequirements>,
): Effect.Effect<void, Error | SinkError, Requirements | SinkRequirements> => changes.pipe(Stream.runForEach(write))

export class Indexer<Value, Encoded, TransformError, StoreError> {
	static readonly define: typeof defineModel = defineModel

	private constructor(
		private readonly client: EvmClient,
		readonly index: IndexDefinition<Value, Encoded, TransformError>,
		readonly store: IndexStore<Encoded, StoreError>,
		private readonly reorgDepth: number,
		private readonly bootstrapConcurrency: number,
	) {}

	static make<Value, Encoded, TransformError, StoreError>(options: {
		readonly client: EvmClient
		readonly index: IndexDefinition<Value, Encoded, TransformError>
		readonly store: IndexStore<Encoded, StoreError>
		readonly reorgDepth?: number
		readonly bootstrapConcurrency?: number
	}): Effect.Effect<Indexer<Value, Encoded, TransformError, StoreError>, InvalidIndexDefinition> {
		return validateDefinition(options.index).pipe(Effect.flatMap(() => {
			const concurrency = options.bootstrapConcurrency ?? 4
			const depth = options.reorgDepth ?? 128
			return !Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(depth) || depth < 1
				? Effect.fail<InvalidIndexDefinition>({ _tag: "InvalidIndexDefinition", reason: "Indexer limits must be positive safe integers" })
				: Effect.succeed(new Indexer(options.client, options.index, options.store, depth, concurrency))
		}))
	}

	sync(toBlock?: bigint): Effect.Effect<IndexCheckpoint | null, IndexerError | TransformError | StoreError> {
		return Effect.gen({ self: this }, function* () {
			let checkpoint = yield* this.store.load(this.index.id, this.index.version)
			if (checkpoint !== null && (checkpoint.chainId !== this.client.config.network.chainId ||
				checkpoint.startBlock !== this.index.startBlock || checkpoint.indexId !== this.index.id ||
				checkpoint.version !== this.index.version)) {
				return yield* Effect.fail<IndexMetadataMismatch>({ _tag: "IndexMetadataMismatch", checkpoint })
			}
			checkpoint = yield* this.recover(checkpoint)
			const target = toBlock === undefined ? yield* targetBlock(this.client, this.index) : yield* fetchBlock(this.client, toBlock, false)
			let number = checkpoint === null ? this.index.startBlock : checkpoint.number + 1n
			syncLoop: while (number <= target.number) {
				const windowSize = BigInt(this.bootstrapConcurrency - 1)
				const end = number + windowSize < target.number ? number + windowSize : target.number
				const numbers: bigint[] = []
				for (let next = number; next <= end; next++) numbers.push(next)
				const transformedBlocks = yield* Effect.forEach(numbers,
					(blockNumber) => transformBlock(this.client, this.index, blockNumber),
					{ concurrency: this.bootstrapConcurrency })
				for (const transformed of transformedBlocks) {
					if (checkpoint !== null && transformed.bundle.block.parentHash !== checkpoint.hash) {
						checkpoint = yield* this.recover(checkpoint, true)
						number = checkpoint === null ? this.index.startBlock : checkpoint.number + 1n
						continue syncLoop
					}
					const finalized = yield* finalizedAnchor(this.client)
					const nextFinalized = finalized !== null && finalized.number <= transformed.bundle.block.number
						? finalized : checkpoint?.finalized ?? null
					const next: IndexCheckpoint = {
						...blockData(transformed.bundle.block),
						indexId: this.index.id,
						version: this.index.version,
						chainId: this.client.config.network.chainId,
						startBlock: this.index.startBlock,
						finalized: nextFinalized,
					}
					yield* Effect.uninterruptible(this.store.commit({ checkpoint: next, rows: transformed.rows }))
					checkpoint = next
					number++
				}
			}
			return checkpoint
		})
	}

	run(): Stream.Stream<IndexCheckpoint | null, IndexerError | TransformError | StoreError> {
		const wake = Stream.merge(this.client.blocks.pipe(Stream.map(() => undefined)),
			Stream.tick(this.client.config.network.blockTime).pipe(Stream.map(() => undefined)))
		const reconcile = (): Effect.Effect<IndexCheckpoint | null, IndexerError | TransformError | StoreError> =>
			this.sync().pipe(Effect.retry({ times: 3, schedule: Schedule.exponential(100) }))
		return Stream.concat(Stream.fromEffect(reconcile()), wake.pipe(Stream.mapEffect(reconcile))).pipe(
			Stream.changesWith((left, right) => left?.hash === right?.hash && left?.version === right?.version),
		)
	}

	private recover(
		checkpoint: IndexCheckpoint | null,
		force = false,
	): Effect.Effect<IndexCheckpoint | null, IndexerError | StoreError> {
		if (checkpoint === null) return Effect.succeed(null)
		return Effect.gen({ self: this }, function* () {
			if (checkpoint.finalized !== null) {
				const finalized = yield* fetchBlock(this.client, checkpoint.finalized.number, false)
				if (finalized.hash !== checkpoint.finalized.hash) {
					return yield* Effect.fail<FinalizedChainConflict>({ _tag: "FinalizedChainConflict", anchor: checkpoint.finalized })
				}
			}
			if (!force) {
				const current = yield* fetchBlock(this.client, checkpoint.number, false).pipe(Effect.catch((error) =>
					error.cause === undefined ? Effect.succeed(null) : Effect.fail(error)))
				if (current !== null && current.hash === checkpoint.hash) return checkpoint
			}
			const recent = yield* this.store.recent(this.index.id, this.index.version, this.reorgDepth)
			let ancestor: IndexedBlock | undefined
			for (const stored of recent) {
				const canonical = yield* fetchBlock(this.client, stored.number, false).pipe(Effect.catch((error) =>
					error.cause === undefined ? Effect.succeed(null) : Effect.fail(error)))
				if (canonical !== null && canonical.hash === stored.hash) {
					ancestor = stored
					break
				}
			}
			const canRestart = recent.length > 0 && recent[recent.length - 1]?.number === this.index.startBlock
			if (ancestor === undefined && !canRestart) {
				return yield* Effect.fail<IndexReorgTooDeep>({ _tag: "IndexReorgTooDeep", checkpoint })
			}
			const orphaned = recent.filter((block) => ancestor === undefined || block.number > ancestor.number)
			const next = ancestor === undefined ? null : { ...checkpoint, ...ancestor }
			yield* Effect.uninterruptible(this.store.rollback({ indexId: this.index.id, version: this.index.version, orphaned, checkpoint: next }))
			return next
		})
	}
}
