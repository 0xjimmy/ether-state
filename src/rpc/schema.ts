import { Schema, SchemaGetter } from "effect"

export type RpcId = string | number
export type RpcTag = "http" | "ws" | "eip1193" | "eip5792"

export interface RpcRequest<Method extends string, Params> {
	readonly jsonrpc: "2.0"
	readonly method: Method
	readonly params: Params
	readonly id: RpcId
}
export interface RpcError {
	readonly _tag: "RpcError"
	readonly code: number
	readonly message: string
	readonly data?: unknown
}
interface RpcErrorEncoded { readonly code: number; readonly message: string; readonly data?: unknown }
export type RpcResponse<Result> =
	| { readonly jsonrpc: "2.0"; readonly id: RpcId; readonly result: Result }
	| { readonly jsonrpc: "2.0"; readonly id: RpcId | null; readonly error: RpcError }
type RpcResponseEncoded<Result> =
	| { readonly jsonrpc: "2.0"; readonly id: RpcId; readonly result: Result }
	| { readonly jsonrpc: "2.0"; readonly id: RpcId | null; readonly error: RpcErrorEncoded }

export interface RpcMethod<Method extends string, Params, ParamsEncoded, Result, ResultEncoded,
	Tags extends readonly RpcTag[] = readonly RpcTag[]> {
	readonly method: Method
	readonly tags: Tags
	readonly result: Schema.Codec<Result, ResultEncoded>
	readonly request: Schema.Codec<RpcRequest<Method, Params>, RpcRequest<Method, ParamsEncoded>>
	readonly response: Schema.Codec<RpcResponse<Result>, RpcResponseEncoded<ResultEncoded>>
}

export const RpcErrorCode: Readonly<Record<string, number>> = {
	ParseError: -32700, InvalidRequest: -32600, MethodNotFound: -32601, InvalidParams: -32602, InternalError: -32603,
	InvalidInput: -32000, ResourceNotFound: -32001, ResourceUnavailable: -32002, TransactionRejected: -32003,
	MethodNotSupported: -32004, LimitExceeded: -32005, JsonRpcVersionNotSupported: -32006,
	UnknownExecutionError: 1, InvalidInputExecutionError: 2, ExecutionReverted: 3, MethodNotSupportedExecutionError: 4,
	UserRejectedRequest: 4001, Unauthorized: 4100, UnsupportedMethod: 4200, ProviderDisconnected: 4900,
	ChainDisconnected: 4901, PrunedHistoryUnavailable: 4444, UnsupportedNonOptionalCapability: 5700,
	UnsupportedChainId: 5710, DuplicateBundleId: 5720, UnknownBundleId: 5730, BundleTooLarge: 5740,
	AtomicUpgradeRejected: 5750, AtomicityNotSupported: 5760,
} satisfies Readonly<Record<string, number>>
export const ExecutionErrorCodeRanges: Readonly<Record<string, { readonly from: number; readonly to: number }>> = {
	gas: { from: 800, to: 809 }, txPool: { from: 1000, to: 1001 }, zk: { from: 2000, to: 2000 },
} satisfies Readonly<Record<string, { readonly from: number; readonly to: number }>>

const Id: Schema.Codec<RpcId> = Schema.Union([Schema.String, Schema.Number])
export const RpcErrorSchema: Schema.Codec<RpcError, RpcErrorEncoded> = Schema.Struct({
	_tag: Schema.tagDefaultOmit("RpcError"), code: Schema.Int, message: Schema.String, data: Schema.optional(Schema.Unknown),
})
export const QuantityFromHex: Schema.Codec<bigint, string> = Schema.String
	.check(Schema.isPattern(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/))
	.pipe(Schema.decodeTo(Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)), {
		decode: SchemaGetter.transform(BigInt), encode: SchemaGetter.transform((value) => `0x${value.toString(16)}`),
	}))
const Address = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/))
const Hash32 = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{64}$/))
const HexData = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]*$/))
const BytesMax32 = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{0,64}$/))
const DecimalQuantity = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/))
const BlockTag = Schema.Literals(["earliest", "finalized", "safe", "latest", "pending"])
const BlockNumberOrTag = Schema.Union([QuantityFromHex, BlockTag])
const BlockNumberOrTagOrHash = Schema.Union([BlockNumberOrTag, Hash32,
	Schema.Struct({ blockHash: Hash32, requireCanonical: Schema.optional(Schema.Boolean) }),
	Schema.Struct({ blockNumber: QuantityFromHex }),
])

const nullable = <S extends Schema.Top>(schema: S) => Schema.Union([schema, Schema.Null])
const JsonRecord = Schema.Record(Schema.String, Schema.Json)
const noParams = Schema.Tuple([])
const execution: readonly ["http", "ws", "eip1193"] = ["http", "ws", "eip1193"]
const subscription: readonly ["ws", "eip1193"] = ["ws", "eip1193"]
const wallet: readonly ["eip1193"] = ["eip1193"]
const wallet5792: readonly ["eip1193", "eip5792"] = ["eip1193", "eip5792"]

