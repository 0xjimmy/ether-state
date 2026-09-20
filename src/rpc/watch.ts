import { Effect, Schedule, Stream, SubscriptionRef } from "effect"
import type { Schema, Scope } from "effect"
import type { EvmClient, BlockHead } from "./client.js"
import type { ContractRead, CallError } from "./multicall.js"
import { shouldResumeWatch } from "./recovery.js"
import type { RpcBlock, RpcLog, RpcLogFilter } from "./schema.js"

export interface BlockLogBatch {
	readonly block: Pick<RpcBlock, "number" | "hash" | "parentHash" | "timestamp" | "logsBloom">
	readonly observedAt: number
	readonly logs: readonly RpcLog[]
}

export const matchesLog = (log: RpcLog, filter: RpcLogFilter): boolean => {
	const addresses = typeof filter.address === "string" ? [filter.address] : filter.address
	if (addresses !== undefined && !addresses.some((address) => address.toLowerCase() === log.address?.toLowerCase())) return false
	return (filter.topics ?? []).every((topic, index) => topic === null || (typeof topic === "string" ? [topic] : topic)
		.some((value) => value === null || value.toLowerCase() === log.topics?.[index]?.toLowerCase()))
}

export interface WatchedCall<A> {
	readonly value: A
	readonly block: BlockHead
}

export type WatchedState<A> =
	| { readonly _tag: "Loading" }
	| { readonly _tag: "Failed"; readonly error: CallError | Schema.SchemaError; readonly previous: WatchedCall<A> | undefined }
	| { readonly _tag: "Ready"; readonly current: WatchedCall<A> }
	| { readonly _tag: "Retrying"; readonly error: CallError | Schema.SchemaError; readonly previous: WatchedCall<A> | undefined }

export interface WatchCallOptions<A> extends Omit<ContractRead, "block"> {
	readonly decode: (data: string) => Effect.Effect<A, Schema.SchemaError>
	readonly equals?: (left: A, right: A) => boolean
}

export const callChanges = <A>(client: EvmClient, options: WatchCallOptions<A>,
	onFailure: (error: CallError | Schema.SchemaError) => Effect.Effect<void> = () => Effect.void,
): Stream.Stream<WatchedCall<A>, CallError | Schema.SchemaError> =>
	client.watchBlocks().pipe(Stream.filter((block): block is BlockHead & { readonly hash: string } => block.hash !== null),
		Stream.buffer({ capacity: 1, strategy: "sliding" }),
		Stream.mapEffect((block) => client.call({ transaction: options.transaction,
			block: { blockHash: block.hash, requireCanonical: true },
			...(options.multicall === undefined ? {} : { multicall: options.multicall }) }).pipe(Effect.flatMap(options.decode),
			Effect.tapError(onFailure), Effect.map((value) => ({ value, block })))),
		// Re-subscribe to the current head after an outage. Do not retry an obsolete head forever.
		Stream.retry(($) => $(Schedule.spaced(500)).pipe(Schedule.while(({ input }) => shouldResumeWatch(input)))),
		Stream.changesWith((a, b) => options.equals?.(a.value, b.value) ?? false))

export const makeWatchedState = <A>(client: EvmClient, options: WatchCallOptions<A>): Effect.Effect<{
	readonly current: Effect.Effect<WatchedState<A>>
	readonly changes: Stream.Stream<WatchedState<A>>
}, never, Scope.Scope> => Effect.gen(function* () {
	const state = yield* SubscriptionRef.make<WatchedState<A>>({ _tag: "Loading" })
	let previous: WatchedCall<A> | undefined

	yield* callChanges(client, options, (error) => SubscriptionRef.set(state, {
		_tag: shouldResumeWatch(error) ? "Retrying" : "Failed", error, previous,
	})).pipe(Stream.runForEach((current) => {
		previous = current
		return SubscriptionRef.set(state, { _tag: "Ready", current })
	}), Effect.catch(() => Effect.void), Effect.forkScoped)
	return { current: SubscriptionRef.get(state), changes: SubscriptionRef.changes(state) }
})
