export { EvmClient } from './rpc/client.js'
export type { BlockLogBatch } from './rpc/watch.js'
export * from './rpc/chainList.js'
export type { EvmClientConfig, EvmClientMetrics, ResolvedEvmClientConfig, EvmClientError, EvmClientInitError, BlockHead, FullBlockUpdate } from './rpc/client.js'

export { isLogRangeLimit, readFailurePolicy } from "./rpc/recovery.js"
export type { ReadFailurePolicy } from "./rpc/recovery.js"

export { RpcPriority } from "./rpc/priority.js"
export type { RequestPriority } from "./rpc/priority.js"

export type { ChainUpdate } from "./rpc/live-chain.js"