const AccessListEntry = Schema.Struct({ address: Address, storageKeys: Schema.Array(Hash32) })
const AccessList = Schema.Array(AccessListEntry)
const Authorization = Schema.Struct({
	chainId: QuantityFromHex, nonce: QuantityFromHex, address: Address, yParity: HexData, r: QuantityFromHex,
	s: QuantityFromHex,
})
const TransactionRequest = Schema.Struct({
	type: Schema.optional(HexData), nonce: Schema.optional(QuantityFromHex), to: Schema.optional(nullable(Address)),
	from: Schema.optional(Address), gas: Schema.optional(QuantityFromHex), value: Schema.optional(QuantityFromHex),
	input: Schema.optional(HexData), data: Schema.optional(HexData), gasPrice: Schema.optional(QuantityFromHex),
	maxPriorityFeePerGas: Schema.optional(QuantityFromHex), maxFeePerGas: Schema.optional(QuantityFromHex),
	maxFeePerBlobGas: Schema.optional(QuantityFromHex), accessList: Schema.optional(AccessList),
	blobVersionedHashes: Schema.optional(Schema.Array(Hash32)), blobs: Schema.optional(Schema.Array(HexData)),
	commitments: Schema.optional(Schema.Array(HexData)), proofs: Schema.optional(Schema.Array(HexData)),
	chainId: Schema.optional(QuantityFromHex), authorizationList: Schema.optional(Schema.Array(Authorization)),
})
const Transaction = Schema.Struct({
	...TransactionRequest.fields, blockHash: Hash32, blockNumber: QuantityFromHex,
	blockTimestamp: Schema.optional(QuantityFromHex),
	from: Address, hash: Hash32, transactionIndex: QuantityFromHex, yParity: Schema.optional(HexData),
	v: Schema.optional(QuantityFromHex), r: QuantityFromHex, s: QuantityFromHex,
})
const Log = Schema.Struct({
	removed: Schema.optional(Schema.Boolean), logIndex: Schema.optional(QuantityFromHex),
	transactionIndex: Schema.optional(QuantityFromHex), transactionHash: Hash32, blockHash: Schema.optional(Hash32),
	blockNumber: Schema.optional(QuantityFromHex), blockTimestamp: Schema.optional(QuantityFromHex),
	address: Schema.optional(Address), data: Schema.optional(HexData), topics: Schema.optional(Schema.Array(Hash32)),
})
const Receipt = Schema.Struct({
	type: Schema.optional(HexData), transactionHash: Hash32, transactionIndex: QuantityFromHex, blockHash: Hash32,
	blockNumber: QuantityFromHex, from: Address, to: Schema.optional(nullable(Address)), cumulativeGasUsed: QuantityFromHex,
	gasUsed: QuantityFromHex, blobGasUsed: Schema.optional(QuantityFromHex), contractAddress: Schema.optional(nullable(Address)),
	logs: Schema.Array(Log), logsBloom: HexData, root: Schema.optional(Hash32), status: Schema.optional(QuantityFromHex),
	effectiveGasPrice: QuantityFromHex, blobGasPrice: Schema.optional(QuantityFromHex),
})
const Withdrawal = Schema.Struct({
	index: QuantityFromHex, validatorIndex: QuantityFromHex, address: Address, amount: QuantityFromHex,
})
const Block = Schema.Struct({
	hash: Hash32, parentHash: Hash32, sha3Uncles: Hash32, miner: Address, stateRoot: Hash32, transactionsRoot: Hash32,
	receiptsRoot: Hash32, logsBloom: HexData, difficulty: Schema.optional(QuantityFromHex), number: QuantityFromHex,
	gasLimit: QuantityFromHex, gasUsed: QuantityFromHex, timestamp: QuantityFromHex, extraData: HexData, mixHash: Hash32,
	nonce: HexData, baseFeePerGas: Schema.optional(QuantityFromHex), withdrawalsRoot: Schema.optional(Hash32),
	blobGasUsed: Schema.optional(QuantityFromHex), excessBlobGas: Schema.optional(QuantityFromHex),
	parentBeaconBlockRoot: Schema.optional(Hash32), size: QuantityFromHex,
	transactions: Schema.Array(Schema.Union([Hash32, Transaction])), withdrawals: Schema.optional(Schema.Array(Withdrawal)),
	uncles: Schema.Array(Hash32), requestsHash: Schema.optional(Hash32), blockAccessListHash: Schema.optional(Hash32),
})
const BlockHeader = Schema.Struct({
	...Block.fields, transactions: Schema.optional(Block.fields.transactions), size: Schema.optional(QuantityFromHex),
	uncles: Schema.optional(Schema.Array(Hash32)),
})
const FeeHistory = Schema.Struct({
	oldestBlock: QuantityFromHex, baseFeePerGas: Schema.Array(QuantityFromHex),
	baseFeePerBlobGas: Schema.optional(Schema.Array(QuantityFromHex)), gasUsedRatio: Schema.Array(Schema.Number),
	blobGasUsedRatio: Schema.optional(Schema.Array(Schema.Number)),
	reward: Schema.optional(Schema.Array(Schema.Array(QuantityFromHex))),
})
const Topic = Schema.Union([Hash32, Schema.Null, Schema.Array(nullable(Hash32))])
const Filter = Schema.Union([
	Schema.Struct({ blockHash: Hash32, address: Schema.optional(Schema.Union([Address, Schema.Array(Address)])),
		topics: Schema.optional(Schema.Array(Topic)) }),
	Schema.Struct({ fromBlock: Schema.optional(BlockNumberOrTag), toBlock: Schema.optional(BlockNumberOrTag),
		address: Schema.optional(Schema.Union([Address, Schema.Array(Address)])), topics: Schema.optional(Schema.Array(Topic)) }),
])
const StorageProof = Schema.Struct({ key: BytesMax32, value: QuantityFromHex, proof: Schema.Array(HexData) })
const AccountProof = Schema.Struct({
	address: Address, accountProof: Schema.Array(HexData), balance: QuantityFromHex, codeHash: Hash32,
	nonce: QuantityFromHex, storageHash: Hash32, storageProof: Schema.Array(StorageProof),
})
const StateOverrideAccount = Schema.Struct({
	nonce: Schema.optional(QuantityFromHex), balance: Schema.optional(QuantityFromHex), code: Schema.optional(HexData),
	movePrecompileToAddress: Schema.optional(Address), state: Schema.optional(Schema.Record(Schema.String, Hash32)),
	stateDiff: Schema.optional(Schema.Record(Schema.String, Hash32)),
})
const BlockOverrides = Schema.Struct({
	number: Schema.optional(QuantityFromHex), prevRandao: Schema.optional(QuantityFromHex),
	time: Schema.optional(QuantityFromHex), gasLimit: Schema.optional(QuantityFromHex), feeRecipient: Schema.optional(Address),
	baseFeePerGas: Schema.optional(QuantityFromHex), withdrawals: Schema.optional(Schema.Array(Withdrawal)),
	blobBaseFee: Schema.optional(QuantityFromHex),
})
const SimulatePayload = Schema.Struct({
	blockStateCalls: Schema.Array(Schema.Struct({ blockOverrides: Schema.optional(BlockOverrides),
		stateOverrides: Schema.optional(Schema.Record(Schema.String, StateOverrideAccount)),
		calls: Schema.Array(TransactionRequest) })),
	traceTransfers: Schema.optional(Schema.Boolean), validation: Schema.optional(Schema.Boolean),
	returnFullTransactions: Schema.optional(Schema.Boolean),
})
const SimulateResult = Schema.Array(Schema.Struct({ ...Block.fields, calls: Schema.Array(Schema.Struct({
	status: HexData, returnData: HexData, gasUsed: QuantityFromHex, maxUsedGas: Schema.optional(QuantityFromHex),
	error: Schema.optional(Schema.Struct({ code: Schema.Int, message: Schema.String })), logs: Schema.optional(Schema.Array(Log)),
})) }))
const AccessListResult = Schema.Struct({
	accessList: Schema.optional(AccessList), error: Schema.optional(Schema.String), gasUsed: Schema.optional(QuantityFromHex),
})
const Syncing = Schema.Union([Schema.Literal(false), Schema.Struct({
	startingBlock: Schema.optional(QuantityFromHex), currentBlock: Schema.optional(QuantityFromHex),
	highestBlock: Schema.optional(QuantityFromHex),
})])
const Configuration = Schema.Struct({ activationTime: Schema.Number,
	blobSchedule: Schema.Struct({ baseFeeUpdateFraction: Schema.Int, max: Schema.Int, target: Schema.Int }),
	chainId: QuantityFromHex, forkId: HexData, precompiles: Schema.Record(Schema.String, Address),
	systemContracts: Schema.Record(Schema.String, Address) })
