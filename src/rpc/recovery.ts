import type { Schema } from "effect"
import type { CallError } from "./multicall.js"

export type ReadFailurePolicy = "retry" | "rotate" | "unsupported" | "stop"

/** Classify expected failures. Request encoding is validated before routing. */
export const readFailurePolicy = (error: CallError | Schema.SchemaError): ReadFailurePolicy => {
	switch (error._tag) {
		case "BlockUnavailable":
		case "EndpointRequestTimeout":
		case "WsRequestTimeout":
		case "SocketError":
		case "QueueFull":
			return "retry"
		case "HttpClientError":
			return error.reason._tag === "TransportError" || error.response?.status === 408 ||
				error.response?.status === 429 || (error.response !== undefined && error.response.status >= 500) ? "retry" : "stop"
		case "RpcError":
			if (error.code === -32601 || error.code === -32004 || /method.*(unsupported|not supported|not found)/i.test(error.message)) return "unsupported"
			if (/specify an address|archive requests|range.*(unsupported|not supported)/i.test(error.message)) return "rotate"
			if (error.code === -32602 || error.code === 3 || /execution reverted/i.test(error.message)) return "stop"
			if (error.code === -32001 || error.code === -32005 || error.code === -32016 ||
				/rate limit|too many requests|quota|timed out|^(header not found|unknown block|block not found)\b/i.test(error.message)) return "retry"
			if (/historical state .*not available|missing trie node/i.test(error.message)) return "rotate"
			return "stop"
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

export const shouldResumeWatch = (error: CallError | Schema.SchemaError): boolean => readFailurePolicy(error) === "retry" ||
	(error._tag === "RpcError" && /historical state .*not available|missing trie node/i.test(error.message))
