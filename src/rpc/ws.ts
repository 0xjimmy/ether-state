import {
	Deferred,
	Effect,
	Exit,
	Option,
	PubSub,
	Ref,
	Schema,
	Schedule,
	Scope,
	Stream,
	SubscriptionRef,
} from "effect"
import { Socket } from "effect/unstable/socket"
import {
	getRpcMethod,
	QuantityFromHex,
	type RpcError,
	type RpcId,
	type RpcParams,
	type RpcResult,
	type RpcReceipt,
	type WsRpcMethodName,
} from "./schema.js"

export interface WsRequestTimeout {
	readonly _tag: "WsRequestTimeout"
	readonly endpoint: string
	readonly method: string
}

export type RpcWsError = RpcError | Schema.SchemaError | Socket.SocketError | WsRequestTimeout

export type WsConnectionState =
	| { readonly _tag: "Connecting"; readonly attempt: number }
	| { readonly _tag: "Connected"; readonly connectedAt: number }
	| { readonly _tag: "Reconnecting"; readonly attempt: number; readonly error: Socket.SocketError }
	| { readonly _tag: "Closed" }

export interface WsNotification {
	readonly subscription: string
	readonly result: unknown
	readonly receivedAt: number
}

export interface WsBlockHead {
	readonly number: bigint
	readonly hash: string
	readonly parentHash: string
	readonly logsBloom: string
	readonly timestamp: bigint
	readonly observedAt: number
}

export interface WsState {
	readonly endpoint: string
	readonly close: Effect.Effect<void>
	readonly connection: SubscriptionRef.SubscriptionRef<WsConnectionState>
	readonly connections: Stream.Stream<WsConnectionState>
	readonly notifications: Stream.Stream<WsNotification>
	readonly request: <Method extends WsRpcMethodName>(options: {
		readonly method: Method
		readonly inputParams: RpcParams<Method>
	}) => Effect.Effect<RpcResult<Method>, RpcWsError>
}

export interface MakeWsStateOptions {
	readonly endpoint: string
	readonly requestTimeout?: number
	readonly reconnectDelay?: number
}

export interface EthWsRpcOptions<Method extends WsRpcMethodName> {
	readonly method: Method
	readonly state: WsState
	readonly inputParams: RpcParams<Method>
}

export interface EthWsRpcOnceOptions<Method extends WsRpcMethodName> {
	readonly method: Method
	readonly endpoint: string
	readonly inputParams: RpcParams<Method>
	readonly requestTimeout?: number
}

interface PendingRequest {
	readonly complete: (message: string) => Effect.Effect<void>
	readonly fail: (error: Socket.SocketError) => Effect.Effect<void>
}

const IncomingRoute: Schema.Codec<
	| { readonly jsonrpc: "2.0"; readonly id: RpcId | null }
	| { readonly jsonrpc: "2.0"; readonly method: "eth_subscription"; readonly params: {
		readonly subscription: string
		readonly result: unknown
	} },
	string
> = Schema.fromJsonString(Schema.Union([
	Schema.Struct({
		jsonrpc: Schema.Literal("2.0"),
		id: Schema.Union([Schema.String, Schema.Number, Schema.Null]),
	}),
	Schema.Struct({
		jsonrpc: Schema.Literal("2.0"),
		method: Schema.Literal("eth_subscription"),
		params: Schema.Struct({ subscription: Schema.String, result: Schema.Unknown }),
	}),
]))

const NewHead: Schema.Codec<Omit<WsBlockHead, "observedAt">, {
	readonly number: string
	readonly hash: string
	readonly parentHash: string
	readonly logsBloom: string
	readonly timestamp: string
}> = Schema.Struct({
	number: QuantityFromHex,
	hash: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{64}$/)),
	parentHash: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{64}$/)),
	logsBloom: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{512}$/)),
	timestamp: QuantityFromHex,
})

const removePending = (
	pending: Ref.Ref<ReadonlyMap<RpcId, PendingRequest>>,
	id: RpcId,
): Effect.Effect<Option.Option<PendingRequest>> => Ref.modify(pending, (requests) => {
	const request = requests.get(id)
	if (request === undefined) return [Option.none(), requests]
	const next = new Map(requests)
	next.delete(id)
	return [Option.some(request), next]
})

