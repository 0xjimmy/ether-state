import { Effect } from "effect"
import type { Schema } from "effect"
import type { CallError } from "./multicall.js"

export const isLogRangeLimit = (error: unknown): boolean => typeof error === "object" && error !== null &&
	"_tag" in error && error._tag === "RpcError" && "message" in error && typeof error.message === "string" &&
	/(?:block range|results?|response size).*(?:too (?:large|wide)|exceed|limit)|(?:maximum|max).*?(?:range|blocks)|query returned more than|too many (?:results|logs)|limited to .*blocks/i.test(error.message)

const historicalStateUnavailable = /unsupported block number|historical (?:state|data).*not available|missing trie node|state.*pruned|archive.*required/i

export type ReadFailurePolicy = "retry" | "rotate" | "unsupported" | "stop"

/** Classify expected failures. Request encoding is validated before routing. */
export const readFailurePolicy = (error: CallError | Schema.SchemaError): ReadFailurePolicy => {
	switch (error._tag) {
		case "DispatchDeclined": return "stop"
		case "BlockUnavailable":
		case "EndpointRequestTimeout":
		case "WsRequestTimeout":
		case "SocketError":
		case "QueueFull":
			return "retry"
		case "HttpClientError":
			if (error.reason._tag === "EncodeError") return "stop"
			return error.reason._tag === "TransportError" || error.response?.status === 408 ||
				error.response?.status === 429 || (error.response !== undefined && error.response.status >= 500) ? "retry" : "rotate"
		case "RpcError":
			if (historicalStateUnavailable.test(error.message) || isLogRangeLimit(error)) return "rotate"
			if (error.code === -32601 || error.code === -32004 || /method.*(unsupported|not supported|not found)/i.test(error.message)) return "unsupported"
			if (/specify an address|archive requests|range.*(unsupported|not supported)/i.test(error.message)) return "rotate"
			if (error.code === 3 || /execution reverted/i.test(error.message)) return "stop"
			if (error.code === -32603 || error.code === -32001 || error.code === -32005 || error.code === -32016 ||
				/rate limit|too many requests|quota|timed out|^(header not found|unknown block|block not found)\b/i.test(error.message)) return "retry"
			return "rotate"
		case "SchemaError": return "rotate"
		case "HttpBodyError":
		case "ContractReverted":
		case "InvalidMulticall": return "stop"
		default: {
			const exhaustive: never = error
			return exhaustive
		}
	}
}

/** A request budget bounds one recovery round, not the caller's whole read. */
export const recoverRead = <A, E extends CallError | Schema.SchemaError, R>(attempt: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	Effect.suspend(() => {
		let failures = 0
		const retry: Effect.Effect<A, E, R> = attempt.pipe(Effect.catch((error) => {
			const policy = readFailurePolicy(error)
			// These errors belong to validation, capability fallback, or range splitting.
			if (policy === "stop" || policy === "unsupported" || isLogRangeLimit(error)) return Effect.fail(error)
			return Effect.sleep(Math.min(1_000, 100 * 2 ** Math.min(failures++, 4))).pipe(Effect.andThen(Effect.suspend(() => retry)))
		}))
		return retry
	})

export const shouldResumeWatch = (error: CallError | Schema.SchemaError): boolean =>
	error._tag !== "SchemaError" && readFailurePolicy(error) !== "stop"
