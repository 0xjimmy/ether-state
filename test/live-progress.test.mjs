import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Effect, References, Stream } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { Socket } from 'effect/unstable/socket'
import { EvmClient } from '../src/index.ts'

const hex = (number) => `0x${number.toString(16)}`
const hash = (number) => `0x${number.toString(16).padStart(64, '0')}`
const zero = hash(0)
const header = (number) => ({
  hash: hash(number), parentHash: hash(number - 1), number: hex(number), timestamp: hex(Math.floor(Date.now() / 1000)),
  sha3Uncles: zero, miner: `0x${'00'.repeat(20)}`, stateRoot: zero, transactionsRoot: zero, receiptsRoot: zero,
  logsBloom: `0x${'00'.repeat(256)}`, gasLimit: '0x1', gasUsed: '0x0', extraData: '0x', mixHash: zero,
  nonce: '0x0000000000000000', size: '0x1', transactions: [], uncles: [],
})

test('100 ms chain keeps complete ordered logs while RPC responses take 150 ms', async () => {
  const started = Date.now()
  const current = () => 100 + Math.floor((Date.now() - started) / 100)
    let logCalls = 0
  const rpc = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json()
    const reply = async ({ id, method, params }) => {
      if (method === 'eth_chainId') return { jsonrpc: '2.0', id, result: '0x1' }
      await new Promise((resolve) => setTimeout(resolve, 150))
      let result = null
      if (method === 'eth_getBlockByNumber') {
        const n = params[0] === 'latest' ? current() : Number(BigInt(params[0]))
        result = n <= current() ? header(n) : null
      } else if (method === 'eth_getBlockReceipts') { result = []
      } else if (method === 'eth_getLogs') {
        logCalls++
        result = []
      }
      return { jsonrpc: '2.0', id, result }
    }
    return Response.json(Array.isArray(body) ? await Promise.all(body.map(reply)) : await reply(body))
  } })
  try {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const client = yield* EvmClient.make({ network: { chainId: 1n, blockTime: 100 },
        endpoints: { http: [`http://127.0.0.1:${rpc.port}`], ws: [] },
        options: { concurrentHttp: 1, concurrentWs: 0, maxRequestsPerSecond: 80 } })
      const blocks = yield* client.watchLogBlocks().pipe(Stream.take(25), Stream.runCollect)
      return { blocks, metrics: client.metrics }
    })).pipe(Effect.provide([FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal]),
      Effect.provideService(References.MinimumLogLevel, 'None'), Effect.timeout('8 seconds')))
    for (let i = 1; i < result.blocks.length; i++) assert.equal(result.blocks[i].block.number, result.blocks[i - 1].block.number + 1n)
    assert.ok(current() - Number(result.blocks.at(-1).block.number) <= 8)
    assert.equal(logCalls, 0)
    assert.ok(result.metrics.streams.logLag <= 8n)
  } finally { rpc.stop(true) }
}, 10000)
