import { Cause, Effect, Exit, Option, Schema, Scope, Semaphore, Stream, SubscriptionRef } from "effect"
import { HttpClient } from "effect/unstable/http"
import type { Socket } from "effect/unstable/socket"
import { getRpcEndpoints, type ChainListError, type RpcEndpoints } from "./chainList.js"
import { estimateBlockTime, type BlockTimeUnavailable } from "./live.js"
import { ethHttpRpc, HttpBatcher, type RpcHttpError } from "./transport/http.js"
import { MulticallReads, multicallAddress, type ContractRead, type CallError } from "./multicall.js"
import { RequestScheduler } from "./transport/queue.js"
import { callChanges, makeWatchedState, matchesLog, type WatchCallOptions, type WatchedCall, type WatchedState } from "./watch.js"
import { RpcHistory } from "./history.js"
import { LiveBlocks, type BlockPlan, type ReceiptBlockUpdate } from "./live.js"
import { RpcQueryCoordinator, rpcQueryKey, type RpcQueryCacheStats } from "./query.js"
import { getRpcMethod, type HttpRpcMethodName, type RpcBlock, type RpcMethodName, type RpcParams,
	type RpcResult, type RpcTransaction, type RpcLog, type RpcLogFilter } from "./schema.js"
import { ethWsRpc, ethWsRpcOnce, ethWsWatchNewHeads, ethWsWatchReceipts, makeWsState, watchSubscription, type RpcWsError, type WsState } from "./transport/ws.js"

export type RpcTransport = "http" | "ws"

export interface EvmClientConfig {
	readonly endpoints?: RpcEndpoints
	readonly network: {
		readonly chainId: bigint
		readonly blockTime?: number
	}
	readonly options?: {
		readonly concurrentHttp?: number
		readonly concurrentWs?: number
		readonly probeConcurrency?: number
		readonly observationLimit?: number
		readonly queryCacheSize?: number
		readonly requestTimeout?: number
		readonly batchWindow?: number
		readonly batchSize?: number
		readonly httpBatchWindow?: number
		readonly httpBatchMaxItems?: number
		readonly httpBatchMaxBytes?: number
		readonly multicallWindow?: number
		readonly multicallMaxCalls?: number
		readonly multicallMaxCalldataBytes?: number
		readonly hedgeDelay?: number
		readonly maxQueuedRequests?: number
		readonly maxRequestsPerSecond?: number
		readonly maxConcurrentRequests?: number
	}
}

export interface ResolvedEvmClientConfig extends EvmClientConfig {
	readonly endpoints: RpcEndpoints
	readonly network: { readonly chainId: bigint; readonly blockTime: number }
}

export interface BlockHead {
	readonly number: bigint
	readonly hash: string | null
	readonly parentHash: string | null
	readonly logsBloom: string | null
	readonly timestamp: bigint | null
	readonly observedAt: number
	readonly latencyMs: number | null
	readonly source: EndpointSource
}

export interface FullBlockUpdate extends BlockHead {
	readonly block: Omit<RpcBlock, "transactions"> & { readonly transactions: readonly RpcTransaction[] }
}

export interface EndpointSource {
	readonly endpoint: string
	readonly transport: RpcTransport
}

export type EndpointObservation =
	| {
		readonly _tag: "Success"
		readonly method: RpcMethodName
		readonly observedAt: number
		readonly responseMs: number
		readonly blockNumber: bigint | null
		readonly blockAgeMs: number | null
	}
	| {
		readonly _tag: "Failure"
		readonly method: RpcMethodName
		readonly observedAt: number
		readonly responseMs: number
		readonly error: string
	}
	| {
		readonly _tag: "Cancelled"
		readonly method: RpcMethodName
		readonly observedAt: number
		readonly elapsedMs: number
	}

export type EndpointStatus =
	| { readonly _tag: "Selected" }
	| { readonly _tag: "Standby" }
	| { readonly _tag: "Failed"; readonly error: string }
	| { readonly _tag: "WrongChain"; readonly actualChainId: bigint }

export interface EndpointState extends EndpointSource {
	readonly status: EndpointStatus
	readonly observations: readonly EndpointObservation[]
	readonly unsupportedMethods?: readonly HttpRpcMethodName[]
}

export interface InsufficientHealthyEndpoints {
	readonly _tag: "InsufficientHealthyEndpoints"
	readonly transport: RpcTransport
	readonly required: number
	readonly available: number
}

export interface BlockUnavailable {
	readonly _tag: "BlockUnavailable"
}

export interface EndpointRequestTimeout extends EndpointSource {
	readonly _tag: "EndpointRequestTimeout"
	readonly method: RpcMethodName
}

export interface InvalidClientConfig {
	readonly _tag: "InvalidClientConfig"
	readonly option: string
}

export type EvmClientInitError = InsufficientHealthyEndpoints | InvalidClientConfig | ChainListError | BlockTimeUnavailable
export type EvmClientError = RpcHttpError | RpcWsError | BlockUnavailable | EndpointRequestTimeout

export type HedgeableRpcMethodName = Exclude<HttpRpcMethodName,
	| "eth_fillTransaction"
	| "eth_getFilterChanges"
	| "eth_getFilterLogs"
	| "eth_newBlockFilter"
	| "eth_newFilter"
	| "eth_newPendingTransactionFilter"
	| "eth_sendRawTransaction"
	| "eth_sendTransaction"
	| "eth_sign"
	| "eth_signTransaction"
	| "eth_uninstallFilter"
>

interface ClientOptions {
	readonly concurrentHttp: number
	readonly concurrentWs: number
	readonly probeConcurrency: number
	readonly observationLimit: number
	readonly queryCacheSize: number
	readonly requestTimeout: number
	readonly httpBatchWindow: number
	readonly httpBatchMaxItems: number
	readonly httpBatchMaxBytes: number
	readonly multicallWindow: number
	readonly multicallMaxCalls: number
	readonly multicallMaxCalldataBytes: number
	readonly hedgeDelay: number
	readonly maxQueuedRequests: number
	readonly maxRequestsPerSecond: number
	readonly maxConcurrentRequests: number
}

interface ProbeSuccess extends EndpointSource {
	readonly _tag: "Success"
	readonly chainId: bigint
	readonly block: RpcBlock
	readonly responseMs: number
	readonly observedAt: number
}

interface ProbeFailure extends EndpointSource {
	readonly _tag: "Failure"
	readonly error: string
	readonly responseMs: number
	readonly observedAt: number
}

interface ProbeWrongChain extends EndpointSource {
	readonly _tag: "WrongChain"
	readonly actualChainId: bigint
	readonly block: RpcBlock
	readonly responseMs: number
	readonly observedAt: number
}

type ProbeResult = ProbeSuccess | ProbeFailure | ProbeWrongChain

interface ActiveWs {
	readonly probe: ProbeSuccess
	readonly state: WsState
}

