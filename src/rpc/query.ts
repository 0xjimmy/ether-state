import { Deferred, Effect, Fiber, Ref, Schema } from "effect"
import type { Scope } from "effect"
import type { EvmClientError } from "./client.js"
import type { RpcMethodName, RpcResult } from "./schema.js"

type QueryError = EvmClientError | Schema.SchemaError

interface QueryState {
	readonly inFlight: ReadonlyMap<string, RunningQuery>
	readonly completed: ReadonlyMap<string, unknown>
}

interface RunningQuery {
	readonly deferred: Deferred.Deferred<unknown, QueryError>
	users: number
	cancel: Effect.Effect<void>
}

type QueryAction =
	| { readonly _tag: "Completed"; readonly value: unknown }
	| { readonly _tag: "Join"; readonly query: RunningQuery }
	| { readonly _tag: "Start"; readonly query: RunningQuery }

export interface RpcQueryCacheStats {
	readonly inFlight: number
	readonly completed: number
	readonly capacity: number
}

const stableKey = (value: unknown): string => {
	if (value === null) return "null"
	if (typeof value === "string") {
		const normalized = value.startsWith("0x") ? value.toLowerCase() : value
		return `s:${JSON.stringify(normalized)}`
	}
	if (typeof value === "bigint") return `i:${value.toString()}`
	if (typeof value === "number") return `n:${String(value)}`
	if (typeof value === "boolean") return value ? "b:1" : "b:0"
	if (typeof value === "undefined") return "u:"
	if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`
	if (typeof value === "object") {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableKey(Reflect.get(value, key))}`).join(",")}}`
	}
	if (typeof value === "symbol") return `y:${value.description ?? ""}`
	if (typeof value === "function") return "f:"
	return "unknown:"
}

export const rpcQueryKey = (options: {
	readonly chainId: bigint
	readonly method: RpcMethodName
	readonly params: unknown
}): string => `${options.chainId.toString()}:${options.method}:${stableKey(options.params)}`

export class RpcQueryCoordinator {
	private constructor(
		private readonly capacity: number,
		private readonly scope: Scope.Scope,
		private readonly state: Ref.Ref<QueryState>,
	) {}

	static make(options: {
		readonly capacity: number
		readonly scope: Scope.Scope
	}): Effect.Effect<RpcQueryCoordinator> {
		return Ref.make<QueryState>({ inFlight: new Map(), completed: new Map() }).pipe(
			Effect.map((state) => new RpcQueryCoordinator(Math.max(0, options.capacity), options.scope, state)),
		)
	}

	get stats(): Effect.Effect<RpcQueryCacheStats> {
		return Ref.get(this.state).pipe(Effect.map((state) => ({
			inFlight: state.inFlight.size,
			completed: state.completed.size,
			capacity: this.capacity,
		})))
	}

	get<Method extends RpcMethodName, Encoded>(options: {
		readonly key: string
		readonly result: Schema.Codec<RpcResult<Method>, Encoded>
		readonly load: Effect.Effect<RpcResult<Method>, EvmClientError>
		readonly keep: (result: RpcResult<Method>) => boolean
	}): Effect.Effect<RpcResult<Method>, QueryError> {
		return Effect.uninterruptibleMask((restore) => Effect.gen({ self: this }, function* () {
			const candidate: RunningQuery = {
				deferred: yield* Deferred.make<unknown, QueryError>(), users: 1, cancel: Effect.void,
			}
			const action = yield* Ref.modify(this.state, (state): readonly [QueryAction, QueryState] => {
				if (state.completed.has(options.key)) {
					const value = state.completed.get(options.key)
					const completed = new Map(state.completed)
					completed.delete(options.key)
					completed.set(options.key, value)
					return [{ _tag: "Completed", value }, { ...state, completed }]
				}
				const running = state.inFlight.get(options.key)
				if (running !== undefined) {
					running.users += 1
					return [{ _tag: "Join", query: running }, state]
				}
				return [
					{ _tag: "Start", query: candidate },
					{ ...state, inFlight: new Map(state.inFlight).set(options.key, candidate) },
				]
			})

			if (action._tag === "Completed") return yield* Schema.decodeUnknownEffect(options.result)(action.value)
			const query = action.query
			if (action._tag === "Start") {
				const run = options.load.pipe(
					Effect.flatMap((result) => Schema.encodeEffect(options.result)(result).pipe(
						Effect.tap((encoded) => options.keep(result) ? this.store(options.key, encoded) : Effect.void),
					)),
					Effect.onExit((exit) => this.remove(options.key, query).pipe(
						Effect.andThen(Deferred.done(query.deferred, exit)),
					)),
					Effect.interruptible,
				)
				const fiber = yield* Effect.forkIn(run, this.scope)
				query.cancel = Fiber.interrupt(fiber)
			}
			const value = yield* restore(Deferred.await(query.deferred)).pipe(Effect.ensuring(Effect.suspend(() => {
				query.users -= 1
				return query.users === 0 ? this.remove(options.key, query).pipe(Effect.andThen(query.cancel)) : Effect.void
			})))
			return yield* Schema.decodeUnknownEffect(options.result)(value)
		}))
	}

	private store(key: string, value: unknown): Effect.Effect<void> {
		if (this.capacity === 0) return Effect.void
		return Ref.update(this.state, (state) => {
			const completed = new Map(state.completed)
			completed.delete(key)
			completed.set(key, value)
			while (completed.size > this.capacity) {
				const oldest = completed.keys().next()
				if (oldest.done) break
				completed.delete(oldest.value)
			}
			return { ...state, completed }
		})
	}

	private remove(key: string, query: RunningQuery): Effect.Effect<void> {
		return Ref.update(this.state, (state) => {
			if (state.inFlight.get(key) !== query) return state
			const inFlight = new Map(state.inFlight)
			inFlight.delete(key)
			return { ...state, inFlight }
		})
	}
}
