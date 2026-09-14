import { Effect } from "effect"
import type { RpcBlock } from "./schema.js"

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
