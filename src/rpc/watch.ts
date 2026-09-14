import { Effect, Schedule, Stream, SubscriptionRef } from "effect"
import type { Schema, Scope } from "effect"
import type { EvmClient, BlockHead } from "./client.js"
import type { ContractRead, CallError } from "./multicall.js"
import type { RpcLog, RpcLogFilter } from "./schema.js"

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
	| { readonly _tag: "Ready"; readonly current: WatchedCall<A> }
	| { readonly _tag: "Retrying"; readonly error: CallError | Schema.SchemaError; readonly previous: WatchedCall<A> | undefined }

export interface WatchCallOptions<A> extends Omit<ContractRead, "block"> {
	readonly decode: (data: string) => Effect.Effect<A, Schema.SchemaError>
	readonly equals?: (left: A, right: A) => boolean
}

export const callChanges = <A>(client: EvmClient, options: WatchCallOptions<A>): Stream.Stream<WatchedCall<A>, CallError | Schema.SchemaError> =>
	client.watchBlocks().pipe(Stream.mapEffect((block) => client.call({ transaction: options.transaction, block: block.number,
		...(options.multicall === undefined ? {} : { multicall: options.multicall }) }).pipe(Effect.flatMap(options.decode),
		Effect.retry({ times: 2, schedule: Schedule.spaced(500), while: (error) => error._tag !== "ContractReverted" && error._tag !== "SchemaError" }),
		Effect.map((value) => ({ value, block })))), Stream.changesWith((a, b) => options.equals?.(a.value, b.value) ?? false))

export const makeWatchedState = <A>(client: EvmClient, options: WatchCallOptions<A>): Effect.Effect<{
	readonly current: Effect.Effect<WatchedState<A>>
	readonly changes: Stream.Stream<WatchedState<A>>
}, never, Scope.Scope> => Effect.gen(function* () {
	const state = yield* SubscriptionRef.make<WatchedState<A>>({ _tag: "Loading" })
	let previous: WatchedCall<A> | undefined
	yield* client.watchBlocks().pipe(Stream.runForEach((block) => client.call({ transaction: options.transaction, block: block.number,
		...(options.multicall === undefined ? {} : { multicall: options.multicall }) }).pipe(Effect.flatMap(options.decode), Effect.matchEffect({
		onFailure: (error) => SubscriptionRef.set(state, { _tag: "Retrying", error, previous }),
		onSuccess: (value) => {
			previous = { value, block }
			return SubscriptionRef.set(state, { _tag: "Ready", current: previous })
		},
	}))), Effect.forkScoped)
	return { current: SubscriptionRef.get(state), changes: SubscriptionRef.changes(state) }
})
