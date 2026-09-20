import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Effect, References } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { Socket } from 'effect/unstable/socket'
import { EvmClient } from '../src/index.ts'

const hash = (digit) => `0x${digit.repeat(64)}`
const block = (digit, number) => ({
  hash: hash(digit), parentHash: hash('0'), number, timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
  sha3Uncles: hash('0'), miner: `0x${'00'.repeat(20)}`, stateRoot: hash('0'), transactionsRoot: hash('0'), receiptsRoot: hash('0'),
  logsBloom: `0x${'00'.repeat(256)}`, gasLimit: '0x1', gasUsed: '0x0', extraData: '0x', mixHash: hash('0'), nonce: '0x0000000000000000',
  size: '0x1', transactions: [], uncles: [],
})
const head = block('1', '0xa')
const historical = block('2', '0x9')
const read = { transaction: { to: `0x${'11'.repeat(20)}`, data: '0x' }, block: { blockHash: historical.hash, requireCanonical: true }, multicall: false }
const run = (effect) => Effect.runPromise(Effect.scoped(effect).pipe(
  Effect.provide([FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal]),
  Effect.provideService(References.MinimumLogLevel, 'None'), Effect.timeout('5 seconds'),
))
const server = (onHash, onCall = () => '0x1234') => {
  const requests = []
  const instance = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json()
    const reply = async (item) => {
      requests.push(item)
      const value = item.method === 'eth_chainId' ? '0x1'
        : item.method === 'eth_getBlockByNumber' ? head
          : item.method === 'eth_getBlockByHash' ? await onHash(item)
            : item.method === 'eth_call' ? await onCall(item) : null
      return { jsonrpc: '2.0', id: item.id, ...(value?.error ? value : { result: value }) }
    }
    return Response.json(Array.isArray(body) ? await Promise.all(body.map(reply)) : await reply(body))
  } })
  return { url: `http://127.0.0.1:${instance.port}`, requests, stop: () => instance.stop(true) }
}
const make = (servers) => EvmClient.make({ endpoints: { http: servers.map((s) => s.url), ws: [] },
  network: { chainId: 1n, blockTime: 12000 }, options: { concurrentHttp: servers.length, concurrentWs: 0, hedgeDelay: 10, requestTimeout: 500 } })

test('a null header from a fast endpoint does not beat an available block', async () => {
  const fast = server(() => null)
  const slow = server(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return historical })
  try {
    const value = await run(Effect.gen(function* () { return yield* (yield* make([fast, slow])).call(read) }))
    assert.equal(value, '0x1234')
    assert.equal(fast.requests.filter((r) => r.method === 'eth_getBlockByHash').length, 1)
    assert.equal(slow.requests.filter((r) => r.method === 'eth_getBlockByHash').length, 1)
    for (const request of [...fast.requests, ...slow.requests].filter((r) => r.method === 'eth_call')) {
      assert.deepEqual(request.params[1], read.block)
    }
  } finally { fast.stop(); slow.stop() }
})

test('temporarily unavailable hashes recover without changing the block reference', async () => {
  let attempts = 0
  const rpc = server(() => ++attempts < 3 ? null : historical)
  try {
    const value = await run(Effect.gen(function* () { return yield* (yield* make([rpc])).call(read) }))
    assert.equal(value, '0x1234')
    assert.equal(attempts, 3)
    assert.deepEqual(rpc.requests.find((r) => r.method === 'eth_call').params[1], read.block)
  } finally { rpc.stop() }
})

test('a known head avoids a redundant hash lookup and retries lagging state', async () => {
  let attempts = 0
  const rpc = server(() => { throw new Error('Unexpected header lookup') }, () =>
    ++attempts < 3 ? { error: { code: -32000, message: 'header not found' } } : '0x1234')
  try {
    const value = await run(Effect.gen(function* () {
      const client = yield* make([rpc])
      return yield* client.call({ ...read, block: { blockHash: head.hash, requireCanonical: true } })
    }))
    assert.equal(value, '0x1234')
    assert.equal(attempts, 3)
    assert.equal(rpc.requests.filter((r) => r.method === 'eth_getBlockByHash').length, 0)
  } finally { rpc.stop() }
})

test('permanent block unavailability stops after four attempts', async () => {
  let attempts = 0
  const rpc = server(() => { attempts++; return null })
  try {
    const result = await run(Effect.gen(function* () { return yield* Effect.result((yield* make([rpc])).call(read)) }))
    assert.equal(result._tag, 'Failure')
    assert.equal(result.failure._tag, 'BlockUnavailable')
    assert.equal(attempts, 4)
    assert.equal(rpc.requests.filter((r) => r.method === 'eth_call').length, 0)
  } finally { rpc.stop() }
})

test('contract reverts are returned without availability retries', async () => {
  let attempts = 0
  const rpc = server(() => historical, () => { attempts++; return { error: { code: 3, message: 'execution reverted', data: '0x' } } })
  try {
    const result = await run(Effect.gen(function* () { return yield* Effect.result((yield* make([rpc])).call(read)) }))
    assert.equal(result._tag, 'Failure')
    assert.equal(result.failure._tag, 'RpcError')
    assert.equal(attempts, 1)
  } finally { rpc.stop() }
})

test('a slow endpoint loses the hedge without delaying a valid response', async () => {
  const slow = server(() => historical, async () => { await new Promise((resolve) => setTimeout(resolve, 1000)); return '0x1111' })
  const fast = server(() => historical, () => '0x2222')
  try {
    const value = await run(Effect.gen(function* () {
      const client = yield* make([slow, fast])
      return yield* client.call({ ...read, block: { blockHash: head.hash, requireCanonical: true } }).pipe(Effect.timeout('400 millis'))
    }))
    assert.equal(value, '0x2222')
  } finally { slow.stop(); fast.stop() }
})

