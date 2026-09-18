import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { getChainList, getChain, getRpcEndpoints, getExplorers } from "../../src/index.js"

const program = Effect.gen(function* () {
	const chainId = 8453n
	const chains = yield* getChainList()
	const chain = yield* getChain(chainId)
	const endpoints = yield* getRpcEndpoints(chainId)
	const explorers = yield* getExplorers(chainId)
	console.log({ chains: chains.length, name: chain.name, chainId, endpoints, explorers })
	const missing = yield* Effect.exit(getChain(-1n))
	console.log("unknown chain", missing)
})

await Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer), Effect.timeout(15_000)))
