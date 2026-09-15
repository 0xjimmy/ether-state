import { Cause, Effect, Exit, Option, Schema, Stream } from "effect"
import type { EvmClient, EvmClientError, HedgeableRpcMethodName } from "./rpc/client.js"
import type { CallError } from "./rpc/multicall.js"
import { getRpcMethod, RpcMethods, type RpcBlock, type RpcFilter, type RpcLog, type RpcLogFilter } from "./rpc/schema.js"

export class ViemAdapterError extends Error {
	readonly code: number
	readonly data?: unknown

	constructor(message: string, options: { readonly code: number; readonly data?: unknown; readonly cause?: unknown }) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause })
		this.name = "ViemAdapterError"
		this.code = options.code
		if (options.data !== undefined) this.data = options.data
	}
}

export interface ViemRequest {
	readonly method: string
	readonly params?: unknown
}

interface ViemSubscriptionData { readonly result: unknown }
interface ViemSubscription {
	readonly params: readonly unknown[]
	readonly onData: (data: ViemSubscriptionData) => void
	readonly onError: (error: Error) => void
}
interface ViemSubscriptionHandle { readonly unsubscribe: () => void }
interface ViemTransportValue {
	readonly subscribe: (subscription: ViemSubscription) => Promise<ViemSubscriptionHandle>
}

export interface ViemRequestFunction {
	<ReturnType = unknown>(input: ViemRequest, options?: unknown): Promise<ReturnType>
}

export interface EvmClientViemTransport {
	(options?: Readonly<Record<string, unknown>>): {
		readonly config: {
			readonly key: "ether-state"
			readonly name: "EvmClient"
			readonly request: ViemRequestFunction
			readonly retryCount: 0
			readonly type: "webSocket"
		}
		readonly request: ViemRequestFunction
		readonly value: ViemTransportValue
	}
}

const excludedMethods: ReadonlySet<string> = new Set([
	"eth_accounts",
	"eth_fillTransaction",
	"eth_getFilterChanges",
	"eth_getFilterLogs",
	"eth_newBlockFilter",
	"eth_newFilter",
	"eth_newPendingTransactionFilter",
	"eth_sendRawTransaction",
	"eth_sendTransaction",
	"eth_sign",
	"eth_signTransaction",
	"eth_uninstallFilter",
])
const publicMethods = new Set(Object.entries(RpcMethods)
	.filter(([, definition]) => definition.tags.includes("http"))
	.map(([method]) => method)
	.filter((method) => !excludedMethods.has(method)))
const isHedgeableMethod = (method: string): method is HedgeableRpcMethodName => publicMethods.has(method)

const adapterError = (error: unknown): ViemAdapterError => {
	if (error !== null && typeof error === "object") {
		const code = "code" in error && typeof error.code === "number" ? error.code
			: "_tag" in error && error._tag === "ContractReverted" ? 3
			: "_tag" in error && error._tag === "SchemaError" ? -32602 : -32603
		const message = "message" in error && typeof error.message === "string" ? error.message
			: "_tag" in error && error._tag === "ContractReverted" ? "Contract execution reverted" : "EvmClient request failed"
		const data = "data" in error ? error.data : undefined
		return new ViemAdapterError(message, { code, data, cause: error })
	}
	return new ViemAdapterError(String(error), { code: -32603, cause: error })
}

const requestCall = (
	client: EvmClient,
	params: unknown,
): Effect.Effect<unknown, CallError | Schema.SchemaError> => {
	const definition = getRpcMethod("eth_call")
	return Schema.decodeUnknownEffect(definition.request)({
		jsonrpc: "2.0",
		id: 1,
		method: "eth_call",
		params: params ?? [],
	}).pipe(
		Effect.flatMap((decoded) => client.call({
			transaction: decoded.params[0],
			...(decoded.params[1] === undefined ? {} : { block: decoded.params[1] }),
		})),
		Effect.flatMap(Schema.encodeEffect(definition.result)),
	)
}

const runEffect = async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> => {
	const exit = await Effect.runPromiseExit(effect, signal === undefined ? undefined : { signal })
	if (Exit.isSuccess(exit)) return exit.value
	const failure = Cause.findErrorOption(exit.cause)
	if (Option.isSome(failure)) throw adapterError(failure.value)
	throw new ViemAdapterError(Cause.pretty(exit.cause), { code: -32603 })
}

const unsupported = (method: string): ViemAdapterError => new ViemAdapterError(
	`EvmClient does not support Viem method ${method}`,
	{ code: 4200, data: { method } },
)

const requestPublic = (
	client: EvmClient,
	method: HedgeableRpcMethodName,
	params: unknown,
): Effect.Effect<unknown, EvmClientError | Schema.SchemaError> => {
	const definition = getRpcMethod(method)
	return Schema.decodeUnknownEffect(definition.request)({
		jsonrpc: "2.0",
		id: 1,
		method,
		params: params ?? [],
	}).pipe(
		Effect.flatMap((decoded) => client.fetch({ method, params: decoded.params })),
		Effect.flatMap(Schema.encodeEffect(definition.result)),
	)
}

