import { Effect } from "effect"
import type { FullBlockUpdate } from "./client.js"
import type { RpcBlock, RpcLog, RpcReceipt } from "./schema.js"

export interface ReceiptBlockUpdate extends FullBlockUpdate {
	readonly receipts: readonly RpcReceipt[] | null
	readonly logs: readonly RpcLog[]
}

export const orderedReceipts = (block: RpcBlock, receipts: readonly RpcReceipt[]): readonly RpcReceipt[] | undefined => {
	if (receipts.length !== block.transactions.length) return undefined
	const byHash = new Map(receipts.map((receipt) => [receipt.transactionHash, receipt]))
	if (byHash.size !== receipts.length) return undefined
	const ordered: RpcReceipt[] = []
	let nextLogIndex = 0n
	for (const [index, tx] of block.transactions.entries()) {
		const hash = typeof tx === "string" ? tx : tx.hash
		const receipt = byHash.get(hash)
		if (receipt === undefined || receipt.blockHash !== block.hash || receipt.blockNumber !== block.number ||
			receipt.transactionIndex !== BigInt(index) || receipt.logs.some((log) => log.removed === true ||
				log.blockHash !== block.hash || log.blockNumber !== block.number || log.transactionHash !== hash ||
				log.transactionIndex !== BigInt(index) || log.logIndex === undefined || log.address === undefined ||
				log.data === undefined || log.topics === undefined)) return undefined
		for (const log of receipt.logs) if (log.logIndex !== nextLogIndex++) return undefined
		ordered.push(receipt)
	}
	return ordered
}

export interface BlockTimeUnavailable { readonly _tag: "BlockTimeUnavailable"; readonly cause: unknown }

export const estimateBlockTime = <E, R>(options: {
	readonly latest: RpcBlock
	readonly fetchBlock: (number: bigint) => Effect.Effect<RpcBlock | null, E, R>
}): Effect.Effect<number, BlockTimeUnavailable, R> => Effect.gen(function* () {
	if (options.latest.number < 31n) return yield* Effect.fail("At least 32 blocks are required")
	const previous = yield* Effect.forEach(Array.from({ length: 31 }, (_, i) => options.latest.number - BigInt(i + 1)),
		(number) => options.fetchBlock(number).pipe(Effect.flatMap((block) => block?.number === number
			? Effect.succeed(block) : Effect.fail("Sample block unavailable"))), { concurrency: 4 })
	let child = options.latest
	for (const parent of previous) {
		if (child.parentHash !== parent.hash || child.timestamp < parent.timestamp) {
			return yield* Effect.fail("Inconsistent block sample")
		}
		child = parent
	}
	const milliseconds = Number(options.latest.timestamp - child.timestamp) * 1_000 / 31
	if (!Number.isFinite(milliseconds) || milliseconds <= 0) return yield* Effect.fail("Invalid block spacing")
	return Math.max(100, Math.round(milliseconds / 100) * 100)
}).pipe(Effect.mapError((cause): BlockTimeUnavailable => ({ _tag: "BlockTimeUnavailable", cause })))