interface RaceResult<Result> extends EndpointSource {
	readonly result: Result
}

const defaultOptions: ClientOptions = {
	concurrentHttp: 2,
	concurrentWs: 2,
	probeConcurrency: 10,
	observationLimit: 15,
	queryCacheSize: 128,
	requestTimeout: 8_000,
	httpBatchWindow: 0,
	httpBatchMaxItems: 20,
	httpBatchMaxBytes: 256_000,
	multicallWindow: 0,
	multicallMaxCalls: 20,
	multicallMaxCalldataBytes: 1_024,
	hedgeDelay: 100,
	maxQueuedRequests: 1_024,
	maxRequestsPerSecond: 20,
	maxConcurrentRequests: 20,
}

const resolveOptions = (options: EvmClientConfig["options"]): ClientOptions => ({
	concurrentHttp: options?.concurrentHttp ?? defaultOptions.concurrentHttp,
	concurrentWs: options?.concurrentWs ?? defaultOptions.concurrentWs,
	probeConcurrency: options?.probeConcurrency ?? defaultOptions.probeConcurrency,
	observationLimit: options?.observationLimit ?? defaultOptions.observationLimit,
	queryCacheSize: options?.queryCacheSize ?? defaultOptions.queryCacheSize,
	requestTimeout: options?.requestTimeout ?? defaultOptions.requestTimeout,
	httpBatchWindow: options?.httpBatchWindow ?? options?.batchWindow ?? defaultOptions.httpBatchWindow,
	httpBatchMaxItems: options?.httpBatchMaxItems ?? options?.batchSize ?? defaultOptions.httpBatchMaxItems,
	httpBatchMaxBytes: options?.httpBatchMaxBytes ?? defaultOptions.httpBatchMaxBytes,
	multicallWindow: options?.multicallWindow ?? options?.batchWindow ?? defaultOptions.multicallWindow,
	multicallMaxCalls: options?.multicallMaxCalls ?? options?.batchSize ?? defaultOptions.multicallMaxCalls,
	multicallMaxCalldataBytes: options?.multicallMaxCalldataBytes ?? defaultOptions.multicallMaxCalldataBytes,
	hedgeDelay: options?.hedgeDelay ?? defaultOptions.hedgeDelay,
	maxQueuedRequests: options?.maxQueuedRequests ?? defaultOptions.maxQueuedRequests,
	maxRequestsPerSecond: options?.maxRequestsPerSecond ?? defaultOptions.maxRequestsPerSecond,
	maxConcurrentRequests: options?.maxConcurrentRequests ?? defaultOptions.maxConcurrentRequests,
})

const hashPattern = /^0x[0-9a-fA-F]{64}$/

const isBlockHashReference = (value: unknown): boolean =>
	(typeof value === "string" && hashPattern.test(value)) ||
	(value !== null && typeof value === "object" && "blockHash" in value &&
		typeof value.blockHash === "string" && hashPattern.test(value.blockHash))

const keepCompletedResult = <Method extends HedgeableRpcMethodName>(request: {
	readonly method: Method
	readonly params: RpcParams<Method>
}, result: RpcResult<Method>): boolean => {
	if (result === null) return false
	if (request.method === "eth_chainId" || request.method === "net_version") return true
	if (request.method === "eth_getBlockByHash") return true
	if (request.method === "eth_getLogs") return isBlockHashReference(request.params[0])
	const blockPinned = request.method === "eth_call" || request.method === "eth_getBalance" ||
		request.method === "eth_getCode" || request.method === "eth_getProof" ||
		request.method === "eth_getStorageAt" || request.method === "eth_getStorageValues" ||
		request.method === "eth_getTransactionCount" || request.method === "eth_getBlockReceipts"
	if (!blockPinned) return false
	const blockIndex = request.method === "eth_getBlockReceipts" ? 0
		: request.method === "eth_getStorageAt" || request.method === "eth_getProof" ? 2 : 1
	const block = request.params[blockIndex]
	return isBlockHashReference(block)
}

const errorText = <Error>(cause: Cause.Cause<Error>): string => Cause.pretty(cause)

const timeoutRequest = <Result, Error, Requirements>(options: {
	readonly source: EndpointSource
	readonly method: RpcMethodName
	readonly timeout: number
	readonly effect: Effect.Effect<Result, Error, Requirements>
}): Effect.Effect<Result, Error | EndpointRequestTimeout, Requirements> => options.effect.pipe(Effect.timeoutOrElse({
	duration: options.timeout,
	orElse: () => Effect.fail<EndpointRequestTimeout>({
		_tag: "EndpointRequestTimeout",
		method: options.method,
		...options.source,
	}),
}))

const toBlockHead = (block: RpcBlock, source: EndpointSource, observedAt = Date.now()): BlockHead => ({
	number: block.number,
	hash: block.hash,
	parentHash: block.parentHash,
	logsBloom: block.logsBloom,
	timestamp: block.timestamp,
	observedAt,
	latencyMs: observedAt - Number(block.timestamp) * 1_000,
	source,
})

const blockDetails = (method: RpcMethodName, value: unknown, observedAt: number): {
	readonly blockNumber: bigint | null
	readonly blockAgeMs: number | null
} => {
	if (method === "eth_blockNumber" && typeof value === "bigint") {
		return { blockNumber: value, blockAgeMs: null }
	}
	if (value !== null && typeof value === "object" && "number" in value && typeof value.number === "bigint") {
		const blockAgeMs = "timestamp" in value && typeof value.timestamp === "bigint"
			? observedAt - Number(value.timestamp) * 1_000
			: null
		return { blockNumber: value.number, blockAgeMs }
	}
	return { blockNumber: null, blockAgeMs: null }
}

const rankProbes = (probes: readonly ProbeSuccess[]): readonly ProbeSuccess[] => [...probes].sort((left, right) => {
	if (left.block.number > right.block.number) return -1
	if (left.block.number < right.block.number) return 1
	return left.responseMs - right.responseMs
})

const probeHttp = (options: {
	readonly endpoint: string
	readonly expectedChainId: bigint
	readonly httpClient: HttpClient.HttpClient
	readonly requestTimeout: number
}): Effect.Effect<ProbeResult> => Effect.gen(function* () {
	const startedAt = Date.now()
	const result = yield* Effect.exit(timeoutRequest({
		source: { endpoint: options.endpoint, transport: "http" },
		method: "eth_getBlockByNumber",
		timeout: options.requestTimeout,
		effect: Effect.gen(function* () {
			const chainId = yield* ethHttpRpc({ method: "eth_chainId", endpoint: options.endpoint, inputParams: [] })
			const block = yield* ethHttpRpc({
				method: "eth_getBlockByNumber", endpoint: options.endpoint, inputParams: ["latest", false],
			})
			if (block === null) return yield* Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
			return { chainId, block }
		}).pipe(Effect.provideService(HttpClient.HttpClient, options.httpClient)),
	}))
	const observedAt = Date.now()
	const responseMs = observedAt - startedAt
	if (Exit.isFailure(result)) {
		return {
			_tag: "Failure",
			endpoint: options.endpoint,
			transport: "http",
			error: errorText(result.cause),
			responseMs,
			observedAt,
		}
	}
	if (result.value.chainId !== options.expectedChainId) {
		return {
			_tag: "WrongChain",
			endpoint: options.endpoint,
			transport: "http",
			actualChainId: result.value.chainId,
			block: result.value.block,
			responseMs,
			observedAt,
		}
	}
	return {
		_tag: "Success",
		endpoint: options.endpoint,
		transport: "http",
		chainId: result.value.chainId,
		block: result.value.block,
		responseMs,
		observedAt,
	}
})