const ResourceCapability = Schema.Struct({ disabled: Schema.Boolean, oldestBlock: Schema.optional(QuantityFromHex),
	deleteStrategy: Schema.optional(Schema.Struct({ type: Schema.Literal("window"), retentionBlocks: QuantityFromHex })) })
const EthCapabilities = Schema.Struct({ head: Schema.Struct({ number: QuantityFromHex, hash: Hash32 }),
	state: ResourceCapability, tx: ResourceCapability, logs: ResourceCapability, receipts: ResourceCapability,
	blocks: ResourceCapability, stateproofs: ResourceCapability })
const BlockAccessList = Schema.Array(Schema.Struct({ address: Address, storageChanges: Schema.Array(Schema.Json),
	storageReads: Schema.Array(Hash32), balanceChanges: Schema.Array(Schema.Json), nonceChanges: Schema.Array(Schema.Json),
	codeChanges: Schema.Array(Schema.Json) }))

const Permission = Schema.Struct({ parentCapability: Schema.String, date: Schema.optional(Schema.Number),
	caveats: Schema.optional(Schema.Array(Schema.Json)) })
const AddEthereumChain = Schema.Struct({ chainId: QuantityFromHex,
	blockExplorerUrls: Schema.optional(Schema.Array(Schema.String)), chainName: Schema.optional(Schema.String),
	iconUrls: Schema.optional(Schema.Array(Schema.String)), nativeCurrency: Schema.optional(Schema.Struct({
		name: Schema.String, symbol: Schema.String, decimals: Schema.Int })), rpcUrls: Schema.optional(Schema.Array(Schema.String)) })
