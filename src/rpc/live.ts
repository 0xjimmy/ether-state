import { Effect, Option, Stream, SubscriptionRef } from "effect"
import type { BlockHead, FullBlockUpdate } from "./client.js"
import type { RpcBlock, RpcLog, RpcReceipt } from "./schema.js"

type FullBlock = FullBlockUpdate["block"]

export interface ReceiptBlockUpdate extends FullBlockUpdate {
	readonly receipts: readonly RpcReceipt[]
	readonly logs: readonly RpcLog[]
}

export interface LiveState {
	readonly fullUsers: number
	readonly receiptUsers: number
	readonly heads: ReadonlyMap<string, BlockHead>
	readonly blocks: ReadonlyMap<string, FullBlock>
	readonly receipts: ReadonlyMap<string, ReadonlyMap<string, RpcReceipt>>
}

export interface BlockPlan {
	readonly number: bigint
	readonly full: boolean
	readonly dueAt: number
}

const retain = <A>(entries: ReadonlyMap<string, A>, key: string, value: A): ReadonlyMap<string, A> => {
	const next = new Map(entries).set(key, value)
	while (next.size > 32) {
		const first = next.keys().next()
		if (first.done) break
		next.delete(first.value)
	}
	return next
}

export const blockReceipts = (state: LiveState, hash: string): readonly RpcReceipt[] | undefined => {
	const block = state.blocks.get(hash)
	if (block === undefined) return undefined
	if (block.transactions.length === 0) return []
	const found = state.receipts.get(hash)
	if (found === undefined) return undefined
	const ordered: RpcReceipt[] = []
	for (const [index, tx] of block.transactions.entries()) {
		const receipt = found.get(tx.hash)
		if (receipt === undefined || receipt.blockHash !== hash || receipt.blockNumber !== block.number ||
			receipt.transactionIndex !== BigInt(index) || receipt.logs.some((log) =>
				log.removed === true || log.blockHash !== hash || log.blockNumber !== block.number ||
				log.transactionHash !== tx.hash || log.transactionIndex !== BigInt(index) || log.logIndex === undefined ||
				log.address === undefined || log.data === undefined || log.topics === undefined)) {
			return undefined
		}
		ordered.push(receipt)
	}
	return ordered
}

const pending = (state: LiveState): LiveState => ({
	...state,
	heads: new Map([...state.heads].filter(([hash]) => !state.blocks.has(hash) ||
		(state.receiptUsers > 0 && blockReceipts(state, hash) === undefined))),
})

export class LiveBlocks {
	private constructor(readonly state: SubscriptionRef.SubscriptionRef<LiveState>) {}

	static make(): Effect.Effect<LiveBlocks> {
		return SubscriptionRef.make<LiveState>({
			fullUsers: 0, receiptUsers: 0, heads: new Map(), blocks: new Map(), receipts: new Map(),
		}).pipe(Effect.map((state) => new LiveBlocks(state)))
	}

	demand(kind: "fullUsers" | "receiptUsers", amount: number, head: Option.Option<BlockHead>): Effect.Effect<void> {
		return SubscriptionRef.update(this.state, (state) => pending({
			...state,
			[kind]: state[kind] + amount,
			heads: amount > 0 && Option.isSome(head) && head.value.hash !== null
				? new Map(state.fullUsers + state.receiptUsers === 0 ? [] : state.heads).set(head.value.hash, head.value)
				: state.heads,
		}))
	}

	observe(head: BlockHead): Effect.Effect<void> {
		return SubscriptionRef.update(this.state, (state) => head.hash === null || state.heads.has(head.hash) ||
			state.fullUsers + state.receiptUsers === 0 ? state : pending({
				...state, heads: new Map(state.heads).set(head.hash, head),
			}))
	}

	acceptBlock(block: RpcBlock): Effect.Effect<void> {
		if (block.transactions.some((tx, index) => typeof tx === "string" || tx.blockHash !== block.hash ||
			tx.blockNumber !== block.number || tx.transactionIndex !== BigInt(index))) return Effect.void
		const transactions = block.transactions.filter((tx) => typeof tx !== "string")
		if (new Set(transactions.map((tx) => tx.hash)).size !== transactions.length) return Effect.void
		return SubscriptionRef.update(this.state, (state) => state.blocks.has(block.hash) ? state : pending({
			...state, blocks: retain(state.blocks, block.hash, { ...block, transactions }),
		}))
	}

	acceptReceipts(receipts: readonly RpcReceipt[]): Effect.Effect<void> {
		return SubscriptionRef.update(this.state, (state) => {
			let next = state.receipts
			for (const receipt of receipts) {
				if (receipt.logs.some((log) => log.removed === true || log.blockHash !== receipt.blockHash ||
					log.blockNumber !== receipt.blockNumber || log.transactionHash !== receipt.transactionHash ||
					log.transactionIndex !== receipt.transactionIndex || log.logIndex === undefined ||
					log.address === undefined || log.data === undefined || log.topics === undefined)) continue
				const block = new Map(next.get(receipt.blockHash)).set(receipt.transactionHash, receipt)
				next = retain(next, receipt.blockHash, block)
			}
			return pending({ ...state, receipts: next })
		})
	}

	plan(state: LiveState, head: BlockHead, blockTime: number, receipts: boolean): BlockPlan | undefined {
		const full = state.fullUsers + state.receiptUsers > 0
		if (receipts && state.receiptUsers === 0) return undefined
		if (full) {
			for (const [hash, pending] of state.heads) {
				if (receipts ? blockReceipts(state, hash) === undefined : !state.blocks.has(hash)) {
					return { number: pending.number, full, dueAt: 0 }
				}
			}
		}
		return {
			number: head.hash === null ? head.number : head.number + 1n,
			full,
			dueAt: head.hash === null || head.timestamp === null ? 0 : Number(head.timestamp) * 1_000 + blockTime - 150,
		}
	}

	waitFull(head: BlockHead): Effect.Effect<FullBlockUpdate> {
		return this.observe(head).pipe(Effect.andThen(SubscriptionRef.changes(this.state).pipe(
			Stream.map((state) => head.hash === null ? undefined : state.blocks.get(head.hash)),
			Stream.filter((block) => block !== undefined),
			Stream.map((block) => ({ ...head, block })),
			Stream.runHead,
			Effect.flatMap(Option.match({ onNone: () => Effect.interrupt, onSome: Effect.succeed })),
		)))
	}

	waitReceipts(update: FullBlockUpdate): Effect.Effect<ReceiptBlockUpdate> {
		return this.observe(update).pipe(Effect.andThen(SubscriptionRef.changes(this.state).pipe(
			Stream.map((state) => blockReceipts(state, update.block.hash)),
			Stream.filter((receipts) => receipts !== undefined),
			Stream.map((receipts) => ({ ...update, receipts, logs: receipts.flatMap((receipt) => receipt.logs) })),
			Stream.runHead,
			Effect.flatMap(Option.match({ onNone: () => Effect.interrupt, onSome: Effect.succeed })),
		)))
	}
}