const failPending = (
	pending: Ref.Ref<ReadonlyMap<RpcId, PendingRequest>>,
	error: Socket.SocketError,
): Effect.Effect<void> => Ref.getAndSet(pending, new Map()).pipe(
	Effect.flatMap((requests) => Effect.forEach(requests.values(), (request) => request.fail(error), { discard: true })),
)

const makeRequest = <Method extends WsRpcMethodName>(options: {
	readonly method: Method
	readonly inputParams: RpcParams<Method>
	readonly endpoint: string
	readonly writer: Socket.Writer
	readonly pending: Ref.Ref<ReadonlyMap<RpcId, PendingRequest>>
	readonly nextId: Ref.Ref<number>
	readonly timeout: number
}): Effect.Effect<RpcResult<Method>, RpcWsError> => Effect.gen(function* () {
	const definition = getRpcMethod(options.method)
	const id = yield* Ref.getAndUpdate(options.nextId, (current) => current + 1)
	const deferred = yield* Deferred.make<RpcResult<Method>, RpcWsError>()
	const requestJson = Schema.fromJsonString(definition.request)
	const responseJson = Schema.fromJsonString(definition.response)
	const request = yield* Schema.encodeEffect(requestJson)({
		jsonrpc: "2.0",
		method: definition.method,
		params: options.inputParams,
		id,
	})
	const entry: PendingRequest = {
		complete: (message) => Schema.decodeUnknownEffect(responseJson)(message).pipe(
			Effect.flatMap((response) => "error" in response
				? Deferred.fail(deferred, response.error)
				: Deferred.succeed(deferred, response.result)),
			Effect.catchCause((cause) => Deferred.failCause(deferred, cause)),
			Effect.asVoid,
		),
		fail: (error) => Deferred.fail(deferred, error).pipe(Effect.asVoid),
	}
	yield* Ref.update(options.pending, (requests) => new Map(requests).set(id, entry))
	return yield* options.writer.write(request).pipe(
		Effect.andThen(Deferred.await(deferred)),
		Effect.timeoutOrElse({
			duration: options.timeout,
			orElse: () => Effect.fail<WsRequestTimeout>({
				_tag: "WsRequestTimeout",
				endpoint: options.endpoint,
				method: options.method,
			}),
		}),
		Effect.ensuring(removePending(options.pending, id)),
	)
})

export const makeWsState = (
	options: MakeWsStateOptions,
): Effect.Effect<WsState, never, Scope.Scope | Socket.WebSocketConstructor> => Effect.gen(function* () {
	const stateScope = yield* Scope.make()
	yield* Effect.addFinalizer(() => Scope.close(stateScope, Exit.void))
	const socket = yield* Socket.makeWebSocket(options.endpoint, { openTimeout: options.requestTimeout ?? 10_000 })
	const writer = yield* Scope.provide(socket.writer, stateScope)
	const connection = yield* SubscriptionRef.make<WsConnectionState>({ _tag: "Connecting", attempt: 0 })
	const notifications = yield* PubSub.unbounded<WsNotification>()
	const pending = yield* Ref.make<ReadonlyMap<RpcId, PendingRequest>>(new Map())
	const nextId = yield* Ref.make(1)
	const requestTimeout = options.requestTimeout ?? 10_000
	const reconnectDelay = options.reconnectDelay ?? 500

	const dispatch = (message: string): Effect.Effect<void> => Schema.decodeUnknownEffect(IncomingRoute)(message).pipe(
		Effect.matchEffect({
			onFailure: () => Effect.void,
			onSuccess: (route) => {
				if ("method" in route) {
					return PubSub.publish(notifications, {
						subscription: route.params.subscription,
						result: route.params.result,
						receivedAt: Date.now(),
					}).pipe(Effect.asVoid)
				}
				if (route.id === null) return Effect.void
				return removePending(pending, route.id).pipe(
					Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (request) => request.complete(message) })),
				)
			},
		}),
	)

	const supervise = (attempt: number): Effect.Effect<void> => Effect.suspend(() => Effect.scoped(Effect.gen(function* () {
		yield* SubscriptionRef.set(connection, { _tag: "Connecting", attempt })
		const reader = yield* Socket.readerString(socket)
		yield* SubscriptionRef.set(connection, { _tag: "Connected", connectedAt: Date.now() })
		return yield* Effect.forever(Effect.gen(function* () {
			const messages = yield* reader
			yield* Effect.forEach(messages, dispatch, { discard: true })
		}))
	})).pipe(Effect.matchEffect({
		onFailure: (error) => Effect.gen(function* () {
			yield* failPending(pending, error)
			yield* SubscriptionRef.set(connection, { _tag: "Reconnecting", attempt: attempt + 1, error })
			yield* Effect.sleep(Math.min(30_000, reconnectDelay * (2 ** Math.min(attempt, 6))))
			return yield* supervise(attempt + 1)
		}),
		onSuccess: () => supervise(0),
	})))

	yield* Scope.addFinalizer(stateScope, SubscriptionRef.set(connection, { _tag: "Closed" }))
	yield* Effect.forkIn(supervise(0), stateScope)

	const state: WsState = {
		endpoint: options.endpoint,
		close: Scope.close(stateScope, Exit.void),
		connection,
		connections: SubscriptionRef.changes(connection),
		notifications: Stream.fromPubSub(notifications),
		request: (requestOptions) => makeRequest({
			...requestOptions,
			endpoint: options.endpoint,
			writer,
			pending,
			nextId,
			timeout: requestTimeout,
		}),
	}
	return state
})