const probeWs = (options: {
	readonly endpoint: string
	readonly expectedChainId: bigint
	readonly requestTimeout: number
}): Effect.Effect<ProbeResult, never, Socket.WebSocketConstructor> => Effect.gen(function* () {
	const startedAt = Date.now()
	const result = yield* Effect.exit(Effect.gen(function* () {
		const chainId = yield* ethWsRpcOnce({
			method: "eth_chainId", endpoint: options.endpoint, inputParams: [], requestTimeout: options.requestTimeout,
		})
		const block = yield* ethWsRpcOnce({
			method: "eth_getBlockByNumber", endpoint: options.endpoint, inputParams: ["latest", false],
			requestTimeout: options.requestTimeout,
		})
		if (block === null) return yield* Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
		return { chainId, block }
	}))
	const observedAt = Date.now()
	const responseMs = observedAt - startedAt
	if (Exit.isFailure(result)) {
		return {
			_tag: "Failure",
			endpoint: options.endpoint,
			transport: "ws",
			error: errorText(result.cause),
			responseMs,
			observedAt,
		}
	}
	if (result.value.chainId !== options.expectedChainId) {
		return {
			_tag: "WrongChain",
			endpoint: options.endpoint,
			transport: "ws",
			actualChainId: result.value.chainId,
			block: result.value.block,
			responseMs,
			observedAt,
		}
	}
	return {
		_tag: "Success",
		endpoint: options.endpoint,
		transport: "ws",
		chainId: result.value.chainId,
		block: result.value.block,
		responseMs,
		observedAt,
	}
})

const probeBatch = (options: {
	readonly endpoints: readonly string[]
	readonly transport: RpcTransport
	readonly probe: (endpoint: string) => Effect.Effect<ProbeResult, never, Socket.WebSocketConstructor>
}): Effect.Effect<readonly ProbeResult[], never, Socket.WebSocketConstructor> => Effect.forEach(
	options.endpoints,
	options.probe,
	{ concurrency: "unbounded" },
).pipe(Effect.tap((results) => Effect.log("RPC probe batch complete", {
	transport: options.transport,
	completed: results.length,
})))

const requireSelection = (
	transport: RpcTransport,
	results: readonly ProbeResult[],
	required: number,
): Effect.Effect<readonly ProbeSuccess[], InsufficientHealthyEndpoints> => {
	const selected = rankProbes(results.filter((result) => result._tag === "Success")).slice(0, required)
	if (selected.length < required) {
		return Effect.fail<InsufficientHealthyEndpoints>({
			_tag: "InsufficientHealthyEndpoints",
			transport,
			required,
			available: selected.length,
		})
	}
	return Effect.succeed(selected)
}

const probeInitial = (options: Parameters<typeof probeBatch>[0] & {
	readonly batchSize: number; readonly minimum: number
}): Effect.Effect<readonly ProbeResult[], never, Socket.WebSocketConstructor> => Effect.gen(function* () {
	const results: ProbeResult[] = []
	for (let offset = 0; offset < options.endpoints.length && results.filter((result) => result._tag === "Success").length < options.minimum;
		offset += options.batchSize) {
		results.push(...(yield* probeBatch({ ...options, endpoints: options.endpoints.slice(offset, offset + options.batchSize) })))
	}
	return results
})

const initialEndpointState = (
	probe: ProbeResult,
	selected: ReadonlySet<string>,
): EndpointState => {
	const details = blockDetails("eth_getBlockByNumber", probe._tag === "Failure" ? null : probe.block, probe.observedAt)
	if (probe._tag === "Failure") {
		return {
			endpoint: probe.endpoint,
			transport: probe.transport,
			status: { _tag: "Failed", error: probe.error },
			observations: [{
				_tag: "Failure", method: "eth_getBlockByNumber", observedAt: probe.observedAt,
				responseMs: probe.responseMs, error: probe.error,
			}],
		}
	}
	const observation: EndpointObservation = {
		_tag: "Success",
		method: "eth_getBlockByNumber",
		observedAt: probe.observedAt,
		responseMs: probe.responseMs,
		...details,
	}
	if (probe._tag === "WrongChain") {
		return {
			endpoint: probe.endpoint,
			transport: probe.transport,
			status: { _tag: "WrongChain", actualChainId: probe.actualChainId },
			observations: [observation],
		}
	}
	return {
		endpoint: probe.endpoint,
		transport: probe.transport,
		status: selected.has(probe.endpoint) ? { _tag: "Selected" } : { _tag: "Standby" },
		observations: [observation],
	}
}

export class EvmClient {
	readonly blocks: Stream.Stream<BlockHead>
	readonly history: RpcHistory
	private fullBlocks: Stream.Stream<FullBlockUpdate>
	private receiptBlocks: Stream.Stream<ReceiptBlockUpdate>
	private readonly retryAt = new Map<string, number>()
	private readonly httpBatches = new Map<string, HttpBatcher>()
	private readonly reads: MulticallReads
	private readonly scheduler: RequestScheduler
	private readonly callStreams = new Map<string, Stream.Stream<WatchedCall<string>, CallError | Schema.SchemaError>>()
	private closed = false

	private constructor(
		readonly config: ResolvedEvmClientConfig,
		private readonly options: ClientOptions,
		private readonly httpClient: HttpClient.HttpClient,
		private readonly wsScope: Scope.Scope,
		private readonly activeHttp: SubscriptionRef.SubscriptionRef<readonly ProbeSuccess[]>,
		private readonly activeWs: SubscriptionRef.SubscriptionRef<readonly ActiveWs[]>,
		private readonly head: SubscriptionRef.SubscriptionRef<Option.Option<BlockHead>>,
		private readonly endpointState: SubscriptionRef.SubscriptionRef<ReadonlyMap<string, EndpointState>>,
		private readonly refreshLock: Semaphore.Semaphore,
		private readonly queries: RpcQueryCoordinator,
		private readonly live: LiveBlocks,
	) {
		this.scheduler = new RequestScheduler({ rps: options.maxRequestsPerSecond, concurrency: options.maxConcurrentRequests, capacity: options.maxQueuedRequests })
		this.reads = new MulticallReads({ scope: wsScope, window: options.multicallWindow, size: options.multicallMaxCalls,
			maxCalldataBytes: options.multicallMaxCalldataBytes, capacity: options.maxQueuedRequests,
			fetch: (transaction, block) => this.fetch({ method: "eth_call", params: [transaction, block] }),
			code: (block) => this.fetch({ method: "eth_getCode", params: [multicallAddress, block] }) })
		this.blocks = SubscriptionRef.changes(head).pipe(
			Stream.filter(Option.isSome),
			Stream.map((value) => value.value),
		)
		this.history = new RpcHistory(this)
		this.fullBlocks = this.withDemand("fullUsers", this.blocks.pipe(
			Stream.filter((head) => head.hash !== null), Stream.mapEffect((head) => live.waitFull(head)),
		))
		this.receiptBlocks = Stream.empty
	}

