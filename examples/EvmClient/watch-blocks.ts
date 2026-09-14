import { Effect, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { getAddress, id } from "ethers"
import { EvmClient } from "../../src/index.js"
import type { RpcLog } from "../../src/rpc/schema.js"

const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase()
const transferTopic = id("Transfer(address,address,uint256)")

const logUsdcTransfers = (logs: readonly RpcLog[]): void => {
	for (const log of logs) {
		if (log.address?.toLowerCase() !== usdcAddress || log.removed || log.topics?.length !== 3 ||
			log.topics[0]?.toLowerCase() !== transferTopic) continue
		const [, from, to] = log.topics
		if (from === undefined || to === undefined || log.data === undefined ||
			!/^0x0{24}[\da-f]{40}$/i.test(from) || !/^0x0{24}[\da-f]{40}$/i.test(to) || !/^0x[\da-f]{64}$/i.test(log.data)) continue
		const value = BigInt(log.data)
		const amount = `${(value / 1_000_000n).toLocaleString("en-US")}.${(value % 1_000_000n).toString().padStart(6, "0")}`
		console.log(`[Base USDC] ${amount} USDC | ${getAddress(`0x${from.slice(-40).toLowerCase()}`)} -> ${getAddress(`0x${to.slice(-40).toLowerCase()}`)} | block ${String(log.blockNumber)} | tx ${log.transactionHash}`)
	}
}

const showEndpoint = (endpoint: string) => {
	const url = new URL(endpoint)
	return `${url.protocol}//${url.host}`
}

const program = Effect.scoped(Effect.gen(function* () {
	const client = yield* EvmClient.make({
		network: { chainId: 1n, blockTime: 12_000 },
		options: { requestTimeout: 3_000 },
	})
	console.log("client initialized")
	const block = yield* client.getBlock()
	const chainId = yield* client.fetch({ method: "eth_chainId", params: [] })
	const endpoints = yield* client.endpoints
	const selected = [...endpoints.values()]
		.filter((endpoint) => endpoint.status._tag === "Selected")
		.map((endpoint) => ({ transport: endpoint.transport, endpoint: showEndpoint(endpoint.endpoint) }))
	console.log({
		chainId,
		block: {
			number: block.number, timestamp: block.timestamp, latencyMs: block.latencyMs,
			source: showEndpoint(block.source.endpoint)
		},
		selected,
		probed: endpoints.size,
	})
	console.log("watching new blocks; press Ctrl+C to stop")
	return yield* Effect.all([
		Effect.gen(function* () {
			const client = yield* EvmClient.make({ network: { chainId: 4663n } })
			console.log("client initialized", client.config.network)
			return yield* client.watchBlocks({ full: true, logs: true }).pipe(Stream.runForEach((head) => Effect.sync(() => {
				console.log(`block (${client.config.network.chainId.toString()} full)`, {
					number: head.number,
					hash: head.hash,
					gasUsed: head.block.gasUsed,
					source: showEndpoint(head.source.endpoint),
					transactions: head.block.transactions.length,
					logs: head.logs.length,
					timestamp: head.timestamp,
					observedAt: head.observedAt,
					latencyMs: head.latencyMs,
				})
				if (client.config.network.chainId === 8453n) logUsdcTransfers(head.logs)
			})))
		}),
		client.watchBlocks().pipe(Stream.runForEach((head) => Effect.sync(() => {
			console.log("block (number)", { number: head.number, latencyMs: head.latencyMs })
		}))),
		client.watchBlocks({ full: true, logs: true }).pipe(Stream.runForEach((head) => Effect.sync(() => {
			console.log("block (full)", {
				number: head.number,
				hash: head.hash,
				gasUsed: head.block.gasUsed,
				source: showEndpoint(head.source.endpoint),
				transactions: head.block.transactions.length,
				logs: head.logs.length,
				timestamp: head.timestamp,
				observedAt: head.observedAt,
				latencyMs: head.latencyMs,
			})
		}))),
	], { concurrency: "unbounded", discard: true })
})).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(Socket.layerWebSocketConstructorGlobal))

try {
	await Effect.runPromise(program)
} catch (error) {
	console.error(error)
}
