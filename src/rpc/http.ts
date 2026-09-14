import { Effect } from "effect"
import type { Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { HttpBody, HttpClientError } from "effect/unstable/http"
import { getRpcMethod, type HttpRpcMethodName, type RpcError, type RpcMethod, type RpcParams, type RpcResult } from "./schema.js"

export type RpcHttpError = RpcError | Schema.SchemaError | HttpBody.HttpBodyError | HttpClientError.HttpClientError

export interface EthHttpRpcOptions<Method extends HttpRpcMethodName> {
	readonly method: Method
	readonly endpoint: string
	readonly inputParams: RpcParams<Method>
}

const execute = <Method extends string, Params, ParamsEncoded, Result, ResultEncoded>(
	options: { readonly endpoint: string; readonly inputParams: Params },
	definition: RpcMethod<Method, Params, ParamsEncoded, Result, ResultEncoded>,
): Effect.Effect<Result, RpcHttpError, HttpClient.HttpClient> => Effect.gen(function* () {
	const client = yield* HttpClient.HttpClient
	const request = yield* HttpClientRequest.post(options.endpoint).pipe(HttpClientRequest.schemaBodyJson(definition.request)({
		jsonrpc: "2.0", method: definition.method, params: options.inputParams, id: 1,
	}))
	const response = yield* client.execute(request)
	const decoded = yield* response.pipe(
		HttpClientResponse.filterStatusOk,
		Effect.flatMap(HttpClientResponse.schemaBodyJson(definition.response)),
	)
	if ("error" in decoded) return yield* Effect.fail(decoded.error)
	if (decoded.id !== 1) return yield* Effect.fail<RpcError>({
		_tag: "RpcError", code: -32603, message: "RPC response ID does not match the request",
	})
	return decoded.result
})

export const ethHttpRpc = <Method extends HttpRpcMethodName>(
	options: EthHttpRpcOptions<Method>,
): Effect.Effect<RpcResult<Method>, RpcHttpError, HttpClient.HttpClient> => execute(options, getRpcMethod(options.method))
