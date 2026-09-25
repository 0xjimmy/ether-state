import { Effect, Option, Stream } from "effect"
import type { BlockHead, EvmClientError } from "./client.js"
import type { ReceiptBlockUpdate } from "./live.js"

export type ChainUpdate =
	| { readonly kind: "apply"; readonly value: ReceiptBlockUpdate }
	| { readonly kind: "revert"; readonly from: bigint; readonly ancestor: ReceiptBlockUpdate }

/** One ordered acquisition cursor. Subscriber filters never own RPC work. */
export function liveChain(options: {
	readonly heads: Stream.Stream<BlockHead>
	readonly load: (number: bigint) => Effect.Effect<ReceiptBlockUpdate, EvmClientError>
	readonly header: (number: bigint) => Effect.Effect<BlockHead, EvmClientError>
	readonly recover: <A>(work: Effect.Effect<A, EvmClientError>) => Effect.Effect<A>
}): Stream.Stream<ChainUpdate> {
	return Stream.suspend(() => {
		const retained = new Map<bigint, ReceiptBlockUpdate>()
		const ready = new Map<bigint, ReceiptBlockUpdate>()
		let cursor: ReceiptBlockUpdate | undefined
		return Stream.unfold<undefined, readonly ChainUpdate[], never, never>(undefined, () => options.recover(Effect.gen(function* () {
			const previous = cursor
			const head = yield* options.heads.pipe(Stream.filter(head => head.hash !== null &&
				(previous === undefined || head.number > previous.number || (head.number === previous.number && head.hash !== previous.hash))),
				Stream.runHead, Effect.flatMap(Option.match({ onNone: () => Effect.interrupt, onSome: Effect.succeed })))
			const from = previous === undefined ? head.number : previous.number + 1n
			const through = head.number < from + 7n ? head.number : from + 7n
			const numbers = previous !== undefined && head.number === previous.number
				? [head.number] : Array.from({ length: Number(through - from + 1n) }, (_, index) => from + BigInt(index))
			const updates = yield* Effect.forEach(numbers, number => {
				const cached = ready.get(number)
				return cached ? Effect.succeed(cached) : options.load(number).pipe(Effect.tap(value => Effect.sync(() => { ready.set(number, value) })))
			}, { concurrency: 8 })
			if (previous && updates.length === 1 && updates[0]?.number === previous.number && updates[0].hash === previous.hash) {
				ready.delete(previous.number)
				return [[], undefined] as const
			}
			let parent = previous
			for (const value of updates) {
				if (parent !== undefined && (value.number !== parent.number + 1n || value.parentHash !== parent.hash)) {
					// Resolve the common ancestor once for every consumer of this chain.
					for (const [number, old] of [...retained].reverse()) {
						const canonical = yield* options.header(number)
						if (canonical.hash !== old.hash) continue
						ready.clear()
						if (number === previous?.number && value.number > number) {
							// The provider returned a stale child. Retry acquisition, not a false reorg.
							return yield* Effect.fail({ _tag: "BlockUnavailable" } as const)
						}
						for (const height of retained.keys()) if (height > number) retained.delete(height)
						cursor = old
						return [[{ kind: "revert", from: number + 1n, ancestor: old } satisfies ChainUpdate], undefined] as const
					}
					ready.clear()
					return yield* Effect.fail({ _tag: "BlockUnavailable" } as const)
				}
				parent = value
			}
			for (const value of updates) { retained.set(value.number, value); ready.delete(value.number); cursor = value }
			while (retained.size > 128) { const first = retained.keys().next(); if (!first.done) retained.delete(first.value) }
			return [updates.map(value => ({ kind: "apply", value } satisfies ChainUpdate)), undefined] as const
		}))).pipe(Stream.flattenIterable)
	})
}