test('an invalid RPC result cannot beat a slower valid response', async () => {
  const invalid = server(() => historical, () => 'not-hex')
  const valid = server(() => historical, async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return '0x1234' })
  try {
    const value = await run(Effect.gen(function* () { return yield* (yield* make([invalid, valid])).call(read) }))
    assert.equal(value, '0x1234')
  } finally { invalid.stop(); valid.stop() }
})

test('all invalid RPC responses fail with a schema error instead of looping', async () => {
  let attempts = 0
  const invalid = server(() => historical, () => { attempts++; return 'not-hex' })
  try {
    const result = await run(Effect.gen(function* () { return yield* Effect.result((yield* make([invalid])).call(read)) }))
    assert.equal(result._tag, 'Failure')
    assert.equal(result.failure._tag, 'SchemaError')
    assert.equal(attempts, 1)
  } finally { invalid.stop() }
})

test('invalid RPC parameters fail without retrying', async () => {
  let attempts = 0
  const invalid = server(() => historical, () => { attempts++; return { error: { code: -32602, message: 'invalid params' } } })
  try {
    const result = await run(Effect.gen(function* () { return yield* Effect.result((yield* make([invalid])).call(read)) }))
    assert.equal(result._tag, 'Failure')
    assert.equal(result.failure.code, -32602)
    assert.equal(attempts, 1)
  } finally { invalid.stop() }
})

test('a provider limit can recover through another selected endpoint', async () => {
  const limited = server(() => historical, () => ({ error: { code: -32005, message: 'rate limit exceeded' } }))
  const available = server(() => historical, () => '0x1234')
  try {
    const value = await run(Effect.gen(function* () { return yield* (yield* make([limited, available])).call(read) }))
    assert.equal(value, '0x1234')
  } finally { limited.stop(); available.stop() }
})

test('one logical read has at most two active attempts and four attempts total', async () => {
  let active = 0, maximum = 0, attempts = 0
  const servers = Array.from({ length: 4 }, () => server(() => historical, async () => {
    active++; attempts++; maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 40))
    active--
    return { error: { code: -32001, message: 'unknown block' } }
  }))
  try {
    const result = await run(Effect.gen(function* () {
      const client = yield* make(servers)
      return yield* Effect.result(client.call({ ...read, block: { blockHash: head.hash, requireCanonical: true } }))
    }))
    assert.equal(result._tag, 'Failure')
    assert.equal(attempts, 4)
    assert.ok(maximum <= 2, `maximum simultaneous attempts: ${maximum}`)
  } finally { servers.forEach((s) => s.stop()) }
})

test('a read rotates to a healthy HTTP standby after selected endpoints fail', async () => {
  const failed = server(() => historical, () => ({ error: { code: -32001, message: 'unknown block' } }))
  const standby = server(() => historical, () => '0xbeef')
  try {
    const value = await run(Effect.gen(function* () {
      const client = yield* EvmClient.make({ endpoints: { http: [failed.url, standby.url], ws: [] },
        network: { chainId: 1n, blockTime: 12000 }, options: { concurrentHttp: 1, concurrentWs: 0, hedgeDelay: 10 } })
      return yield* client.call({ ...read, block: { blockHash: head.hash, requireCanonical: true } })
    }))
    assert.equal(value, '0xbeef')
  } finally { failed.stop(); standby.stop() }
})

test('unsupported methods are learned and are not sent to that endpoint again', async () => {
  let unsupportedCalls = 0
  const unsupported = server(() => historical, () => {
    unsupportedCalls++
    return { error: { code: -32601, message: 'method unsupported' } }
  })
  const supported = server(() => historical, () => '0xbeef')
  try {
    const result = await run(Effect.gen(function* () {
      const client = yield* make([unsupported, supported])
      yield* Effect.sleep(20)
      const first = yield* client.fetch({ method: 'eth_call', params: [{ to: read.transaction.to, data: '0x01' }, 'latest'] })
      const second = yield* client.fetch({ method: 'eth_call', params: [{ to: read.transaction.to, data: '0x02' }, 'latest'] })
      return { first, second, endpoints: yield* client.endpoints }
    }))
    assert.equal(result.first, '0xbeef')
    assert.equal(result.second, '0xbeef')
    assert.equal(unsupportedCalls, 1)
    assert.ok(result.endpoints.get(unsupported.url).unsupportedMethods.includes('eth_call'))
  } finally { unsupported.stop(); supported.stop() }
})

test('a rate-limited method prefers another endpoint after the short cooldown expires', async () => {
  let limitedCalls = 0
  const limited = server(() => historical, () => { limitedCalls++; return { error: { code: -32005, message: 'rate limit exceeded' } } })
  const healthy = server(() => historical, () => '0xbeef')
  try {
    await run(Effect.gen(function* () {
      const client = yield* make([limited, healthy])
      yield* Effect.sleep(20)
      assert.equal(yield* client.fetch({ method: 'eth_call', params: [{ to: read.transaction.to, data: '0x01' }, 'latest'] }), '0xbeef')
      yield* Effect.sleep(1100)
      assert.equal(yield* client.fetch({ method: 'eth_call', params: [{ to: read.transaction.to, data: '0x02' }, 'latest'] }), '0xbeef')
    }))
    assert.equal(limitedCalls, 1)
  } finally { limited.stop(); healthy.stop() }
})
