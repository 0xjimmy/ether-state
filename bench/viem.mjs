import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { Socket } from 'effect/unstable/socket'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { EvmClient } from '../src/index.ts'
import { viemTransport } from '../src/viem.ts'

const upstream = process.env.BASE_RPC_HTTP_URL ?? 'https://mainnet.base.org'
const durationMs = Number(process.env.BENCH_DURATION_MS ?? 60000)
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 10)
const workload = process.env.BENCH_WORKLOAD ?? 'blockNumber'
const target = process.env.BENCH_ADDRESS ?? '0x4200000000000000000000000000000000000006'

const emptyCounters = () => ({ envelopes: 0, items: 0, requestBytes: 0, responseBytes: 0, failures: 0, active: 0, maxConcurrency: 0 })
let counters = emptyCounters()
const proxy = Bun.serve({
  port: 0,
  async fetch(request) {
	const stats = counters
    const body = await request.text()
    stats.envelopes++
    stats.requestBytes += Buffer.byteLength(body)
    stats.active++
    stats.maxConcurrency = Math.max(stats.maxConcurrency, stats.active)
    try {
      const parsed = JSON.parse(body)
      stats.items += Array.isArray(parsed) ? parsed.length : 1
      const response = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      const responseBody = await response.text()
      stats.responseBytes += Buffer.byteLength(responseBody)
      if (!response.ok) stats.failures++
      return new Response(responseBody, { status: response.status, headers: { 'content-type': 'application/json' } })
    } catch (error) {
      stats.failures++
      return Response.json({ error: String(error) }, { status: 502 })
    } finally {
      stats.active--
    }
  },
})
const proxyUrl = `http://127.0.0.1:${proxy.port}`

const percentile = (values, fraction) => values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0
const runArm = async (name, client, blockNumber) => {
  const latencies = []
  let completed = 0
  let failures = 0
  const action = workload === 'balance'
    ? () => client.getBalance({ address: target, blockNumber })
    : workload === 'dedupe'
      ? () => Promise.all(Array.from({ length: 20 }, () => client.getBalance({ address: target, blockNumber })))
      : () => client.getBlockNumber({ cacheTime: 0 })
  const coldStarted = performance.now()
  await action()
  const coldLatencyMs = performance.now() - coldStarted
  counters = emptyCounters()
  const started = performance.now()
  const end = started + durationMs
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() < end) {
      const requestStarted = performance.now()
      try {
        await action()
        completed++
      } catch {
        failures++
      }
      latencies.push(performance.now() - requestStarted)
    }
  }))
  const elapsedMs = performance.now() - started
  latencies.sort((left, right) => left - right)
  return {
    name, workload, coldLatencyMs, durationMs: elapsedMs, concurrency, completed, failures,
    requestsPerSecond: completed / (elapsedMs / 1000),
    latencyMs: { p50: percentile(latencies, 0.50), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) },
    upstream: {
      envelopes: counters.envelopes, items: counters.items, requestBytes: counters.requestBytes,
      responseBytes: counters.responseBytes, failures: counters.failures, retries: 0, maxConcurrency: counters.maxConcurrency,
    },
  }
}

try {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const evm = yield* EvmClient.make({
      endpoints: { http: [proxyUrl], ws: [] }, network: { chainId: 8453n, blockTime: 2000 },
      options: { concurrentHttp: 1, concurrentWs: 0, batchWindow: 5, maxRequestsPerSecond: 1000, maxConcurrentRequests: concurrency },
    })
    const direct = createPublicClient({ chain: base, transport: http(proxyUrl, { retryCount: 0 }), cacheTime: 0 })
    const adapted = createPublicClient({ chain: base, transport: viemTransport(evm), batch: { multicall: false }, cacheTime: 0 })
    const blockNumber = (yield* Effect.promise(() => direct.getBlockNumber())) - 5n
    const directResult = yield* Effect.promise(() => runArm('viem', direct, blockNumber))
    const adaptedResult = yield* Effect.promise(() => runArm('ether-state', adapted, blockNumber))
    return { upstream, blockNumber: blockNumber.toString(), results: [directResult, adaptedResult] }
  })).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(Socket.layerWebSocketConstructorGlobal)))
  const output = JSON.stringify(result, null, 2)
  if (process.env.BENCH_OUTPUT !== undefined) await Bun.write(process.env.BENCH_OUTPUT, `${output}\n`)
  console.log(output)
} finally {
  proxy.stop(true)
}