export const ethWsRpc = <Method extends WsRpcMethodName>(
	options: EthWsRpcOptions<Method>,
): Effect.Effect<RpcResult<Method>, RpcWsError> => options.state.request(options)

export const ethWsRpcOnce = <Method extends WsRpcMethodName>(
	options: EthWsRpcOnceOptions<Method>,
): Effect.Effect<RpcResult<Method>, RpcWsError, Socket.WebSocketConstructor> => Effect.scoped(Effect.gen(function* () {
	const state = yield* makeWsState(options.requestTimeout === undefined
		? { endpoint: options.endpoint }
		: { endpoint: options.endpoint, requestTimeout: options.requestTimeout })
	return yield* state.request(options)
}))

const watchSubscription = <A, I>(
	state: WsState,
	params: RpcParams<"eth_subscribe">,
	schema: Schema.Codec<A, I>,
): Stream.Stream<{ readonly value: A; readonly observedAt: number }, RpcWsError> => state.connections.pipe(
	Stream.switchMap((connection) => {
		if (connection._tag !== "Connected") return Stream.empty
		return Stream.unwrap(Effect.acquireRelease(
			state.request({ method: "eth_subscribe", inputParams: params }),
			(subscription) => SubscriptionRef.get(state.connection).pipe(Effect.flatMap((current) =>
				current === connection ? state.request({ method: "eth_unsubscribe", inputParams: [subscription] }).pipe(Effect.ignore)
					: Effect.void)),
		).pipe(
			Effect.map((subscription) => state.notifications.pipe(
				Stream.filter((notification) => notification.subscription === subscription),
				Stream.mapEffect((notification) => Schema.decodeUnknownEffect(schema)(notification.result).pipe(
					Effect.map((value) => ({ value, observedAt: notification.receivedAt })),
				)),
			)),
		)).pipe(Stream.catch((error) => {
			if (error._tag === "RpcError" && (error.code === -32601 || error.code === -32602 || error.code === -32004)) {
				return Stream.empty
			}
			return Stream.fail(error)
		}), Stream.retry(Schedule.spaced(1_000)))
	}),
)

export const ethWsWatchNewHeads = (state: WsState): Stream.Stream<WsBlockHead, RpcWsError> =>
	watchSubscription(state, ["newHeads"], NewHead).pipe(
		Stream.map(({ value, observedAt }) => ({ ...value, observedAt })),
	)

export const ethWsWatchReceipts = (state: WsState): Stream.Stream<readonly RpcReceipt[], RpcWsError> =>
	watchSubscription(state, ["transactionReceipts", {}], getRpcMethod("eth_getBlockReceipts").result).pipe(
		Stream.map(({ value }) => value ?? []),
	)