const WatchAsset = Schema.Struct({ type: Schema.Literal("ERC20"), options: Schema.Struct({ address: Address,
	symbol: Schema.optional(Schema.String), decimals: Schema.optional(Schema.Int), image: Schema.optional(Schema.String) }) })
const Capability = Schema.StructWithRest(Schema.Struct({ optional: Schema.optional(Schema.Boolean) }),
	[Schema.Record(Schema.String, Schema.Json)])
const Capabilities = Schema.Record(Schema.String, Capability)
const SendCalls = Schema.Struct({ version: Schema.String, id: Schema.optional(Schema.String), from: Schema.optional(Address),
	chainId: QuantityFromHex, atomicRequired: Schema.Boolean, calls: Schema.Array(Schema.Struct({
		to: Schema.optional(Address), data: Schema.optional(HexData), value: Schema.optional(QuantityFromHex),
		capabilities: Schema.optional(Capabilities) })), capabilities: Schema.optional(Capabilities) })
const CallsReceipt = Schema.Struct({ logs: Schema.Array(Schema.Struct({ address: Address, data: HexData,
	topics: Schema.Array(Hash32) })), status: QuantityFromHex, blockHash: Hash32, blockNumber: QuantityFromHex,
	gasUsed: QuantityFromHex, transactionHash: Hash32 })
const CallsStatus = Schema.Struct({ version: Schema.String, id: HexData, chainId: QuantityFromHex, status: Schema.Int,
	atomic: Schema.Boolean, receipts: Schema.optional(Schema.Array(CallsReceipt)), capabilities: Schema.optional(JsonRecord) })

const defineRpc = <Method extends string, const Tags extends readonly RpcTag[], Params, ParamsEncoded, Result, ResultEncoded>(
	method: Method, tags: Tags, params: Schema.Codec<Params, ParamsEncoded>, result: Schema.Codec<Result, ResultEncoded>,
): RpcMethod<Method, Params, ParamsEncoded, Result, ResultEncoded, Tags> => ({ method, tags, result,
	request: Schema.Struct({ jsonrpc: Schema.Literal("2.0"), method: Schema.Literal(method), params, id: Id }),
	response: Schema.Union([Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: Id, result }),
		Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: Schema.Union([Id, Schema.Null]), error: RpcErrorSchema })]) })
const optionalBlock = <A extends Schema.Top>(first: A) => Schema.Union([
	Schema.Tuple([first]), Schema.Tuple([first, BlockNumberOrTagOrHash]),
])
const optionalNumberedBlock = <A extends Schema.Top>(first: A) => Schema.Union([
	Schema.Tuple([first]), Schema.Tuple([first, BlockNumberOrTag]),
])

export type RpcHex = string
export type RpcBlockTag = "earliest" | "finalized" | "safe" | "latest" | "pending"
export type RpcBlockReference = bigint | RpcHex | { readonly blockHash: RpcHex; readonly requireCanonical?: boolean | undefined } | { readonly blockNumber: bigint }
export interface RpcTransactionRequest {
	readonly type?: RpcHex | undefined
	readonly nonce?: bigint | undefined
	readonly to?: RpcHex | null | undefined
	readonly from?: RpcHex | undefined
	readonly gas?: bigint | undefined
	readonly value?: bigint | undefined
	readonly input?: RpcHex | undefined
	readonly data?: RpcHex | undefined
	readonly gasPrice?: bigint | undefined
	readonly maxPriorityFeePerGas?: bigint | undefined
	readonly maxFeePerGas?: bigint | undefined
	readonly maxFeePerBlobGas?: bigint | undefined
	readonly chainId?: bigint | undefined
	readonly accessList?: ReadonlyArray<{ readonly address: RpcHex; readonly storageKeys: ReadonlyArray<RpcHex> }> | undefined
	readonly blobVersionedHashes?: ReadonlyArray<RpcHex> | undefined
	readonly authorizationList?: ReadonlyArray<Readonly<Record<string, unknown>>> | undefined
}
export interface RpcTransaction extends RpcTransactionRequest {
	readonly blockHash: RpcHex
	readonly blockNumber: bigint
	readonly blockTimestamp?: bigint | undefined
	readonly from: RpcHex
	readonly hash: RpcHex
	readonly transactionIndex: bigint
	readonly r: bigint
	readonly s: bigint
}
export interface RpcLog {
	readonly transactionHash: RpcHex
	readonly transactionIndex?: bigint | undefined
	readonly logIndex?: bigint | undefined
	readonly blockHash?: RpcHex | undefined
	readonly blockNumber?: bigint | undefined
	readonly blockTimestamp?: bigint | undefined
	readonly address?: RpcHex | undefined
	readonly data?: RpcHex | undefined
	readonly topics?: ReadonlyArray<RpcHex> | undefined
	readonly removed?: boolean | undefined
}
export interface RpcReceipt {
	readonly transactionHash: RpcHex
	readonly transactionIndex: bigint
	readonly blockHash: RpcHex
	readonly blockNumber: bigint
	readonly from: RpcHex
	readonly gasUsed: bigint
	readonly cumulativeGasUsed: bigint
	readonly effectiveGasPrice: bigint
	readonly logs: ReadonlyArray<RpcLog>
	readonly status?: bigint | undefined
}
export interface RpcBlock {
	readonly hash: RpcHex
	readonly parentHash: RpcHex
	readonly stateRoot: RpcHex
	readonly transactionsRoot: RpcHex
	readonly receiptsRoot: RpcHex
	readonly logsBloom: RpcHex
	readonly number: bigint
	readonly timestamp: bigint
	readonly gasLimit: bigint
	readonly gasUsed: bigint
	readonly size: bigint
	readonly transactions: ReadonlyArray<RpcHex | RpcTransaction>
	readonly baseFeePerGas?: bigint | undefined
}
export interface RpcFeeHistory {
	readonly oldestBlock: bigint
	readonly baseFeePerGas: ReadonlyArray<bigint>
	readonly gasUsedRatio: ReadonlyArray<number>
	readonly reward?: ReadonlyArray<ReadonlyArray<bigint>> | undefined
}
export type RpcFilterTopic = RpcHex | null | ReadonlyArray<RpcHex | null>
export interface RpcLogFilter {
	readonly address?: RpcHex | ReadonlyArray<RpcHex> | undefined
	readonly topics?: ReadonlyArray<RpcFilterTopic> | undefined
}
export type RpcFilter =
	| (RpcLogFilter & { readonly blockHash: RpcHex; readonly fromBlock?: never; readonly toBlock?: never })
	| (RpcLogFilter & {
		readonly blockHash?: never
		readonly fromBlock?: bigint | RpcBlockTag | undefined
		readonly toBlock?: bigint | RpcBlockTag | undefined
	})