	static make(
		config: EvmClientConfig,
	): Effect.Effect<EvmClient, EvmClientInitError, HttpClient.HttpClient | Scope.Scope | Socket.WebSocketConstructor> {
		return Effect.gen(function* () {
			const options = resolveOptions(config.options)
			for (const [option, value] of Object.entries({ ...options, blockTime: config.network.blockTime })) {
				if (value === undefined) continue
				const minimum = option === "concurrentHttp" || option === "concurrentWs" || option === "queryCacheSize" ||
					option === "batchWindow" || option === "httpBatchWindow" || option === "multicallWindow" || option === "hedgeDelay" ? 0 : 1
				if (!Number.isSafeInteger(value) || value < minimum) {
					return yield* Effect.fail<InvalidClientConfig>({ _tag: "InvalidClientConfig", option })
				}
			}
			if (options.concurrentHttp + options.concurrentWs === 0) {
				return yield* Effect.fail<InvalidClientConfig>({ _tag: "InvalidClientConfig", option: "concurrentHttp/concurrentWs" })
			}
			const httpClient = yield* HttpClient.HttpClient
			const endpoints = config.endpoints ?? (yield* getRpcEndpoints(config.network.chainId))
			const httpEndpoints = [...new Set(endpoints.http)]
			const wsEndpoints = [...new Set(endpoints.ws)]
			const [httpResults, wsResults] = yield* Effect.all([
				probeInitial({
					endpoints: httpEndpoints,
					batchSize: options.probeConcurrency, minimum: config.options?.concurrentHttp ?? 1,
					transport: "http",
					probe: (endpoint) => probeHttp({
						endpoint,
						expectedChainId: config.network.chainId,
						httpClient,
						requestTimeout: options.requestTimeout,
					}),
				}),
				probeInitial({
					endpoints: wsEndpoints,
					batchSize: options.probeConcurrency, minimum: config.options?.concurrentWs ?? 1,
					transport: "ws",
					probe: (endpoint) => probeWs({
						endpoint,
						expectedChainId: config.network.chainId,
						requestTimeout: options.requestTimeout,
					}),
				}),
			], { concurrency: "unbounded" })
			const selectedHttp = yield* requireSelection("http", httpResults, config.options?.concurrentHttp ??
				Math.min(options.concurrentHttp, httpResults.filter((result) => result._tag === "Success").length))
			const selectedWs = yield* requireSelection("ws", wsResults, config.options?.concurrentWs ??
				Math.min(options.concurrentWs, wsResults.filter((result) => result._tag === "Success").length))
			const activeUrls = new Set([...selectedHttp, ...selectedWs].map((probe) => probe.endpoint))
			const endpointMap = new Map<string, EndpointState>()
			for (const probe of [...httpResults, ...wsResults]) {
				endpointMap.set(probe.endpoint, initialEndpointState(probe, activeUrls))
			}
			const endpointState = yield* SubscriptionRef.make<ReadonlyMap<string, EndpointState>>(endpointMap)
			const initialHead = rankProbes([...selectedHttp, ...selectedWs])[0]
			if (initialHead === undefined) return yield* Effect.fail<InsufficientHealthyEndpoints>({
				_tag: "InsufficientHealthyEndpoints", transport: httpEndpoints.length > 0 ? "http" : "ws", required: 1, available: 0,
			})
			const head = yield* SubscriptionRef.make(Option.fromNullishOr(initialHead).pipe(
				Option.map((probe) => toBlockHead(probe.block, probe, probe.observedAt)),
			))
			const refreshLock = yield* Semaphore.make(1)
			const wsScope = yield* Scope.make()
			yield* Effect.addFinalizer(() => Scope.close(wsScope, Exit.void))
			const queries = yield* RpcQueryCoordinator.make({ capacity: options.queryCacheSize, scope: wsScope })
			const live = yield* LiveBlocks.make()
			const initialWs = yield* Effect.forEach(selectedWs, (probe) => makeWsState({
				endpoint: probe.endpoint, requestTimeout: options.requestTimeout,
			}).pipe(Scope.provide(wsScope), Effect.map((state) => ({ probe, state }))))
			const activeHttp = yield* SubscriptionRef.make(selectedHttp)
			const activeWs = yield* SubscriptionRef.make<readonly ActiveWs[]>(initialWs)
			const blockTime = config.network.blockTime ?? (yield* estimateBlockTime({
				latest: initialHead.block,
				fetchBlock: (number) => Effect.firstSuccessOf([
					...selectedHttp.map((probe) => timeoutRequest({
						source: probe, method: "eth_getBlockByNumber", timeout: options.requestTimeout,
						effect: ethHttpRpc({ endpoint: probe.endpoint, method: "eth_getBlockByNumber", inputParams: [number, false] }),
					})),
					...initialWs.map(({ state }) => state.request({ method: "eth_getBlockByNumber", inputParams: [number, false] })),
				].map((request: Effect.Effect<RpcBlock | null, EvmClientError, HttpClient.HttpClient>) => request.pipe(Effect.flatMap((block) => block?.number === number
					? Effect.succeed(block) : Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" }))))),
			}))
			const client = new EvmClient(
				{ ...config, endpoints, network: { ...config.network, blockTime } },
				options,
				httpClient,
				wsScope,
				activeHttp,
				activeWs,
				head,
				endpointState,
				refreshLock,
				queries,
				live,
			)
			yield* Effect.addFinalizer(() => Effect.sync(() => { client.closed = true }))
			client.fullBlocks = yield* Stream.share(client.fullBlocks, { capacity: 16, replay: 1 })
			client.receiptBlocks = yield* Stream.share(client.withDemand("receiptUsers", client.fullBlocks.pipe(
				Stream.mapEffect((block) => live.waitReceipts(block)),
			)), { capacity: 16, replay: 1 })
			yield* client.startBlockWatchers()
			yield* Effect.forkScoped(client.probeRemainder(
				"http",
				httpEndpoints.slice(options.concurrentHttp === 0 ? httpEndpoints.length : httpResults.length),
				(endpoint) => probeHttp({
					endpoint,
					expectedChainId: config.network.chainId,
					httpClient,
					requestTimeout: options.requestTimeout,
				}),
			))
			yield* Effect.forkScoped(client.probeRemainder(
				"ws",
				wsEndpoints.slice(options.concurrentWs === 0 ? wsEndpoints.length : wsResults.length),
				(endpoint) => probeWs({
					endpoint,
					expectedChainId: config.network.chainId,
					requestTimeout: options.requestTimeout,
				}),
			))
			return client
		})
	}

	get endpoints(): Effect.Effect<ReadonlyMap<string, EndpointState>> {
		return SubscriptionRef.get(this.endpointState)
	}

	get isClosed(): boolean {
		return this.closed
	}

	get queryCache(): Effect.Effect<RpcQueryCacheStats> {
		return this.queries.stats
	}

	get metrics(): { readonly multicall: { readonly batches: number; readonly calls: number; readonly singles: number; readonly fallbacks: number }; readonly http: readonly { readonly endpoint: string; readonly envelopes: number; readonly requests: number; readonly batches: number; readonly singles: number; readonly fallbacks: number; readonly resends: number; readonly maxRps: number }[] } {
		return { multicall: { ...this.reads.stats }, http: [...this.httpBatches].map(([endpoint, batch]) => ({ endpoint, ...batch.stats, maxRps: this.scheduler.limit(endpoint) })) }
	}

	call(read: ContractRead): Effect.Effect<string, CallError> {
		return Effect.gen({ self: this }, function* () {
			const head = yield* this.getBlock()
			const reference = read.block ?? head.number
			if (reference === "pending") return yield* this.fetch({ method: "eth_call", params: [read.transaction, reference] })
			let number = head.number
			let hash = head.hash
			const numberReference = typeof reference === "bigint" ? reference
				: typeof reference === "object" && "blockNumber" in reference ? reference.blockNumber
					: typeof reference === "string" && /^0x[\da-f]+$/i.test(reference) && !hashPattern.test(reference) ? BigInt(reference) : undefined
			if (numberReference !== undefined) {
				number = numberReference
				if (number !== head.number) hash = null
			} else if (reference !== "latest") {
				const hashReference = typeof reference === "object" && "blockHash" in reference ? reference.blockHash
					: typeof reference === "string" && hashPattern.test(reference) ? reference : undefined
				const tag = hashReference === undefined
					? yield* Schema.decodeUnknownEffect(Schema.Literals(["earliest", "finalized", "safe"]))(reference)
					: undefined
				const block = yield* hashReference !== undefined
					? this.fetch({ method: "eth_getBlockByHash", params: [hashReference, false] })
					: this.fetch({ method: "eth_getBlockByNumber", params: [tag ?? "latest", false] })
				if (block === null) return yield* Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
				number = block.number
				hash = block.hash
			}
			const block = hash === null ? number : { blockHash: hash, requireCanonical: true }
			yield* Schema.encodeEffect(getRpcMethod("eth_call").request)({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [read.transaction, block] })
			return yield* this.reads.request({ ...read, block, blockNumber: number })
		})
	}

	watchLogs(filter: RpcLogFilter = {}): Stream.Stream<RpcLog> {
		return this.receiptBlocks.pipe(Stream.map((block) => block.logs.filter((log) => matchesLog(log, filter))), Stream.flattenIterable)
	}

	watchTransactions(filter: { readonly from?: string; readonly to?: string } = {}): Stream.Stream<RpcTransaction> {
		return this.fullBlocks.pipe(Stream.map((head) => head.block.transactions.filter((tx) =>
			(filter.from === undefined || tx.from.toLowerCase() === filter.from.toLowerCase()) &&
			(filter.to === undefined || tx.to?.toLowerCase() === filter.to.toLowerCase()))), Stream.flattenIterable)
	}

	watchCall<A>(options: WatchCallOptions<A>): Stream.Stream<WatchedCall<A>, CallError | Schema.SchemaError> {
		const key = JSON.stringify(options.transaction, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value) + String(options.multicall)
		return Stream.unwrap(Effect.gen({ self: this }, function* () {
			let shared = this.callStreams.get(key)
			if (shared === undefined) {
				shared = yield* callChanges(this, { transaction: options.transaction, ...(options.multicall === undefined ? {} : { multicall: options.multicall }),
					decode: Effect.succeed }).pipe(Stream.share({ capacity: 16, replay: 1 }), Scope.provide(this.wsScope))
				this.callStreams.set(key, shared)
			}
			return shared.pipe(Stream.mapEffect((entry) => options.decode(entry.value).pipe(Effect.map((value) => ({ ...entry, value })))),
				Stream.changesWith((a, b) => options.equals?.(a.value, b.value) ?? false))
		}))
	}

	watchState<A>(options: WatchCallOptions<A>): Effect.Effect<{ readonly current: Effect.Effect<WatchedState<A>>; readonly changes: Stream.Stream<WatchedState<A>> }, never, Scope.Scope> {
		return makeWatchedState(this, options)
	}

	subscribe<A, I>(options: { readonly params: RpcParams<"eth_subscribe">; readonly schema: Schema.Codec<A, I> }): Stream.Stream<A, RpcWsError> {
		return SubscriptionRef.changes(this.activeWs).pipe(Stream.switchMap((active) => {
			const first = active[0]
			return first === undefined ? Stream.fail({ _tag: "RpcError", code: -32004, message: "No active WS endpoint" } as const)
				: watchSubscription(first.state, options.params, options.schema).pipe(Stream.map((notification) => notification.value))
		}))
	}

	sendRawTransaction(raw: string): Effect.Effect<string, EvmClientError> {
		return Effect.gen({ self: this }, function* () {
			yield* Schema.encodeEffect(getRpcMethod("eth_sendRawTransaction").request)({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] })
			const sources = [...(yield* this.endpoints).values()].filter((endpoint) => endpoint.status._tag === "Selected")
			if (sources.length === 0) return yield* Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
			const results = yield* Effect.forEach(sources, (source) => Effect.exit(this.requestAt(source, { method: "eth_sendRawTransaction", params: [raw] })), { concurrency: "unbounded" })
			for (const result of results) if (Exit.isSuccess(result)) return result.value
			return yield* Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
		})
	}

	fetchOne<Method extends HedgeableRpcMethodName>(request: { readonly method: Method; readonly params: RpcParams<Method> }): Effect.Effect<RpcResult<Method>, EvmClientError> {
		return Effect.gen({ self: this }, function* () {
			const endpoints = [...(yield* this.endpoints).values()].filter((endpoint) => endpoint.transport === "http" &&
				(endpoint.status._tag === "Selected" || endpoint.status._tag === "Standby") && !endpoint.unsupportedMethods?.includes(request.method))
				.sort((a, b) => this.scheduler.load(a.endpoint) - this.scheduler.load(b.endpoint))
			if (endpoints.length === 0) return yield* this.fetch(request)
			return yield* Effect.firstSuccessOf(endpoints.map((source) => this.requestAt(source, request, true)))
		})
	}

	watchBlocks(options: { readonly full: true; readonly logs: true }): Stream.Stream<ReceiptBlockUpdate>
	watchBlocks(options: { readonly full: true; readonly logs?: false }): Stream.Stream<FullBlockUpdate>
	watchBlocks(options?: { readonly full?: false }): Stream.Stream<BlockHead>
	watchBlocks(options: { readonly full: boolean; readonly logs?: boolean }): Stream.Stream<BlockHead | FullBlockUpdate | ReceiptBlockUpdate>
	watchBlocks(options: { readonly full?: boolean; readonly logs?: boolean } = {}): Stream.Stream<BlockHead | FullBlockUpdate | ReceiptBlockUpdate> {
		return options.logs ? this.receiptBlocks : options.full ? this.fullBlocks : this.blocks
	}

	private withDemand<A>(kind: "fullUsers" | "receiptUsers", stream: Stream.Stream<A>): Stream.Stream<A> {
		return Stream.unwrap(Effect.acquireRelease(
			SubscriptionRef.get(this.head).pipe(Effect.flatMap((head) => this.live.demand(kind, 1, head))),
			() => this.live.demand(kind, -1, Option.none()),
		).pipe(Effect.as(stream)))
	}

	private probeRemainder(
		transport: RpcTransport,
		endpoints: readonly string[],
		probe: (endpoint: string) => Effect.Effect<ProbeResult, never, Socket.WebSocketConstructor>,
	): Effect.Effect<void, never, Socket.WebSocketConstructor> {
		return Effect.gen({ self: this }, function* () {
			for (let offset = 0; offset < endpoints.length; offset += this.options.probeConcurrency) {
				const batch = endpoints.slice(offset, offset + this.options.probeConcurrency)
				const results = yield* probeBatch({ endpoints: batch, transport, probe })
				yield* this.applyProbeResults(transport, results)
				yield* Effect.log("RPC background probe progress", {
					transport,
					completed: Math.min(offset + batch.length, endpoints.length),
					total: endpoints.length,
				})
			}
		})
	}

	private applyProbeResults(
		transport: RpcTransport,
		results: readonly ProbeResult[],
	): Effect.Effect<void, never, Socket.WebSocketConstructor> {
		return Effect.gen({ self: this }, function* () {
			const current = transport === "http"
				? yield* SubscriptionRef.get(this.activeHttp)
				: (yield* SubscriptionRef.get(this.activeWs)).map((active) => active.probe)
			const candidates = new Map(current.map((probe) => [probe.endpoint, probe]))
			for (const result of results) {
				if (result._tag === "Success") candidates.set(result.endpoint, result)
			}
			const required = transport === "http" ? this.options.concurrentHttp : this.options.concurrentWs
			const selected = rankProbes([...candidates.values()]).slice(0, required)
			const selectedUrls = new Set(selected.map((probe) => probe.endpoint))

			if (transport === "http") {
				yield* SubscriptionRef.set(this.activeHttp, selected)
			} else {
				const active = yield* SubscriptionRef.get(this.activeWs)
				const byEndpoint = new Map(active.map((entry) => [entry.probe.endpoint, entry]))
				const next = yield* Effect.forEach(selected, (probe) => {
					const existing = byEndpoint.get(probe.endpoint)
					if (existing !== undefined) return Effect.succeed({ ...existing, probe })
					return makeWsState({ endpoint: probe.endpoint, requestTimeout: this.options.requestTimeout }).pipe(
						Scope.provide(this.wsScope),
						Effect.map((state) => ({ probe, state })),
					)
				})
				yield* SubscriptionRef.set(this.activeWs, next)
				yield* Effect.forEach(
					active.filter((entry) => !selectedUrls.has(entry.probe.endpoint)),
					(entry) => entry.state.close,
					{ discard: true },
				)
			}

			yield* SubscriptionRef.update(this.endpointState, (endpoints) => {
				const next = new Map(endpoints)
				for (const [url, endpoint] of next) {
					if (endpoint.transport !== transport) continue
					if (endpoint.status._tag !== "Selected" && endpoint.status._tag !== "Standby") continue
					next.set(url, {
						...endpoint,
						status: selectedUrls.has(url) ? { _tag: "Selected" } : { _tag: "Standby" },
					})
				}
				for (const result of results) next.set(result.endpoint, initialEndpointState(result, selectedUrls))
				return next
			})
		})
	}

	private record(source: EndpointSource, observation: EndpointObservation): Effect.Effect<void> {
		return SubscriptionRef.update(this.endpointState, (endpoints) => {
			const endpoint = endpoints.get(source.endpoint)
			if (endpoint === undefined) return endpoints
			const next = new Map(endpoints)
			next.set(source.endpoint, {
				...endpoint,
				observations: [...endpoint.observations, observation].slice(-this.options.observationLimit),
			})
			return next
		})
	}

	private tracked<Result, Error>(options: {
		readonly source: EndpointSource
		readonly method: RpcMethodName
		readonly effect: Effect.Effect<Result, Error>
	}): Effect.Effect<RaceResult<Result>, Error> {
		return Effect.suspend(() => {
			const startedAt = Date.now()
			return options.effect.pipe(
				Effect.map((result) => ({ ...options.source, result })),
				Effect.onExit((exit) => {
					const observedAt = Date.now()
					if (Exit.isSuccess(exit)) {
						return this.record(options.source, {
							_tag: "Success",
							method: options.method,
							observedAt,
							responseMs: observedAt - startedAt,
							...blockDetails(options.method, exit.value.result, observedAt),
						})
					}
					if (Cause.hasInterruptsOnly(exit.cause)) {
						return this.record(options.source, {
							_tag: "Cancelled",
							method: options.method,
							observedAt,
							elapsedMs: observedAt - startedAt,
						})
					}
					return this.record(options.source, {
						_tag: "Failure",
						method: options.method,
						observedAt,
						responseMs: observedAt - startedAt,
						error: errorText(exit.cause),
					})
				}),
			)
		})
	}

	private observe(candidate: Omit<BlockHead, "latencyMs">): Effect.Effect<void> {
		const block: BlockHead = {
			...candidate,
			latencyMs: candidate.timestamp === null ? null : candidate.observedAt - Number(candidate.timestamp) * 1_000,
		}
		return SubscriptionRef.updateSomeEffect(this.head, (current) => {
			const changed = Option.isNone(current) || block.number > current.value.number ||
				(block.number === current.value.number && current.value.hash === null && block.hash !== null)
			return changed ? this.live.observe(block).pipe(Effect.as(Option.some(Option.some(block))))
				: Effect.succeed(Option.none())
		})
	}

	private observeResult(method: RpcMethodName, result: unknown, source: EndpointSource): Effect.Effect<void> {
		if (method === "eth_blockNumber" && typeof result === "bigint") {
			return this.observe({
				number: result,
				hash: null,
				parentHash: null,
				logsBloom: null,
				timestamp: null,
				observedAt: Date.now(),
				source,
			})
		}
		if (result !== null && typeof result === "object" && "number" in result && typeof result.number === "bigint" &&
			"hash" in result && typeof result.hash === "string" && "timestamp" in result && typeof result.timestamp === "bigint") {
			return this.observe({
				number: result.number,
				hash: result.hash,
				parentHash: "parentHash" in result && typeof result.parentHash === "string" ? result.parentHash : null,
				logsBloom: "logsBloom" in result && typeof result.logsBloom === "string" ? result.logsBloom : null,
				timestamp: result.timestamp,
				observedAt: Date.now(),
				source,
			})
		}
		return Effect.void
	}

	fetch<Method extends HedgeableRpcMethodName>(request: {
		readonly method: Method
		readonly params: RpcParams<Method>
	}): Effect.Effect<RpcResult<Method>, EvmClientError> {
		const definition = getRpcMethod(request.method)
		return Schema.encodeEffect(definition.request)({
			jsonrpc: "2.0", id: 1, method: request.method, params: request.params,
		}).pipe(Effect.flatMap((encoded) => this.queries.get({
			key: rpcQueryKey({ chainId: this.config.network.chainId, method: request.method, params: encoded.params }),
			result: definition.result, load: this.fetchPhysical(request),
			keep: (result) => keepCompletedResult(request, result),
		})))
	}

	private fetchPhysical<Method extends HedgeableRpcMethodName>(request: {
		readonly method: Method
		readonly params: RpcParams<Method>
	}, accept: (result: RpcResult<Method>) => boolean = () => true): Effect.Effect<RpcResult<Method>, EvmClientError> {
		return Effect.gen({ self: this }, function* () {
			const activeHttp = yield* SubscriptionRef.get(this.activeHttp)
			const activeWs = yield* SubscriptionRef.get(this.activeWs)
			const sources: readonly EndpointSource[] = [
				...activeHttp.map(({ endpoint }): EndpointSource => ({ endpoint, transport: "http" })),
				...activeWs.map(({ state }): EndpointSource => ({ endpoint: state.endpoint, transport: "ws" })),
			]
			if (sources.length === 0) return yield* Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
			const ranked = [...sources].sort((a, b) => this.scheduler.load(a.endpoint) - this.scheduler.load(b.endpoint))
			const attempts = ranked.map((source, index) => this.requestAt(source, request, true).pipe(
				Effect.flatMap((result) => accept(result) ? Effect.succeed({ ...source, result })
					: Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })),
				index === 0 || this.options.hedgeDelay === 0 ? (effect) => effect
					: (effect) => Effect.sleep(this.options.hedgeDelay * index).pipe(Effect.andThen(effect)),
			))
			const winner = yield* Effect.raceAll(attempts)
			yield* this.observeResult(request.method, winner.result, winner)
			return winner.result
		})
	}

	getBlock(): Effect.Effect<BlockHead, EvmClientError> {
		return this.refreshLock.withPermit(SubscriptionRef.get(this.head).pipe(Effect.flatMap((cached) => {
			if (Option.isSome(cached) && cached.value.timestamp !== null &&
				Date.now() - cached.value.observedAt <= this.config.network.blockTime) {
				return Effect.succeed(cached.value)
			}
			return this.fetchPhysical({ method: "eth_getBlockByNumber", params: ["latest", false] }, (block) => block !== null).pipe(
				Effect.flatMap((block) => block === null
					? Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
					: this.observe(toBlockHead(block, { endpoint: "race", transport: "http" }))),
				Effect.andThen(SubscriptionRef.get(this.head)),
				Effect.flatMap((current) => Option.isNone(current) || current.value.timestamp === null
					? Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
					: Effect.succeed(current.value)),
			)
		})))
	}

	private requestAt<Method extends HttpRpcMethodName>(source: EndpointSource, request: {
		readonly method: Method; readonly params: RpcParams<Method>
	}, batch = false): Effect.Effect<RpcResult<Method>, EvmClientError> {
		const effect = source.transport === "http"
			? ethHttpRpc({ method: request.method, endpoint: source.endpoint, inputParams: request.params,
				...(batch ? { batch: this.httpBatcher(source.endpoint) } : {}) }).pipe(
				Effect.provideService(HttpClient.HttpClient, this.httpClient))
			: SubscriptionRef.get(this.activeWs).pipe(Effect.flatMap((active): Effect.Effect<RpcResult<Method>, EvmClientError> => {
				const match = active.find(({ state }) => state.endpoint === source.endpoint)
				return match === undefined ? Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
					: ethWsRpc({ method: request.method, state: match.state, inputParams: request.params })
			}))
		const ready: Effect.Effect<void> = Effect.suspend(() => {
			const delay = (this.retryAt.get(source.endpoint) ?? 0) - Date.now()
			return delay > 0 ? Effect.sleep(delay).pipe(Effect.andThen(ready)) : Effect.void
		})
		return this.scheduler.run(source.endpoint, !batch, ready.pipe(Effect.andThen(this.tracked({ source, method: request.method, effect: timeoutRequest({
			source, method: request.method, timeout: this.options.requestTimeout, effect,
		}) })))).pipe(
			Effect.map(({ result }) => result),
			Effect.tapError((error) => Effect.sync(() => {
				let delay = 0
				if (error._tag === "HttpClientError" && error.response?.status === 429) {
					const retryAfter = error.response.headers["retry-after"] ?? "1"
					const seconds = Number(retryAfter)
					delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - Date.now()
					if (!Number.isFinite(delay)) delay = 1_000
					delay = Math.max(1_000, delay)
				} else if (error._tag === "RpcError" && /rate limit|too many|quota|limit exceeded/i.test(error.message)) {
					delay = 1_000
				}
				if (delay > 0) {
					this.scheduler.throttle(source.endpoint)
					this.retryAt.set(source.endpoint, Math.max(this.retryAt.get(source.endpoint) ?? 0, Date.now() + delay))
				}
			})),
			Effect.tapError((error) => error._tag === "RpcError" && (error.code === -32601 || error.code === -32004)
				? SubscriptionRef.update(this.endpointState, (endpoints) => {
					const endpoint = endpoints.get(source.endpoint)
					return endpoint === undefined ? endpoints : new Map(endpoints).set(source.endpoint, {
						...endpoint, unsupportedMethods: [...new Set([...(endpoint.unsupportedMethods ?? []), request.method])],
					})
				}) : Effect.void),
		)
	}

	private httpBatcher(endpoint: string): HttpBatcher {
		const existing = this.httpBatches.get(endpoint)
		if (existing !== undefined) return existing
		const batch = new HttpBatcher({ endpoint, client: this.httpClient, scope: this.wsScope,
			window: this.options.httpBatchWindow, size: this.options.httpBatchMaxItems, maxBytes: this.options.httpBatchMaxBytes,
			capacity: this.options.maxQueuedRequests, timeout: this.options.requestTimeout })
		this.httpBatches.set(endpoint, batch)
		return batch
	}

	private fetchReceipts(source: EndpointSource, plan: BlockPlan): Effect.Effect<void, EvmClientError> {
		return Effect.gen({ self: this }, function* () {
			const endpoints = yield* this.endpoints
			if (!endpoints.get(source.endpoint)?.unsupportedMethods?.includes("eth_getBlockReceipts")) {
				const result = yield* this.requestAt(source, { method: "eth_getBlockReceipts", params: [plan.number] })
				if (result !== null && result.every((receipt) => receipt.blockNumber === plan.number)) {
					yield* this.live.acceptReceipts(result)
				}
				return
			}
			const active = [...endpoints.values()].filter((endpoint) => endpoint.status._tag === "Selected")
			if (active.some((endpoint) => !endpoint.unsupportedMethods?.includes("eth_getBlockReceipts")) ||
				active.find((endpoint) => !endpoint.unsupportedMethods?.includes("eth_getTransactionReceipt"))?.endpoint !== source.endpoint) return
			const state = yield* SubscriptionRef.get(this.live.state)
			const head = [...state.heads.values()].find((head) => head.number === plan.number)
			const block = head?.hash ? state.blocks.get(head.hash) : undefined
			if (block === undefined) return
			yield* Effect.forEach(block.transactions, (tx) => {
				const cached = state.receipts.get(block.hash)?.get(tx.hash)
				if (cached?.blockNumber === block.number && cached.transactionIndex === tx.transactionIndex) return Effect.void
				return this.requestAt(source, { method: "eth_getTransactionReceipt", params: [tx.hash] }).pipe(
					Effect.flatMap((receipt) => receipt === null || receipt.blockHash !== block.hash
						? Effect.void : this.live.acceptReceipts([receipt])),
					Effect.ignore,
				)
			}, { concurrency: 4, discard: true })
		})
	}

	private pollComponent(source: EndpointSource, plan: BlockPlan, receipts: boolean): Stream.Stream<void> {
		const announced = this.blocks.pipe(Stream.filter((head) => head.number >= plan.number), Stream.take(1), Stream.runDrain)
		const due = Effect.sleep(Math.max(0, plan.dueAt - Date.now()))
		const start = source.transport === "ws" ? announced
			: plan.full || receipts ? Effect.raceAll([announced, due]) : due
		return Stream.fromEffect(start).pipe(Stream.flatMap(() => Stream.tick(100).pipe(
			Stream.mapEffect(() => {
				const fetch = receipts
					? this.fetchReceipts(source, plan)
					: this.requestAt(source, { method: "eth_getBlockByNumber", params: [plan.number, plan.full] }).pipe(
						Effect.flatMap((result) => result === null || result.number !== plan.number ? Effect.void : Effect.gen({ self: this }, function* () {
							const head = toBlockHead(result, source)
							if (plan.full) yield* this.live.acceptBlock(result)
							yield* this.observe(head)
						})))
				return fetch.pipe(Effect.catch(() => Effect.sleep(250)))
			}, { concurrency: receipts ? 1 : 2, unordered: true }),
		)))
	}

	private watchComponent(receipts: boolean): Effect.Effect<void> {
		const changes = Stream.mergeAll([
			SubscriptionRef.changes(this.head).pipe(Stream.map(() => undefined)),
			SubscriptionRef.changes(this.live.state).pipe(Stream.map(() => undefined)),
		], { concurrency: "unbounded" })
		return changes.pipe(
			Stream.mapEffect(() => Effect.all([SubscriptionRef.get(this.head), SubscriptionRef.get(this.live.state)])),
			Stream.map(([head, state]) => Option.isNone(head) ? undefined : this.live.plan(state, head.value, this.config.network.blockTime, receipts)),
			Stream.changesWith((a, b) => a?.number === b?.number && a?.full === b?.full),
			Stream.switchMap((plan) => plan === undefined ? Stream.empty : Stream.mergeAll([
				SubscriptionRef.changes(this.activeHttp).pipe(Stream.switchMap((active) => Stream.mergeAll(
					active.map(({ endpoint }) => this.pollComponent({ endpoint, transport: "http" }, plan, receipts)),
					{ concurrency: "unbounded" },
				))),
				SubscriptionRef.changes(this.activeWs).pipe(Stream.switchMap((active) => plan.full || receipts ? Stream.mergeAll(
					active.map(({ state }) => this.pollComponent({ endpoint: state.endpoint, transport: "ws" }, plan, receipts)),
					{ concurrency: "unbounded" },
				) : Stream.empty)),
			], { concurrency: "unbounded" })),
			Stream.runDrain,
		)
	}

	private startBlockWatchers(): Effect.Effect<void, never, Scope.Scope> {
		const wsWatcher = SubscriptionRef.changes(this.activeWs).pipe(
			Stream.switchMap((active) => Stream.mergeAll(active.map(({ state }) => ethWsWatchNewHeads(state).pipe(
				Stream.map((block) => ({ block, state })),
				Stream.catch(() => Stream.empty),
			)), { concurrency: "unbounded" })),
			Stream.runForEach(({ block, state }) => {
				const source: EndpointSource = { endpoint: state.endpoint, transport: "ws" }
				const observedAt = block.observedAt
				return Effect.all([
					this.record(source, {
						_tag: "Success",
						method: "eth_subscribe",
						observedAt,
						responseMs: 0,
						blockNumber: block.number,
						blockAgeMs: observedAt - Number(block.timestamp) * 1_000,
					}),
					this.observe({ ...block, observedAt, source }),
				], { discard: true })
			}),
		)
		const receiptWatcher = SubscriptionRef.changes(this.live.state).pipe(
			Stream.map((state) => state.receiptUsers > 0), Stream.changes,
			Stream.switchMap((needed) => needed ? SubscriptionRef.changes(this.activeWs).pipe(
				Stream.switchMap((active) => Stream.mergeAll(active.map(({ state }) => ethWsWatchReceipts(state).pipe(
					Stream.mapEffect((receipts) => this.live.acceptReceipts(receipts)),
					Stream.catch(() => Stream.empty),
				)), { concurrency: "unbounded" })),
			) : Stream.empty),
			Stream.runDrain,
		)
		return Effect.forEach([wsWatcher, receiptWatcher, this.watchComponent(false), this.watchComponent(true)],
			(watcher) => Effect.forkScoped(watcher), { discard: true }).pipe(
			Effect.asVoid,
		)
	}
}
