import { liveChain, type ChainUpdate } from "./live-chain.js"
import { RpcPriority, RpcDeadline } from "./priority.js"
import { Cause, Effect, Exit, Option, Schema, Scope, Semaphore, Stream, SubscriptionRef } from "effect"
import { makeLifetime, type Lifetime } from "../internal/lifetime.js"
import { HttpClient } from "effect/unstable/http"
import type { Socket } from "effect/unstable/socket"
import { getRpcEndpoints, type ChainListError, type RpcEndpoints } from "./chainList.js"
import { estimateBlockTime, type BlockTimeUnavailable } from "./live.js"
import { ethHttpRpc, HttpBatcher, type RpcHttpError } from "./transport/http.js"
import { MulticallReads, multicallAddress, type ContractRead, type CallError } from "./multicall.js"
import { RequestScheduler } from "./transport/queue.js"
import { callChanges, makeWatchedState, matchesLog, type BlockLogBatch, type WatchCallOptions, type WatchedCall, type WatchedState } from "./watch.js"
import { readFailurePolicy } from "./recovery.js"
import { RpcHistory } from "./history.js"
import { orderedReceipts, type ReceiptBlockUpdate } from "./live.js"
import { RpcQueryCoordinator, rpcQueryKey, type RpcQueryCacheStats } from "./query.js"
import { getRpcMethod, type HttpRpcMethodName, type RpcBlock, type RpcMethodName, type RpcParams,
	type RpcResult, type RpcTransaction, type RpcReceipt, type RpcLog, type RpcLogFilter } from "./schema.js"
import { ethWsRpc, ethWsRpcOnce, ethWsWatchNewHeads, makeWsState, watchSubscription, type RpcWsError, type WsState } from "./transport/ws.js"

const isUnfilteredLogRange = (method: string, filter: unknown): boolean => method === "eth_getLogs" &&
	typeof filter === "object" && filter !== null && !("blockHash" in filter) &&
	(!("address" in filter) || filter.address === undefined) && (!("topics" in filter) || filter.topics === undefined)

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
	readonly unsupportedLogRanges?: boolean
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