export type RpcJson = null | boolean | number | string | ReadonlyArray<RpcJson> | { readonly [key: string]: RpcJson }
type Contract<Params, Result> = { readonly params: Params; readonly result: Result }
type NoParams = readonly []
type OptionalBlock<First> = readonly [First] | readonly [First, RpcBlockReference]
type Encoded<T> = T extends bigint ? string
	: T extends ReadonlyArray<unknown> ? { readonly [Key in keyof T]: Encoded<T[Key]> }
	: T extends object ? { readonly [Key in keyof T]: Encoded<T[Key]> }
	: T

interface ExecutionRpcContracts {
	readonly eth_accounts: Contract<NoParams, ReadonlyArray<RpcHex>>
	readonly eth_baseFee: Contract<NoParams, bigint>
	readonly eth_blobBaseFee: Contract<NoParams, bigint>
	readonly eth_blockNumber: Contract<NoParams, bigint>
	readonly eth_call: Contract<OptionalBlock<RpcTransactionRequest>, RpcHex>
	readonly eth_capabilities: Contract<NoParams, Readonly<Record<string, unknown>>>
	readonly eth_chainId: Contract<NoParams, bigint>
	readonly eth_coinbase: Contract<NoParams, RpcHex>
	readonly eth_config: Contract<NoParams, Readonly<Record<string, unknown>>>
	readonly eth_createAccessList: Contract<OptionalBlock<RpcTransactionRequest>, Readonly<Record<string, unknown>>>
	readonly eth_estimateGas: Contract<OptionalBlock<RpcTransactionRequest>, bigint>
	readonly eth_feeHistory: Contract<readonly [bigint, bigint | RpcBlockTag, ReadonlyArray<number>], RpcFeeHistory>
	readonly eth_fillTransaction: Contract<readonly [RpcTransactionRequest], { readonly tx: RpcTransactionRequest }>
	readonly eth_gasPrice: Contract<NoParams, bigint>
	readonly eth_getBalance: Contract<OptionalBlock<RpcHex>, bigint>
	readonly eth_getBlockAccessList: Contract<readonly [RpcBlockReference], ReadonlyArray<Readonly<Record<string, unknown>>> | null>
	readonly eth_getBlockByHash: Contract<readonly [RpcHex, boolean], RpcBlock | null>
	readonly eth_getBlockByNumber: Contract<readonly [bigint | RpcBlockTag, boolean], RpcBlock | null>
	readonly eth_getBlockReceipts: Contract<readonly [RpcBlockReference], ReadonlyArray<RpcReceipt> | null>
	readonly eth_getBlockTransactionCountByHash: Contract<readonly [RpcHex], bigint | null>
	readonly eth_getBlockTransactionCountByNumber: Contract<readonly [bigint | RpcBlockTag], bigint | null>
	readonly eth_getCode: Contract<OptionalBlock<RpcHex>, RpcHex>
	readonly eth_getFilterChanges: Contract<readonly [bigint], ReadonlyArray<RpcHex> | ReadonlyArray<RpcLog>>
	readonly eth_getFilterLogs: Contract<readonly [bigint], ReadonlyArray<RpcLog>>
	readonly eth_getLogs: Contract<readonly [RpcFilter], ReadonlyArray<RpcLog>>
	readonly eth_getProof: Contract<readonly [RpcHex, ReadonlyArray<RpcHex>] |
		readonly [RpcHex, ReadonlyArray<RpcHex>, RpcBlockReference], Readonly<Record<string, unknown>>>
	readonly eth_getStorageAt: Contract<readonly [RpcHex, RpcHex] | readonly [RpcHex, RpcHex, RpcBlockReference], RpcHex>
	readonly eth_getStorageValues: Contract<OptionalBlock<Readonly<Record<string, ReadonlyArray<RpcHex>>>>,
		Readonly<Record<string, ReadonlyArray<RpcHex>>>>
	readonly eth_getTransactionByBlockHashAndIndex: Contract<readonly [RpcHex, bigint], RpcTransaction | null>
	readonly eth_getTransactionByBlockNumberAndIndex: Contract<readonly [bigint | RpcBlockTag, bigint], RpcTransaction | null>
	readonly eth_getTransactionByHash: Contract<readonly [RpcHex], RpcTransaction | null>
	readonly eth_getTransactionCount: Contract<OptionalBlock<RpcHex>, bigint>
	readonly eth_getTransactionReceipt: Contract<readonly [RpcHex], RpcReceipt | null>
	readonly eth_maxPriorityFeePerGas: Contract<NoParams, bigint>
	readonly eth_newBlockFilter: Contract<NoParams, bigint>
	readonly eth_newFilter: Contract<readonly [RpcFilter], bigint>
	readonly eth_newPendingTransactionFilter: Contract<NoParams, bigint>
	readonly eth_sendRawTransaction: Contract<readonly [RpcHex], RpcHex>
	readonly eth_sendTransaction: Contract<readonly [RpcTransactionRequest], RpcHex>
	readonly eth_sign: Contract<readonly [RpcHex, RpcHex], RpcHex>
	readonly eth_signTransaction: Contract<readonly [RpcTransactionRequest], { readonly raw: RpcHex; readonly tx: RpcTransaction }>
	readonly eth_simulateV1: Contract<OptionalBlock<Readonly<Record<string, unknown>>>, ReadonlyArray<Readonly<Record<string, unknown>>>>
	readonly eth_syncing: Contract<NoParams, false | Readonly<Record<string, bigint>>>
	readonly eth_uninstallFilter: Contract<readonly [bigint], boolean>
	readonly net_listening: Contract<NoParams, boolean>
	readonly net_peerCount: Contract<NoParams, bigint>
	readonly net_version: Contract<NoParams, string>
}
interface SubscriptionRpcContracts {
	readonly eth_subscribe: Contract<readonly [string] | readonly [string, RpcFilter | boolean | Readonly<Record<string, unknown>>], RpcHex>
	readonly eth_unsubscribe: Contract<readonly [RpcHex], boolean>
}
interface WalletRpcContracts {
	readonly eth_requestAccounts: Contract<NoParams, ReadonlyArray<RpcHex>>
	readonly eth_signTypedData: Contract<readonly [RpcHex, RpcJson], RpcHex>
	readonly wallet_addEthereumChain: Contract<readonly [Readonly<Record<string, unknown>>], null>
	readonly wallet_getPermissions: Contract<NoParams, ReadonlyArray<Readonly<Record<string, unknown>>>>
	readonly wallet_requestPermissions: Contract<readonly [Readonly<Record<string, RpcJson>>],
		ReadonlyArray<Readonly<Record<string, unknown>>>>
	readonly wallet_switchEthereumChain: Contract<readonly [{ readonly chainId: bigint }], null>
	readonly wallet_watchAsset: Contract<readonly [Readonly<Record<string, unknown>>], boolean>
	readonly wallet_sendCalls: Contract<readonly [Readonly<Record<string, unknown>>],
		{ readonly id: string; readonly capabilities?: Readonly<Record<string, RpcJson>> | undefined }>
	readonly wallet_getCallsStatus: Contract<readonly [string], Readonly<Record<string, unknown>>>
	readonly wallet_showCallsStatus: Contract<readonly [string], null>
	readonly wallet_getCapabilities: Contract<readonly [RpcHex] | readonly [RpcHex, ReadonlyArray<bigint>],
		Readonly<Record<string, Readonly<Record<string, RpcJson>>>>>
}
type RpcContracts = ExecutionRpcContracts & SubscriptionRpcContracts & WalletRpcContracts
export type RpcMethodName = keyof RpcContracts
export type RpcParams<Method extends RpcMethodName> = RpcContracts[Method]["params"]
export type RpcParamsEncoded<Method extends RpcMethodName> = Encoded<RpcParams<Method>>
export type RpcResult<Method extends RpcMethodName> = RpcContracts[Method]["result"]
export type RpcResultEncoded<Method extends RpcMethodName> = Encoded<RpcResult<Method>>
export type HttpRpcMethodName = keyof ExecutionRpcContracts
export type WsRpcMethodName = keyof ExecutionRpcContracts | keyof SubscriptionRpcContracts
export type Eip1193RpcMethodName = RpcMethodName
export type Eip5792RpcMethodName = "wallet_sendCalls" | "wallet_getCallsStatus" | "wallet_showCallsStatus" |
	"wallet_getCapabilities"