const requestRawTransaction = (
	client: EvmClient,
	params: unknown,
): Effect.Effect<unknown, EvmClientError | Schema.SchemaError> => {
	const definition = getRpcMethod("eth_sendRawTransaction")
	return Schema.decodeUnknownEffect(definition.request)({
		jsonrpc: "2.0",
		id: 1,
		method: "eth_sendRawTransaction",
		params: params ?? [],
	}).pipe(
		Effect.flatMap((decoded) => client.sendRawTransaction(decoded.params[0])),
		Effect.flatMap(Schema.encodeEffect(definition.result)),
	)
}

function request<ReturnType = unknown>(client: EvmClient, input: ViemRequest, options?: unknown): Promise<ReturnType>
function request(client: EvmClient, input: ViemRequest, options?: unknown): Promise<unknown> {
	if (input.method !== "eth_sendRawTransaction" && !isHedgeableMethod(input.method)) {
		return Promise.reject(unsupported(input.method))
	}
	if (client.isClosed) return Promise.reject(new ViemAdapterError("EvmClient is closed", { code: 4900 }))
	const signal = options !== null && typeof options === "object" && "signal" in options && options.signal instanceof AbortSignal
		? options.signal : undefined
	if (input.method === "eth_sendRawTransaction") return runEffect(requestRawTransaction(client, input.params), signal)
	if (input.method === "eth_call") return runEffect(requestCall(client, input.params), signal)
	return runEffect(requestPublic(client, input.method, input.params), signal)
}

const encodeBlock = (block: RpcBlock): Effect.Effect<unknown, Schema.SchemaError> =>
	Schema.encodeEffect(getRpcMethod("eth_getBlockByNumber").result)(block)

const encodeLog = (log: RpcLog): Effect.Effect<unknown, Schema.SchemaError> =>
	Schema.encodeEffect(getRpcMethod("eth_getLogs").result)([log]).pipe(
		Effect.map((logs) => logs[0]),
	)

function* blockRange(start: bigint, end: bigint): Generator<bigint> {
	for (let number = start; number <= end; number++) yield number
}

const catchUpBlocks = (client: EvmClient): Stream.Stream<RpcBlock, EvmClientError | ViemAdapterError> => Stream.suspend(() => {
	let previous: bigint | undefined
	return client.blocks.pipe(
		Stream.map((head) => {
			const start = previous === undefined ? head.number : previous + 1n
			previous = head.number > (previous ?? -1n) ? head.number : previous
			return blockRange(start, head.number)
		}),
		Stream.flattenIterable,
		Stream.mapEffect((number) => client.fetch({ method: "eth_getBlockByNumber", params: [number, false] }).pipe(
			Effect.flatMap((block) => block === null
				? Effect.fail(new ViemAdapterError(`Block ${String(number)} is unavailable`, { code: -32001 }))
				: Effect.succeed(block)),
		)),
	)
})

const subscriptionStream = (
	client: EvmClient,
	params: readonly unknown[],
): Effect.Effect<Stream.Stream<unknown, EvmClientError | Schema.SchemaError | ViemAdapterError>, Schema.SchemaError> => {
	const definition = getRpcMethod("eth_subscribe")
	return Schema.decodeUnknownEffect(definition.request)({
		jsonrpc: "2.0",
		id: 1,
		method: "eth_subscribe",
		params,
	}).pipe(Effect.map((decoded) => {
		if (decoded.params[0] === "newHeads") {
			return catchUpBlocks(client).pipe(Stream.mapEffect(encodeBlock))
		}
		if (decoded.params[0] === "logs") {
			const filter = decoded.params[1]
			if (!isRpcFilter(filter)) return Stream.fail(unsupported("eth_subscribe:logs"))
			const liveFilter: RpcLogFilter = { ...(filter.address === undefined ? {} : { address: filter.address }),
				...(filter.topics === undefined ? {} : { topics: filter.topics }) }
			return catchUpBlocks(client).pipe(Stream.flatMap((block) => client.fetch({
				method: "eth_getLogs",
				params: [{ ...liveFilter, blockHash: block.hash }],
			}).pipe(Stream.fromEffect, Stream.flattenIterable, Stream.mapEffect(encodeLog))))
		}
		return Stream.fail(unsupported(`eth_subscribe:${decoded.params[0]}`))
	}))
}

const isRpcFilter = (value: unknown): value is RpcFilter => value !== null && typeof value === "object" && !Array.isArray(value)

const subscribe = async (client: EvmClient, subscription: ViemSubscription): Promise<ViemSubscriptionHandle> => {
	if (client.isClosed) throw new ViemAdapterError("EvmClient is closed", { code: 4900 })
	const stream = await runEffect(subscriptionStream(client, subscription.params))
	const controller = new AbortController()
	void Effect.runPromise(stream.pipe(Stream.runForEach((result) => Effect.sync(() => {
		subscription.onData({ result })
	}))), {
		signal: controller.signal,
	}).catch((error: unknown) => {
		if (!controller.signal.aborted) subscription.onError(adapterError(error))
	})
	return { unsubscribe: () => { controller.abort() } }
}

export const viemTransport = (client: EvmClient): EvmClientViemTransport => () => {
	const requestClient: ViemRequestFunction = (input, options) => request(client, input, options)
	return {
		config: {
			key: "ether-state",
			name: "EvmClient",
			request: requestClient,
			retryCount: 0,
			type: "webSocket",
		},
		request: requestClient,
		value: { subscribe: (subscription) => subscribe(client, subscription) },
	}
}
