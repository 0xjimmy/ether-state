import { Effect, Exit, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { HttpBody, HttpClientError } from "effect/unstable/http"
import { getRpcMethod, type HttpRpcMethodName, type RpcError, type RpcMethod, type RpcParams, type RpcResult } from "../schema.js"
import type { Scope } from "effect"
import { BatchQueue, type QueueFull } from "./queue.js"

export type RpcHttpError = RpcError | Schema.SchemaError | HttpBody.HttpBodyError | HttpClientError.HttpClientError | QueueFull

export interface EthHttpRpcOptions<Method extends HttpRpcMethodName> {
	readonly method: Method
	readonly endpoint: string
	readonly inputParams: RpcParams<Method>
	readonly batch?: HttpBatcher
}

const execute = <Method extends string, Params, ParamsEncoded, Result, ResultEncoded>(
	options: { readonly endpoint: string; readonly inputParams: Params; readonly batch?: HttpBatcher },
	definition: RpcMethod<Method, Params, ParamsEncoded, Result, ResultEncoded>,
): Effect.Effect<Result, RpcHttpError, HttpClient.HttpClient> => Effect.gen(function* () {
	if (options.batch !== undefined) {
		const encoded = yield* Schema.encodeEffect(definition.request)({ jsonrpc: "2.0", method: definition.method, params: options.inputParams, id: 1 })
		const raw = yield* options.batch.request({ ...encoded, jsonrpc: "2.0" })
		const response = yield* Schema.decodeUnknownEffect(definition.response)(raw)
		return "error" in response ? yield* Effect.fail(response.error) : response.result
	}
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

interface WireRequest { readonly jsonrpc: "2.0"; readonly id: number; readonly method: string; readonly params: unknown }
const wireBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
const Response = Schema.StructWithRest(Schema.Struct({ id: Schema.Union([Schema.Number, Schema.String, Schema.Null]) }),
	[Schema.Record(Schema.String, Schema.Unknown)])
const Responses = Schema.Array(Response)

export class HttpBatcher {
	private nextId = 0
	private unsupportedUntil = 0
	private limit: number
	private readonly queue: BatchQueue<WireRequest, unknown, RpcHttpError>
	readonly stats = { envelopes: 0, requests: 0, batches: 0, singles: 0, fallbacks: 0, resends: 0 }

	constructor(private readonly options: {
		readonly endpoint: string; readonly client: HttpClient.HttpClient; readonly scope: Scope.Scope
		readonly window: number; readonly size: number; readonly maxBytes: number; readonly capacity: number; readonly timeout: number
	}) {
		this.limit = options.size
		this.queue = new BatchQueue<WireRequest, unknown, RpcHttpError>({ ...options, maxWeight: options.maxBytes,
			weight: wireBytes, run: (requests) => this.send(requests) })
	}

	request(request: Omit<WireRequest, "id">): Effect.Effect<unknown, RpcHttpError | QueueFull> {
		return Effect.suspend(() => {
			const id = ++this.nextId
			return this.queue.request({ ...request, id }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Response)),
				Effect.flatMap((response) => response.id === id ? Effect.succeed({ ...response, id: 1 })
					: Effect.fail<RpcError>({ _tag: "RpcError", code: -32603, message: "RPC response ID mismatch" })))
		})
	}

	private execute(body: WireRequest | readonly WireRequest[]): Effect.Effect<unknown, RpcHttpError> {
		return HttpClientRequest.post(this.options.endpoint).pipe(HttpClientRequest.bodyJson(body),
			Effect.tap(() => Effect.sync(() => {
					this.stats.envelopes++
					this.stats.requests += Array.isArray(body) ? body.length : 1
					if (Array.isArray(body)) this.stats.batches++
					else this.stats.singles++
			})), Effect.flatMap(this.options.client.execute), Effect.flatMap(HttpClientResponse.filterStatusOk),
			Effect.flatMap((response) => response.json), Effect.timeoutOrElse({ duration: this.options.timeout,
				orElse: () => Effect.fail<RpcError>({ _tag: "RpcError", code: -32000, message: "RPC batch timed out" }) }))
	}

	private send(requests: readonly WireRequest[]): Effect.Effect<readonly Exit.Exit<unknown, RpcHttpError>[], RpcHttpError> {
		if (requests.length === 0) return Effect.succeed([])
		if (Date.now() < this.unsupportedUntil || requests.length === 1) {
			if (requests.length > 1) this.stats.fallbacks++
			return Effect.forEach(requests, (request) => Effect.exit(this.execute(request)), { concurrency: 4 })
		}
		if (requests.length > this.limit) {
			return Effect.forEach(Array.from({ length: Math.ceil(requests.length / this.limit) }, (_, i) => requests.slice(i * this.limit, (i + 1) * this.limit)),
				(chunk) => this.send(chunk), { concurrency: 1 }).pipe(Effect.map((chunks) => chunks.flat()))
		}
		return this.execute(requests).pipe(Effect.flatMap((value) => {
			if (!Array.isArray(value)) {
				if (value !== null && typeof value === "object" && "error" in value && value.error !== null && typeof value.error === "object" &&
					"code" in value.error && (value.error.code === -32600 || value.error.code === -32601)) {
					this.unsupportedUntil = Date.now() + 60_000
					return this.send(requests)
				}
				return Effect.fail<RpcError>({ _tag: "RpcError", code: -32603, message: "Invalid RPC batch response" })
			}
			return Schema.decodeUnknownEffect(Responses)(value).pipe(Effect.flatMap((responses) => {
				const byId = new Map<number, unknown[]>()
				for (const response of responses) {
					if (typeof response.id !== "number") continue
					byId.set(response.id, [...(byId.get(response.id) ?? []), response])
				}
				return Effect.forEach(requests, (request) => {
					const matches = byId.get(request.id) ?? []
					if (matches.length === 1) return Effect.succeed(Exit.succeed(matches[0]))
					this.stats.resends++
					return Effect.exit(this.execute(request))
				}, { concurrency: 4 })
			}))
		}), Effect.catch((error) => {
			if (error._tag === "HttpClientError" && error.response?.status === 413 && requests.length > 1) {
				this.limit = Math.max(1, Math.floor(requests.length / 2))
				this.stats.fallbacks++
				return this.send(requests)
			}
			return Effect.fail(error)
		}))
	}
}