interface RpcMethodRuntime {
	readonly method: string
	readonly tags: readonly RpcTag[]
	readonly request: Schema.Top
	readonly response: Schema.Top
}
type RpcRuntimeRegistry = { readonly [Method in RpcMethodName]: RpcMethodRuntime }

const rpcMethods: RpcRuntimeRegistry = {
	eth_accounts: defineRpc("eth_accounts", execution, noParams, Schema.Array(Address)),
	eth_baseFee: defineRpc("eth_baseFee", execution, noParams, QuantityFromHex),
	eth_blobBaseFee: defineRpc("eth_blobBaseFee", execution, noParams, QuantityFromHex),
	eth_blockNumber: defineRpc("eth_blockNumber", execution, noParams, QuantityFromHex),
	eth_call: defineRpc("eth_call", execution, optionalBlock(TransactionRequest), HexData),
	eth_capabilities: defineRpc("eth_capabilities", execution, noParams, EthCapabilities),
	eth_chainId: defineRpc("eth_chainId", execution, noParams, QuantityFromHex),
	eth_coinbase: defineRpc("eth_coinbase", execution, noParams, Address),
	eth_config: defineRpc("eth_config", execution, noParams, Schema.Struct({ current: Configuration,
		next: nullable(Configuration), last: nullable(Configuration) })),
	eth_createAccessList: defineRpc("eth_createAccessList", execution, optionalNumberedBlock(TransactionRequest), AccessListResult),
	eth_estimateGas: defineRpc("eth_estimateGas", execution, optionalNumberedBlock(TransactionRequest), QuantityFromHex),
	eth_feeHistory: defineRpc("eth_feeHistory", execution,
		Schema.Tuple([QuantityFromHex, BlockNumberOrTag, Schema.Array(Schema.Number)]), FeeHistory),
	eth_fillTransaction: defineRpc("eth_fillTransaction", execution, Schema.Tuple([TransactionRequest]),
		Schema.Struct({ tx: TransactionRequest })),
	eth_gasPrice: defineRpc("eth_gasPrice", execution, noParams, QuantityFromHex),
	eth_getBalance: defineRpc("eth_getBalance", execution, optionalBlock(Address), QuantityFromHex),
	eth_getBlockAccessList: defineRpc("eth_getBlockAccessList", execution, Schema.Tuple([BlockNumberOrTagOrHash]),
		nullable(BlockAccessList)),
	eth_getBlockByHash: defineRpc("eth_getBlockByHash", execution, Schema.Tuple([Hash32, Schema.Boolean]), nullable(Block)),
	eth_getBlockByNumber: defineRpc("eth_getBlockByNumber", execution,
		Schema.Tuple([BlockNumberOrTag, Schema.Boolean]), nullable(Block)),
	eth_getBlockReceipts: defineRpc("eth_getBlockReceipts", execution, Schema.Tuple([BlockNumberOrTagOrHash]),
		nullable(Schema.Array(Receipt))),
	eth_getBlockTransactionCountByHash: defineRpc("eth_getBlockTransactionCountByHash", execution,
		Schema.Tuple([Hash32]), nullable(QuantityFromHex)),
	eth_getBlockTransactionCountByNumber: defineRpc("eth_getBlockTransactionCountByNumber", execution,
		Schema.Tuple([BlockNumberOrTag]), nullable(QuantityFromHex)),
	eth_getCode: defineRpc("eth_getCode", execution, optionalBlock(Address), HexData),
	eth_getFilterChanges: defineRpc("eth_getFilterChanges", execution, Schema.Tuple([QuantityFromHex]),
		Schema.Union([Schema.Array(Hash32), Schema.Array(Log)])),
	eth_getFilterLogs: defineRpc("eth_getFilterLogs", execution, Schema.Tuple([QuantityFromHex]), Schema.Array(Log)),
	eth_getLogs: defineRpc("eth_getLogs", execution, Schema.Tuple([Filter]), Schema.Array(Log)),
	eth_getProof: defineRpc("eth_getProof", execution, Schema.Union([Schema.Tuple([Address, Schema.Array(BytesMax32)]),
		Schema.Tuple([Address, Schema.Array(BytesMax32), BlockNumberOrTagOrHash])]), AccountProof),
	eth_getStorageAt: defineRpc("eth_getStorageAt", execution, Schema.Union([Schema.Tuple([Address, BytesMax32]),
		Schema.Tuple([Address, BytesMax32, BlockNumberOrTagOrHash])]), HexData),
	eth_getStorageValues: defineRpc("eth_getStorageValues", execution,
		optionalBlock(Schema.Record(Schema.String, Schema.Array(BytesMax32))), Schema.Record(Schema.String, Schema.Array(HexData))),
	eth_getTransactionByBlockHashAndIndex: defineRpc("eth_getTransactionByBlockHashAndIndex", execution,
		Schema.Tuple([Hash32, QuantityFromHex]), nullable(Transaction)),
	eth_getTransactionByBlockNumberAndIndex: defineRpc("eth_getTransactionByBlockNumberAndIndex", execution,
		Schema.Tuple([BlockNumberOrTag, QuantityFromHex]), nullable(Transaction)),
	eth_getTransactionByHash: defineRpc("eth_getTransactionByHash", execution, Schema.Tuple([Hash32]), nullable(Transaction)),
	eth_getTransactionCount: defineRpc("eth_getTransactionCount", execution, optionalBlock(Address), QuantityFromHex),
	eth_getTransactionReceipt: defineRpc("eth_getTransactionReceipt", execution, Schema.Tuple([Hash32]), nullable(Receipt)),
	eth_maxPriorityFeePerGas: defineRpc("eth_maxPriorityFeePerGas", execution, noParams, QuantityFromHex),
	eth_newBlockFilter: defineRpc("eth_newBlockFilter", execution, noParams, QuantityFromHex),
	eth_newFilter: defineRpc("eth_newFilter", execution, Schema.Tuple([Filter]), QuantityFromHex),
	eth_newPendingTransactionFilter: defineRpc("eth_newPendingTransactionFilter", execution, noParams, QuantityFromHex),
	eth_sendRawTransaction: defineRpc("eth_sendRawTransaction", execution, Schema.Tuple([HexData]), Hash32),
	eth_sendTransaction: defineRpc("eth_sendTransaction", execution, Schema.Tuple([TransactionRequest]), Hash32),
	eth_sign: defineRpc("eth_sign", execution, Schema.Tuple([Address, HexData]), HexData),
	eth_signTransaction: defineRpc("eth_signTransaction", execution, Schema.Tuple([TransactionRequest]),
		Schema.Struct({ raw: HexData, tx: Transaction })),
	eth_simulateV1: defineRpc("eth_simulateV1", execution, optionalBlock(SimulatePayload), SimulateResult),
	eth_subscribe: defineRpc("eth_subscribe", subscription, Schema.Union([
		Schema.Tuple([Schema.Literal("newHeads")]), Schema.Tuple([Schema.Literal("logs"), Filter]),
		Schema.Tuple([Schema.Literal("newPendingTransactions")]),
		Schema.Tuple([Schema.Literal("newPendingTransactions"), Schema.Boolean]),
		Schema.Tuple([Schema.Literal("transactionReceipts")]), Schema.Tuple([Schema.Literal("transactionReceipts"),
			Schema.Struct({ transactionHashes: Schema.optional(Schema.Array(Hash32)) })]),
	]), HexData),
	eth_syncing: defineRpc("eth_syncing", execution, noParams, Syncing),
	eth_uninstallFilter: defineRpc("eth_uninstallFilter", execution, Schema.Tuple([QuantityFromHex]), Schema.Boolean),
	eth_unsubscribe: defineRpc("eth_unsubscribe", subscription, Schema.Tuple([HexData]), Schema.Boolean),
	net_listening: defineRpc("net_listening", execution, noParams, Schema.Boolean),
	net_peerCount: defineRpc("net_peerCount", execution, noParams, QuantityFromHex),
	net_version: defineRpc("net_version", execution, noParams, DecimalQuantity),
	eth_requestAccounts: defineRpc("eth_requestAccounts", wallet, noParams, Schema.Array(Address)),
	eth_signTypedData: defineRpc("eth_signTypedData", wallet, Schema.Tuple([Address, Schema.Json]), HexData),
	wallet_addEthereumChain: defineRpc("wallet_addEthereumChain", wallet, Schema.Tuple([AddEthereumChain]), Schema.Null),
	wallet_getPermissions: defineRpc("wallet_getPermissions", wallet, noParams, Schema.Array(Permission)),
	wallet_requestPermissions: defineRpc("wallet_requestPermissions", wallet, Schema.Tuple([JsonRecord]), Schema.Array(Permission)),
	wallet_switchEthereumChain: defineRpc("wallet_switchEthereumChain", wallet,
		Schema.Tuple([Schema.Struct({ chainId: QuantityFromHex })]), Schema.Null),
	wallet_watchAsset: defineRpc("wallet_watchAsset", wallet, Schema.Tuple([WatchAsset]), Schema.Boolean),
	wallet_sendCalls: defineRpc("wallet_sendCalls", wallet5792, Schema.Tuple([SendCalls]),
		Schema.Struct({ id: Schema.String, capabilities: Schema.optional(JsonRecord) })),
	wallet_getCallsStatus: defineRpc("wallet_getCallsStatus", wallet5792, Schema.Tuple([Schema.String]), CallsStatus),
	wallet_showCallsStatus: defineRpc("wallet_showCallsStatus", wallet5792, Schema.Tuple([Schema.String]), Schema.Null),
	wallet_getCapabilities: defineRpc("wallet_getCapabilities", wallet5792,
		Schema.Union([Schema.Tuple([Address]), Schema.Tuple([Address, Schema.Array(QuantityFromHex)])]),
		Schema.Record(Schema.String, JsonRecord)),
}

export type RpcMethods = RpcRuntimeRegistry
export const RpcMethods: RpcMethods = rpcMethods

export function getRpcMethod<Method extends RpcMethodName>(method: Method): RpcMethod<Method, RpcParams<Method>,
	RpcParamsEncoded<Method>, RpcResult<Method>, RpcResultEncoded<Method>>
export function getRpcMethod(method: RpcMethodName): RpcMethodRuntime
export function getRpcMethod(method: RpcMethodName): RpcMethodRuntime { return RpcMethods[method] }

export const RpcSubscriptionNotification: Schema.Top = Schema.Struct({ jsonrpc: Schema.Literal("2.0"),
	method: Schema.Literal("eth_subscription"), params: Schema.Struct({ subscription: HexData,
		result: Schema.Union([BlockHeader, Log, Hash32, Transaction, Schema.Array(Receipt)]) }) })