export interface EvmClientMetrics {
	readonly scheduler: RequestScheduler["stats"]
	readonly multicall: MulticallReads["stats"]
	readonly requests: { readonly reads: number; readonly attempts: number; readonly extraAttempts: number }
	readonly streams: {
		readonly head: bigint | null
		readonly logs: bigint | null
		readonly logLag: bigint | null
		readonly status: "idle" | "live" | "degraded"
		readonly lastLogAt: number | null
		readonly error: string | null
	}
	/** HTTP batcher counters. Direct requests and WS requests are in requests. */
	readonly http: readonly (HttpBatcher["stats"] & { readonly endpoint: string; readonly maxRps: number })[]
}

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
).pipe(Effect.tap((results) => Effect.logDebug("RPC probe batch complete", {
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
	private fullBlocks: Stream.Stream<FullBlockUpdate> = Stream.empty
	private receiptBlocks: Stream.Stream<ReceiptBlockUpdate> = Stream.empty
	private chainUpdates: Stream.Stream<ChainUpdate> = Stream.empty
	private logBlocks: Stream.Stream<BlockLogBatch> = Stream.empty
	private readonly completedBlocks = new Map<bigint, ReceiptBlockUpdate>()
	private blockReceiptsAvailable = true
	private latestHead: BlockHead | undefined
	private logProgress: { block: bigint | null; at: number | null; error: string | null } = { block: null, at: null, error: null }
	private readonly knownHeads = new Map<string, BlockHead>()
	private readonly methodRetryAt = new Map<string, number>()
	private readonly retryAt = new Map<string, number>()
	private readonly httpBatches = new Map<string, HttpBatcher>()
	private readonly reads: MulticallReads
	private readonly scheduler: RequestScheduler
	private readonly callStreams = new Map<string, Stream.Stream<WatchedCall<string>, CallError | Schema.SchemaError>>()
	private readonly responseTimes = new Map<string, number[]>()
	private readonly backgroundJobs = Semaphore.makeUnsafe(2)
	private readonly requestStats = { reads: 0, attempts: 0, extraAttempts: 0 }

	private constructor(
		readonly config: ResolvedEvmClientConfig,
		private readonly options: ClientOptions,
		private readonly lifetime: Lifetime,
		private readonly httpClient: HttpClient.HttpClient,
		private readonly wsScope: Scope.Scope,
		private readonly activeHttp: SubscriptionRef.SubscriptionRef<readonly ProbeSuccess[]>,
		private readonly activeWs: SubscriptionRef.SubscriptionRef<readonly ActiveWs[]>,
		private readonly head: SubscriptionRef.SubscriptionRef<Option.Option<BlockHead>>,
		private readonly endpointState: SubscriptionRef.SubscriptionRef<ReadonlyMap<string, EndpointState>>,
		private readonly refreshLock: Semaphore.Semaphore,
		private readonly queries: RpcQueryCoordinator,
	) {
		this.scheduler = new RequestScheduler({ rps: options.maxRequestsPerSecond, concurrency: options.maxConcurrentRequests, capacity: options.maxQueuedRequests })
		this.reads = new MulticallReads({ scope: wsScope, window: options.multicallWindow, size: options.multicallMaxCalls,
			maxCalldataBytes: options.multicallMaxCalldataBytes, capacity: options.maxQueuedRequests,
			fetch: (transaction, block) => this.fetch({ method: "eth_call", params: [transaction, block] }),
			code: (block) => this.fetch({ method: "eth_getCode", params: [multicallAddress, block] }) })
		this.blocks = lifetime.watch(SubscriptionRef.changes(head).pipe(
			Stream.filter(Option.isSome),
			Stream.map((value) => value.value),
		))
		this.history = new RpcHistory(this)

	}

	static make(
		config: EvmClientConfig,
	): Effect.Effect<EvmClient, EvmClientInitError, HttpClient.HttpClient | Scope.Scope | Socket.WebSocketConstructor> {
		return Effect.gen(function* () {
			const lifetime = yield* makeLifetime
			return yield* Effect.gen(function* () {
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
					lifetime,
					httpClient,
					wsScope,
					activeHttp,
					activeWs,
					head,
					endpointState,
					refreshLock,
					queries,
				)
				client.chainUpdates = yield* liveChain({ heads: client.blocks,
					load: number => client.loadLiveBlock(number),
					header: number => client.fetchPhysical({ method: "eth_getBlockByNumber", params: [number, false] }, block => block !== null && block.number === number).pipe(
						Effect.flatMap(block => block === null ? Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" }) : Effect.succeed(toBlockHead(block, { endpoint: "canonical", transport: "http" })))),
					recover: work => client.recoverLive(work),
				}).pipe(Stream.tap(update => Effect.sync(() => {
					if (update.kind === "apply") {
						client.logProgress = { block: update.value.number, at: Date.now(), error: null }
						client.completedBlocks.set(update.value.number, update.value)
						while (client.completedBlocks.size > 128) { const first = client.completedBlocks.keys().next(); if (!first.done) client.completedBlocks.delete(first.value) }
					} else {
						client.logProgress.block = update.from - 1n
						for (const number of client.completedBlocks.keys()) if (number >= update.from) client.completedBlocks.delete(number)
					}
				})), Stream.share({ capacity: 16, replay: 1 }))
				client.receiptBlocks = client.chainUpdates.pipe(Stream.filter(update => update.kind === "apply"), Stream.map(update => update.value))
				client.fullBlocks = client.receiptBlocks
				client.logBlocks = client.receiptBlocks.pipe(Stream.map(value => ({ block: { number: value.number, hash: value.block.hash,
					parentHash: value.block.parentHash, timestamp: value.block.timestamp, logsBloom: value.block.logsBloom }, observedAt: value.observedAt, logs: value.logs })))
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
			}).pipe(Scope.provide(lifetime.scope), Effect.onExit((exit) => Exit.isFailure(exit) ? lifetime.close : Effect.void))
		})
	}

	get endpoints(): Effect.Effect<ReadonlyMap<string, EndpointState>> {
		return SubscriptionRef.get(this.endpointState)
	}

	get isClosed(): boolean {
		return this.lifetime.isClosed
	}

	/** Stop workers and requests, close sockets, and wait for cleanup. Idempotent. */
	close(): Effect.Effect<void> {
		return this.lifetime.close
	}

	/** Bound background sections across all pools and accounts borrowing this client. */
	background<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
		return this.lifetime.run(this.backgroundJobs.withPermit(work.pipe(Effect.provideService(RpcPriority, "background"))))
	}

	get queryCache(): Effect.Effect<RpcQueryCacheStats> {
		return this.queries.stats
	}

	get metrics(): EvmClientMetrics {
		const lag = this.latestHead === undefined || this.logProgress.block === null ? null : this.latestHead.number - this.logProgress.block
		const staleHead = this.latestHead !== undefined && Date.now() - this.latestHead.observedAt > Math.max(3_000, this.config.network.blockTime * 3)
		const degraded = staleHead || this.logProgress.error !== null || (lag !== null && lag > BigInt(Math.max(2, Math.ceil(2_000 / this.config.network.blockTime))))
		return {
			scheduler: this.scheduler.stats, multicall: { ...this.reads.stats }, requests: { ...this.requestStats },
			streams: { head: this.latestHead?.number ?? null, logs: this.logProgress.block, logLag: lag,
				status: this.logProgress.block === null ? "idle" : degraded ? "degraded" : "live",
				lastLogAt: this.logProgress.at, error: this.logProgress.error },
			http: [...this.httpBatches].map(([key, batch]) => { const endpoint = key.slice(key.indexOf("\0") + 1); return { endpoint, ...batch.stats, maxRps: this.scheduler.limit(endpoint) } }),
		}
	}

	call(read: ContractRead): Effect.Effect<string, CallError> {
		return this.lifetime.run(this.budget("eth_call", Effect.gen({ self: this }, function* () {
			const reference = read.block ?? "latest"
			if (reference === "pending") return yield* this.fetch({ method: "eth_call", params: [read.transaction, reference] })
			const hashReference = typeof reference === "object" && "blockHash" in reference ? reference.blockHash
				: typeof reference === "string" && hashPattern.test(reference) ? reference : undefined
			let number: bigint
			let hash: string | null
			if (hashReference !== undefined) {
				const cached = yield* SubscriptionRef.get(this.head)
				const known = this.knownHeads.get(hashReference) ?? (Option.isSome(cached) && cached.value.hash === hashReference ? cached.value : undefined)
				if (known !== undefined) {
					number = known.number
					hash = hashReference
				} else {
					const block = yield* this.fetchPhysical({ method: "eth_getBlockByHash", params: [hashReference, false] },
						(block) => block !== null && block.hash.toLowerCase() === hashReference.toLowerCase())
					if (block === null) return yield* Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
					number = block.number
					hash = block.hash
				}
			} else {
				const head = yield* this.getBlock()
				number = head.number
				hash = head.hash
				const numberReference = typeof reference === "bigint" ? reference
					: typeof reference === "object" && "blockNumber" in reference ? reference.blockNumber
						: typeof reference === "string" && /^0x[\da-f]+$/i.test(reference) ? BigInt(reference) : undefined
				if (numberReference !== undefined) {
					number = numberReference
					if (number !== head.number) hash = null
				} else if (reference !== "latest") {
					const tag = yield* Schema.decodeUnknownEffect(Schema.Literals(["earliest", "finalized", "safe"]))(reference)
					const block = yield* this.fetchPhysical({ method: "eth_getBlockByNumber", params: [tag, false] }, (block) => block !== null)
					if (block === null) return yield* Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
					number = block.number
					hash = block.hash
				}
			}
			const block = hash === null ? number : { blockHash: hash, requireCanonical: true }
			yield* Schema.encodeEffect(getRpcMethod("eth_call").request)({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [read.transaction, block] })
			return yield* this.reads.request({ ...read, block, blockNumber: number })
		})))
	}

	watchLogs(filter: RpcLogFilter = {}): Stream.Stream<RpcLog> {
		return this.watchLogBlocks(filter).pipe(Stream.map((batch) => batch.logs), Stream.flattenIterable)
	}

	watchLogBlocks(filter: RpcLogFilter = {}): Stream.Stream<BlockLogBatch> {
		return this.lifetime.watch(this.logBlocks.pipe(Stream.map((batch) => ({ ...batch, logs: batch.logs.filter((log) => matchesLog(log, filter)) }))))
	}

	/** Compatibility alias. All filters run locally on the complete chain stream. */
	watchFilteredLogBlocks(filter: RpcLogFilter): Stream.Stream<BlockLogBatch> { return this.watchLogBlocks(filter) }

	watchLogUpdates(filter: RpcLogFilter = {}): Stream.Stream<BlockLogBatch | { readonly revert: BlockHead }> {
		return this.watchChain().pipe(Stream.map(update => update.kind === "revert" ? { revert: update.ancestor } : {
			block: { number: update.value.number, hash: update.value.block.hash, parentHash: update.value.block.parentHash,
				timestamp: update.value.block.timestamp, logsBloom: update.value.block.logsBloom }, observedAt: update.value.observedAt,
			logs: update.value.logs.filter(log => matchesLog(log, filter)),
		}))
	}

	watchChain(): Stream.Stream<ChainUpdate> { return this.lifetime.watch(this.chainUpdates) }

	watchTransactions(filter: { readonly from?: string; readonly to?: string } = {}): Stream.Stream<RpcTransaction> {
		return this.lifetime.watch(this.fullBlocks.pipe(Stream.map((head) => head.block.transactions.filter((tx) =>
			(filter.from === undefined || tx.from.toLowerCase() === filter.from.toLowerCase()) &&
			(filter.to === undefined || tx.to?.toLowerCase() === filter.to.toLowerCase()))), Stream.flattenIterable))
	}

	watchCall<A>(options: WatchCallOptions<A>): Stream.Stream<WatchedCall<A>, CallError | Schema.SchemaError> {
		const key = JSON.stringify(options.transaction, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value) + String(options.multicall)
		return this.lifetime.watch(Stream.unwrap(Effect.gen({ self: this }, function* () {
			let shared = this.callStreams.get(key)
			if (shared === undefined) {
				shared = yield* callChanges(this, { transaction: options.transaction, ...(options.multicall === undefined ? {} : { multicall: options.multicall }),
					decode: Effect.succeed }).pipe(Stream.share({ capacity: 16, replay: 1 }), Scope.provide(this.wsScope))
				this.callStreams.set(key, shared)
			}
			return shared.pipe(Stream.mapEffect((entry) => options.decode(entry.value).pipe(Effect.map((value) => ({ ...entry, value })))),
				Stream.changesWith((a, b) => options.equals?.(a.value, b.value) ?? false))
		})))
	}

	watchState<A>(options: WatchCallOptions<A>): Effect.Effect<{ readonly current: Effect.Effect<WatchedState<A>>; readonly changes: Stream.Stream<WatchedState<A>> }, never, Scope.Scope> {
		return this.lifetime.run(Effect.gen({ self: this }, function* () {
			const scope = yield* Scope.fork(this.lifetime.scope)
			yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
			const state = yield* makeWatchedState(this, options).pipe(Scope.provide(scope))
			return { ...state, changes: this.lifetime.watch(state.changes) }
		}))
	}

	subscribe<A, I>(options: { readonly params: RpcParams<"eth_subscribe">; readonly schema: Schema.Codec<A, I> }): Stream.Stream<A, RpcWsError> {
		return this.lifetime.watch(SubscriptionRef.changes(this.activeWs).pipe(Stream.switchMap((active) => {
			const first = active[0]
			return first === undefined ? Stream.fail({ _tag: "RpcError", code: -32004, message: "No active WS endpoint" } as const)
				: watchSubscription(first.state, options.params, options.schema).pipe(Stream.map((notification) => notification.value))
		})))
	}

	sendRawTransaction(raw: string): Effect.Effect<string, EvmClientError> {
		return this.lifetime.run(this.budget("eth_sendRawTransaction", Effect.gen({ self: this }, function* () {
			yield* Schema.encodeEffect(getRpcMethod("eth_sendRawTransaction").request)({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] })
			const sources = [...(yield* this.endpoints).values()].filter((endpoint) => endpoint.status._tag === "Selected")
			if (sources.length === 0) return yield* Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
			const results = yield* Effect.forEach(sources, (source) => Effect.exit(this.requestAt(source, { method: "eth_sendRawTransaction", params: [raw] })), { concurrency: "unbounded" })
			for (const result of results) if (Exit.isSuccess(result)) return result.value
			return yield* Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
		}).pipe(Effect.provideService(RpcPriority, "action"))))
	}

	fetchOne<Method extends HedgeableRpcMethodName>(request: { readonly method: Method; readonly params: RpcParams<Method> }): Effect.Effect<RpcResult<Method>, EvmClientError> {
		return this.fetch(request)
	}

	watchBlocks(options: { readonly full: true; readonly logs: true }): Stream.Stream<ReceiptBlockUpdate>
	watchBlocks(options: { readonly full: true; readonly logs?: false }): Stream.Stream<FullBlockUpdate>
	watchBlocks(options?: { readonly full?: false }): Stream.Stream<BlockHead>
	watchBlocks(options: { readonly full: boolean; readonly logs?: boolean }): Stream.Stream<BlockHead | FullBlockUpdate | ReceiptBlockUpdate>
	watchBlocks(options: { readonly full?: boolean; readonly logs?: boolean } = {}): Stream.Stream<BlockHead | FullBlockUpdate | ReceiptBlockUpdate> {
		return this.lifetime.watch(options.logs ? this.receiptBlocks : options.full ? this.fullBlocks : this.blocks)
	}

	private recoverLive<A>(effect: Effect.Effect<A, EvmClientError>): Effect.Effect<A> {
		const retry: Effect.Effect<A> = effect.pipe(Effect.catch((error) => Effect.sync(() => {
			this.logProgress.error = Cause.pretty(Cause.fail(error))
		}).pipe(Effect.andThen(Effect.sleep(250)), Effect.andThen(Effect.suspend(() => retry)))))
		return retry
	}

	private loadLiveBlock(number: bigint): Effect.Effect<ReceiptBlockUpdate, EvmClientError> {
		return Effect.gen({ self: this }, function* () {
			const block = yield* this.fetchPhysical({ method: "eth_getBlockByNumber", params: [number, true] }, block => block !== null &&
				block.number === number && block.transactions.every((tx, index) => typeof tx !== "string" &&
					tx.blockHash === block.hash && tx.blockNumber === number && tx.transactionIndex === BigInt(index)))
			if (block === null) return yield* Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
			const known = this.knownHeads.get(block.hash)
			if (known && known.number !== block.number) return yield* Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" })
			let receipts: readonly RpcReceipt[] | null = null
			if (this.blockReceiptsAvailable) {
				const result = yield* this.fetchBlockReceipts(block).pipe(Effect.result)
				if (result._tag === "Success") receipts = result.success
				else if (readFailurePolicy(result.failure) === "unsupported") this.blockReceiptsAvailable = false
				else return yield* Effect.fail(result.failure)
			}
			const logs = receipts === null ? yield* this.fetchPhysical({ method: "eth_getLogs", params: [{ blockHash: block.hash }] }, logs =>
				(/^0x0+$/.test(block.logsBloom) || logs.length > 0) && logs.every((log, index) => {
					const tx = log.transactionIndex === undefined ? undefined : block.transactions[Number(log.transactionIndex)]
					return tx !== undefined && typeof tx !== "string" && log.blockHash === block.hash && log.blockNumber === number &&
						log.transactionHash === tx.hash && log.logIndex === BigInt(index) && log.removed !== true &&
						log.address !== undefined && log.topics !== undefined && log.data !== undefined
				})) : receipts.flatMap(receipt => receipt.logs)
			const head = toBlockHead(block, { endpoint: "canonical", transport: "http" })
			return { ...head, block: { ...block, transactions: block.transactions.filter(tx => typeof tx !== "string") }, receipts, logs }
		})
	}

	private fetchBlockReceipts(block: RpcBlock): Effect.Effect<readonly RpcReceipt[], EvmClientError> {
		return this.fetchPhysical({ method: "eth_getBlockReceipts", params: [block.hash] },
			(receipts) => receipts !== null && orderedReceipts(block, receipts) !== undefined).pipe(
			Effect.flatMap((receipts) => {
				const ordered = receipts === null ? undefined : orderedReceipts(block, receipts)
				return ordered === undefined ? Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" }) : Effect.succeed(ordered)
			}))
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
				yield* Effect.logDebug("RPC background probe progress", {
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
				for (const result of results) next.set(result.endpoint, { ...next.get(result.endpoint), ...initialEndpointState(result, selectedUrls) })
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
						const key = options.source.endpoint + options.method
						this.responseTimes.set(key, [...(this.responseTimes.get(key) ?? []), observedAt - startedAt].slice(-20))
						this.scheduler.recover(options.source.endpoint)
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
		if (block.hash !== null) {
			const known = this.knownHeads.get(block.hash)
			if (known && known.number !== block.number) {
				this.logProgress.error = "Provider returned one block hash at different heights"
				return Effect.void
			}
			this.knownHeads.set(block.hash, block)
			while (this.knownHeads.size > 256) { const first = this.knownHeads.keys().next(); if (!first.done) this.knownHeads.delete(first.value) }
		}
		return SubscriptionRef.updateSomeEffect(this.head, (current) => {
			const changed = Option.isNone(current) || block.number > current.value.number ||
				(block.number === current.value.number && block.hash !== null && current.value.hash !== block.hash)
			return changed ? Effect.sync(() => { this.latestHead = block }).pipe(Effect.as(Option.some(Option.some(block))))
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
		if (method === "eth_getBlockByNumber" && result !== null && typeof result === "object" && "number" in result && typeof result.number === "bigint" &&
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

	private budget<A, E, R>(method: HttpRpcMethodName, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | EndpointRequestTimeout, R> {
		return Effect.gen({ self: this }, function* () {
			const deadline = Math.min(yield* RpcDeadline, Date.now() + this.options.requestTimeout)
			const failure = (): Effect.Effect<never, EndpointRequestTimeout> => Effect.fail({ _tag: "EndpointRequestTimeout", endpoint: "request-budget", transport: "http", method })
			if (deadline <= Date.now()) return yield* failure()
			return yield* effect.pipe(Effect.provideService(RpcDeadline, deadline), Effect.timeoutOrElse({ duration: Math.max(1, deadline - Date.now()), orElse: failure }))
		})
	}

	private completedResponse(method: HttpRpcMethodName, params: readonly unknown[]): Effect.Effect<unknown, Schema.SchemaError> | undefined {
		const input = params[0]
		const reference = input !== null && typeof input === "object" && "blockHash" in input ? input.blockHash : input
		const cached = typeof reference === "bigint" ? this.completedBlocks.get(reference)
			: typeof reference === "string" && reference === "latest"
				? (this.latestHead === undefined ? undefined : this.completedBlocks.get(this.latestHead.number))
				: [...this.completedBlocks.values()].find(value => value.hash === reference)
		if (!cached) return undefined
		if (reference === "latest" && cached.hash !== this.latestHead?.hash) return undefined
		if (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") return Schema.encodeEffect(getRpcMethod("eth_getBlockByNumber").result)(
			params[1] === true ? cached.block : { ...cached.block, transactions: cached.block.transactions.map(tx => tx.hash) })
		if (method === "eth_getBlockReceipts" && cached.receipts !== null) return Schema.encodeEffect(getRpcMethod("eth_getBlockReceipts").result)(cached.receipts)
		if (method === "eth_getLogs") return Schema.decodeUnknownEffect(getRpcMethod("eth_getLogs").request)({ jsonrpc: "2.0", id: 1, method, params }).pipe(
			Effect.flatMap(request => Schema.encodeEffect(getRpcMethod("eth_getLogs").result)(cached.logs.filter(log => matchesLog(log, request.params[0])))))
		return undefined
	}

	fetch<Method extends HedgeableRpcMethodName>(request: {
		readonly method: Method
		readonly params: RpcParams<Method>
	}): Effect.Effect<RpcResult<Method>, EvmClientError> {
		const definition = getRpcMethod(request.method)
		return this.lifetime.run(this.budget(request.method, Effect.gen({ self: this }, function* () {
			const priority = yield* RpcPriority
			return yield* Schema.encodeEffect(definition.request)({
			jsonrpc: "2.0", id: 1, method: request.method, params: request.params,
		}).pipe(Effect.flatMap((encoded) => {
				const cached = this.completedResponse(request.method, request.params)
				if (cached) return cached.pipe(Effect.flatMap(value => Schema.decodeUnknownEffect(definition.result)(value)))
				return this.queries.get({
			key: priority + rpcQueryKey({ chainId: this.config.network.chainId, method: request.method, params: encoded.params }),
			result: definition.result, load: this.fetchPhysical(request),
			keep: (result) => keepCompletedResult(request, result),
				}) }))
		})))
	}

	private fetchPhysical<Method extends HedgeableRpcMethodName>(request: {
		readonly method: Method
		readonly params: RpcParams<Method>
	}, accept: (result: RpcResult<Method>) => boolean = () => true, policy?: { readonly hedgeInterval?: number; readonly deadline?: number }): Effect.Effect<RpcResult<Method>, EvmClientError> {
		return this.budget(request.method, Effect.suspend(() => {
			let attempts = 0
			let maxAttempts = 4
			let stopped = false
			let lastError: EvmClientError = { _tag: "RpcError", code: -32601, message: `No capable endpoint for ${request.method}` }
			const tried = new Set<string>()
			const excluded = new Set<string>()
			const busy = new Set<string>()
			const lane: Effect.Effect<RpcResult<Method>, EvmClientError> = Effect.gen({ self: this }, function* () {
				while (!stopped) {
					const candidates = [...(yield* this.endpoints).values()].filter((source) =>
						(source.status._tag === "Selected" || source.status._tag === "Standby") &&
						(source.transport === "http" || source.status._tag === "Selected") &&
						!source.unsupportedMethods?.includes(request.method) &&
						!(source.unsupportedLogRanges && isUnfilteredLogRange(request.method, request.params[0])))
					// Do not exhaust four attempts while a verified peer remains untried.
					maxAttempts = Math.max(maxAttempts, new Set([...candidates.map((source) => source.endpoint), ...excluded]).size)
					if (attempts >= maxAttempts) break
					const available = candidates.filter((source) => !excluded.has(source.endpoint) && !busy.has(source.endpoint))
					const untried = available.filter((source) => !tried.has(source.endpoint))
					const endpoints = untried.length > 0 ? untried : available
					const score = (source: EndpointState): number => {
						const recent = this.responseTimes.get(source.endpoint + request.method) ?? []
						const latency = recent.reduce((sum, item) => sum + item, 0) / (recent.length || 1)
						return Math.max(0, (this.retryAt.get(source.endpoint) ?? 0) - Date.now(),
							(this.methodRetryAt.get(source.endpoint + request.method) ?? 0) - Date.now()) * 10 +
							(tried.has(source.endpoint) ? 10_000 : 0) + (source.transport === "ws" ? 20_000 : 0) + this.scheduler.load(source.endpoint) * 50 + (latency || 100)
					}
					endpoints.sort((a, b) => score(a) - score(b))
					const source = endpoints[0]
					if (source === undefined) return yield* Effect.fail(lastError)
					const repeated = tried.has(source.endpoint)
					tried.add(source.endpoint)
					busy.add(source.endpoint)
					attempts++
					this.requestStats.attempts++
					if (attempts > 1) this.requestStats.extraAttempts++
					const attempt = this.requestAt(source, request, !["eth_call", "eth_getBlockByHash", "eth_getBlockByNumber", "eth_getLogs", "eth_getBlockReceipts"].includes(request.method), accept).pipe(
						Effect.tap((result) => this.observeResult(request.method, result, source)),
						Effect.ensuring(Effect.sync(() => { busy.delete(source.endpoint) })))
					const result = yield* Effect.result(repeated ? Effect.sleep(lastError._tag === "BlockUnavailable" ? 50 : 100).pipe(Effect.andThen(attempt)) : attempt)
					if (result._tag === "Success") return result.success
					lastError = result.failure
					const policy = readFailurePolicy(lastError)
					if (policy === "stop") stopped = true
					if (policy === "rotate" || policy === "unsupported") excluded.add(source.endpoint)
				}
				return yield* Effect.fail(lastError)
			})
			this.requestStats.reads++
			const timings = [...this.responseTimes].filter(([key]) => key.endsWith(request.method)).flatMap(([, values]) => values).sort((a, b) => a - b)
			const hedgeDelay = policy?.hedgeInterval ?? Math.max(this.options.hedgeDelay, (timings[Math.floor(timings.length * 0.9)] ?? 0) * 1.25)
			return Effect.raceAll([lane, Effect.sleep(hedgeDelay).pipe(Effect.andThen(lane))]).pipe(
				Effect.timeoutOrElse({ duration: policy?.deadline ?? this.options.requestTimeout, orElse: () => Effect.fail<EndpointRequestTimeout>({ _tag: "EndpointRequestTimeout", endpoint: "request-budget", transport: "http", method: request.method }) }))
		}))
	}

	getBlock(): Effect.Effect<BlockHead, EvmClientError> {
		return this.lifetime.run(this.refreshLock.withPermit(SubscriptionRef.get(this.head).pipe(Effect.flatMap((cached) => {
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
		}))))
	}

	private requestAt<Method extends HttpRpcMethodName>(source: EndpointSource, request: {
		readonly method: Method; readonly params: RpcParams<Method>
	}, batch = false, accept: (result: RpcResult<Method>) => boolean = () => true): Effect.Effect<RpcResult<Method>, EvmClientError> {
		return Effect.gen({ self: this }, function* () {
		const priority = yield* RpcPriority
		const effect = source.transport === "http"
			? ethHttpRpc({ method: request.method, endpoint: source.endpoint, inputParams: request.params,
				...(batch ? { batch: this.httpBatcher(source.endpoint, priority) } : {}) }).pipe(
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
		return yield* this.scheduler.run(source.endpoint, priority, ready.pipe(Effect.andThen(this.tracked({ source, method: request.method, effect: timeoutRequest({
			source, method: request.method, timeout: this.options.requestTimeout, effect: effect.pipe(Effect.flatMap((result) => accept(result) ? Effect.succeed(result) : Effect.fail<BlockUnavailable>({ _tag: "BlockUnavailable" }))),
		}) })))).pipe(
			Effect.map(({ result }) => result),
			Effect.tapError((error) => Effect.sync(() => {
				let delay = 0
				if (readFailurePolicy(error) === "rotate") {
					this.methodRetryAt.set(source.endpoint + request.method, Date.now() + 60_000)
				}
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
					this.methodRetryAt.set(source.endpoint + request.method, Date.now() + 30_000)
					if ((this.retryAt.get(source.endpoint) ?? 0) <= Date.now()) this.scheduler.throttle(source.endpoint)
					this.retryAt.set(source.endpoint, Math.max(this.retryAt.get(source.endpoint) ?? 0, Date.now() + delay))
				}
			})),
			Effect.tapError((error) => isUnfilteredLogRange(request.method, request.params[0]) && error._tag === "RpcError" && /specify an address|archive requests|range.*(unsupported|not supported)/i.test(error.message)
				? SubscriptionRef.update(this.endpointState, (endpoints) => {
					const endpoint = endpoints.get(source.endpoint)
					return endpoint === undefined ? endpoints : new Map(endpoints).set(source.endpoint, { ...endpoint, unsupportedLogRanges: true })
				}) : Effect.void),
			Effect.tapError((error) => readFailurePolicy(error) === "unsupported"
				? SubscriptionRef.update(this.endpointState, (endpoints) => {
					const endpoint = endpoints.get(source.endpoint)
					return endpoint === undefined ? endpoints : new Map(endpoints).set(source.endpoint, {
						...endpoint, unsupportedMethods: [...new Set([...(endpoint.unsupportedMethods ?? []), request.method])],
					})
				}) : Effect.void),
		)
		})
	}

	private httpBatcher(endpoint: string, priority: string): HttpBatcher {
		const key = priority + "\0" + endpoint
		const existing = this.httpBatches.get(key)
		if (existing !== undefined) return existing
		const batch = new HttpBatcher({ endpoint, client: this.httpClient, scope: this.wsScope,
			window: this.options.httpBatchWindow, size: this.options.httpBatchMaxItems, maxBytes: this.options.httpBatchMaxBytes,
			capacity: this.options.maxQueuedRequests, timeout: this.options.requestTimeout })
		this.httpBatches.set(key, batch)
		return batch
	}

	private pollHeads(): Effect.Effect<void> {
		return Effect.forever(Effect.gen({ self: this }, function* () {
			const started = Date.now()
			const fast = this.config.network.blockTime < 500
			const interval = fast ? Math.max(50, this.config.network.blockTime) : 1_000
			const freshWs = this.latestHead?.source.transport === "ws" &&
				started - this.latestHead.observedAt < Math.max(500, this.config.network.blockTime * 1.5)
			if (!freshWs) yield* this.fetchPhysical({ method: "eth_getBlockByNumber", params: ["latest", false] }, (block) => block !== null,
				{ deadline: fast ? Math.min(this.options.requestTimeout, Math.max(500, this.config.network.blockTime * 3)) : this.options.requestTimeout }).pipe(
				Effect.catch((error) => Effect.sync(() => { this.logProgress.error = Cause.pretty(Cause.fail(error)) })))
			yield* Effect.sleep(Math.max(0, interval - (Date.now() - started)))
		}))
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

		return Effect.forEach([wsWatcher, this.pollHeads()],
			(watcher) => Effect.forkScoped(watcher), { discard: true }).pipe(
			Effect.asVoid,
		)
	}
}
