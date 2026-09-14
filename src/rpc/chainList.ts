import { Effect, Exit, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

export interface ChainListExplorer {
	readonly [key: string]: unknown
	readonly name?: string
	readonly url: string
	readonly standard?: string
}
export interface ChainListChain {
	readonly [key: string]: unknown
	readonly chainId: number
	readonly name: string
	readonly rpc: readonly (string | { readonly url: string; readonly [key: string]: unknown })[]
	readonly explorers?: readonly (string | ChainListExplorer)[]
}

const Explorer: Schema.Codec<ChainListExplorer> = Schema.StructWithRest(Schema.Struct({
	name: Schema.optionalKey(Schema.String), url: Schema.String, standard: Schema.optionalKey(Schema.String),
}), [Schema.Record(Schema.String, Schema.Unknown)])
const Chain: Schema.Codec<ChainListChain> = Schema.StructWithRest(Schema.Struct({
	chainId: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	name: Schema.String,
	rpc: Schema.Array(Schema.Union([Schema.String, Schema.StructWithRest(Schema.Struct({ url: Schema.String }), [Schema.Record(Schema.String, Schema.Unknown)])])),
	explorers: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Explorer]))),
}), [Schema.Record(Schema.String, Schema.Unknown)])

export interface RpcEndpoints {
	readonly http: readonly string[]
	readonly ws: readonly string[]
}
export interface ChainListUnavailable { readonly _tag: "ChainListUnavailable"; readonly cause: unknown }
export interface ChainNotFound { readonly _tag: "ChainNotFound"; readonly chainId: bigint }
export interface NoRpcEndpoints { readonly _tag: "NoRpcEndpoints"; readonly chainId: bigint }
export type ChainListError = ChainListUnavailable | ChainNotFound | NoRpcEndpoints

const chainList = Effect.runSync(Effect.cachedWithTTL(HttpClient.get("https://chainlist.org/rpcs.json").pipe(
	Effect.flatMap(HttpClientResponse.filterStatusOk),
	Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(Chain))),
	Effect.timeout(10_000),
	Effect.mapError((cause): ChainListUnavailable => ({ _tag: "ChainListUnavailable", cause })),
), (exit) => Exit.isSuccess(exit) ? Infinity : 0))

export const getChainList = (): Effect.Effect<readonly ChainListChain[], ChainListUnavailable, HttpClient.HttpClient> => chainList

export const getChain = (chainId: bigint): Effect.Effect<ChainListChain, ChainListUnavailable | ChainNotFound, HttpClient.HttpClient> =>
	chainList.pipe(Effect.flatMap((chains) => {
		const chain = chains.find((chain) => BigInt(chain.chainId) === chainId)
		return chain === undefined ? Effect.fail<ChainNotFound>({ _tag: "ChainNotFound", chainId }) : Effect.succeed(chain)
	}))

export const getExplorers = (chainId: bigint): Effect.Effect<readonly ChainListExplorer[], ChainListUnavailable | ChainNotFound, HttpClient.HttpClient> =>
	getChain(chainId).pipe(Effect.map((chain) => (chain.explorers ?? []).map((entry) => typeof entry === "string" ? { url: entry } : entry)))

export const getRpcEndpoints = (chainId: bigint): Effect.Effect<RpcEndpoints, ChainListError, HttpClient.HttpClient> =>
	getChain(chainId).pipe(Effect.flatMap((chain) => {
		const http = new Set<string>()
		const ws = new Set<string>()
		for (const entry of chain.rpc) {
			const value = typeof entry === "string" ? entry : entry.url
			if (/[{}<>]|YOUR_|%7[bBdD]/i.test(value) || !URL.canParse(value)) continue
			const url = new URL(value)
			if (url.username || url.password) continue
			if (url.protocol === "http:" || url.protocol === "https:") http.add(url.href)
			if (url.protocol === "ws:" || url.protocol === "wss:") ws.add(url.href)
		}
		return http.size + ws.size === 0 ? Effect.fail<NoRpcEndpoints>({ _tag: "NoRpcEndpoints", chainId })
			: Effect.succeed({ http: [...http], ws: [...ws] })
	}))
