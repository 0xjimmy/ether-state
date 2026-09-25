import { Context } from "effect"

/** Propagates through request batching, retries, and scoped workers. */
export type RequestPriority = "live" | "action" | "background"
export const RpcPriority: Context.Reference<RequestPriority> = Context.Reference<RequestPriority>("ether-state/RpcPriority", { defaultValue: () => "live" })
/** Absolute operation deadline. Nested requests cannot reset this budget. */
export const RpcDeadline: Context.Reference<number> = Context.Reference<number>("ether-state/RpcDeadline", { defaultValue: () => Infinity })
