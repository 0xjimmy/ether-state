import { Effect, Schema } from "effect"
import type { EvmClient } from "../rpc/client.js"
import type { ContractRead } from "../rpc/multicall.js"
import type { RpcLog, RpcLogFilter } from "../rpc/schema.js"
import { matchesLog } from "../rpc/watch.js"
import type { IndexedBlock } from "./index.js"
import { modelFailure, type ModelBatch, type ModelFailure } from "./model-store.js"

export interface ReadContext {
	readonly client: EvmClient
	readonly block: IndexedBlock
	readonly read: (transaction: ContractRead["transaction"]) => Effect.Effect<string, ModelFailure>
}
export const readContext = (client: EvmClient, block: IndexedBlock): ReadContext => ({ client, block,
	read: (transaction) => client.call({ transaction, block: { blockHash: block.hash, requireCanonical: true } })
		.pipe(Effect.mapError((cause) => modelFailure("source", cause))),
})
export interface LogSource<A> {
	readonly name: string
	readonly filter: RpcLogFilter
	readonly capture: (logs: readonly RpcLog[]) => Effect.Effect<readonly unknown[], ModelFailure>
	readonly decode: (values: readonly unknown[]) => Effect.Effect<readonly A[], ModelFailure>
}
export const Source: {
	readonly logs: <A>(options: {
		readonly name: string
		readonly filter: RpcLogFilter
		readonly schema: Schema.Codec<A>
		readonly decode: (log: RpcLog) => Effect.Effect<A | null, unknown>
	}) => LogSource<A>
} = {
	logs: (options) => {
		const codec = Schema.toCodecJson(options.schema)
		return {
			name: options.name, filter: options.filter,
			capture: (logs) => Effect.forEach(logs.filter((log) => matchesLog(log, options.filter)), (log) => options.decode(log)).pipe(
				Effect.flatMap((values) => Effect.forEach(values.filter((value) => value !== null), (value) => Schema.encodeEffect(codec)(value))),
				Effect.mapError((cause) => modelFailure("source", cause))),
			decode: (values) => Effect.forEach(values, (value) => Schema.decodeUnknownEffect(codec)(value)).pipe(Effect.mapError((cause) => modelFailure("source", cause))),
		}
	},
}
export interface ProjectionContext extends ReadContext {
	readonly batches: readonly ModelBatch[]
}
export interface Projection<A> {
	readonly kind: "state" | "partitioned"
	readonly source: LogSource<unknown>
	readonly interval: bigint | null
	readonly decode: (encoded: unknown) => Effect.Effect<A, ModelFailure>
	readonly seed: (context: ReadContext) => Effect.Effect<unknown, ModelFailure>
	readonly project: (previous: unknown, context: ProjectionContext) => Effect.Effect<unknown, ModelFailure>
}
export type ProjectionValue<P> = P extends Projection<infer A> ? A : never

export const Projection: {
	readonly state: <E, A>(options: {
		readonly source: LogSource<E>
		readonly schema: Schema.Codec<A>
		readonly seed: (context: ReadContext) => Effect.Effect<A, unknown>
		readonly reduce: (context: ReadContext & { readonly state: A; readonly events: readonly E[] }) => Effect.Effect<A, unknown>
	}) => Projection<A>
	readonly partitioned: <E, A>(options: {
		readonly source: LogSource<E>
		readonly schema: Schema.Codec<A>
		readonly intervalSeconds: bigint
		readonly rebuild: (context: { readonly events: readonly { readonly value: E; readonly block: IndexedBlock }[];
			readonly block: IndexedBlock }) => Effect.Effect<A, unknown>
	}) => Projection<A>
} = {
	state: (options) => {
		const codec = Schema.toCodecJson(options.schema)
		const decode = Schema.decodeUnknownEffect(codec)
		const encode = Schema.encodeEffect(codec)
		return {
			kind: "state", source: options.source, interval: null,
			decode: (value) => decode(value).pipe(Effect.mapError((cause) => modelFailure("projection", cause))),
			seed: (context) => options.seed(context).pipe(Effect.flatMap(encode), Effect.mapError((cause) => modelFailure("projection", cause))),
			project: (previous, context) => Effect.gen(function* () {
				let state = yield* decode(previous)
				for (const batch of context.batches) {
					const events = yield* options.source.decode(batch.sources[options.source.name] ?? [])
					state = yield* options.reduce({ ...readContext(context.client, batch.block), state, events })
				}
				return yield* encode(state)
			}).pipe(Effect.mapError((cause) => modelFailure("projection", cause))),
		}
	},
	partitioned: (options) => {
		const codec = Schema.toCodecJson(options.schema)
		return {
			kind: "partitioned", source: options.source, interval: options.intervalSeconds,
			decode: (value) => Schema.decodeUnknownEffect(codec)(value).pipe(Effect.mapError((cause) => modelFailure("projection", cause))),
			seed: () => Effect.succeed(null),
			project: (_previous, context) => Effect.gen(function* () {
				const groups = yield* Effect.forEach(context.batches, (batch) => options.source.decode(batch.sources[options.source.name] ?? []).pipe(
					Effect.map((values) => values.map((value) => ({ value, block: batch.block })))))
				const value = yield* options.rebuild({ events: groups.flat(), block: context.block })
				return yield* Schema.encodeEffect(codec)(value)
			}).pipe(Effect.mapError((cause) => modelFailure("projection", cause))),
		}
	},
}
