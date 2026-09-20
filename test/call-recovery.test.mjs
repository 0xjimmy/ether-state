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
const server = (onHash, onCall = () => '0x1234', onOther = () => null) => {
  const requests = []
  const instance = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json()
    const reply = async (item) => {
      requests.push(item)
      const value = item.method === 'eth_chainId' ? '0x1'
        : item.method === 'eth_getBlockByNumber' ? head
          : item.method === 'eth_getBlockByHash' ? await onHash(item)
            : item.method === 'eth_call' ? await onCall(item) : await onOther(item)
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

test('historical capability errors rotate upstreams without disabling current reads', async () => {
  const limited = server(() => historical, (item) => item.params[1].blockHash === historical.hash
    ? { error: { code: -32000, message: 'unsupported block number 9' } } : '0x5678')
  const archive = server(() => historical)
  try {
    await run(Effect.gen(function* () {
      const client = yield* make([limited, archive])
      assert.equal(yield* client.call(read), '0x1234')
      const endpoint = (yield* client.endpoints).get(limited.url)
      assert.equal(endpoint.unsupportedMethods?.includes('eth_call') ?? false, false)
    }))
    assert.ok(archive.requests.some((request) => request.method === 'eth_call'))
  } finally { limited.stop(); archive.stop() }
})

test('log range limits are distinct from rate limits and archive errors', async () => {
  const { isLogRangeLimit, readFailurePolicy } = await import('../src/index.ts')
  assert.equal(isLogRangeLimit({ _tag: 'RpcError', code: -32005, message: 'block range exceeds maximum allowed range' }), true)
  assert.equal(isLogRangeLimit({ _tag: 'RpcError', code: -32005, message: 'rate limit exceeded' }), false)
  assert.equal(isLogRangeLimit({ _tag: 'RpcError', code: -32000, message: 'unsupported block number 123' }), false)
  assert.equal(readFailurePolicy({ _tag: 'RpcError', code: -32000, message: 'unsupported block number 123' }), 'rotate')
})


test('unfiltered log capability failures do not disable filtered historical ranges', async () => {
  const rpc = server(() => historical, undefined, (item) => item.method === 'eth_getLogs'
    ? item.params[0].address ? [] : { error: { code: -32000, message: 'Please specify an address' } } : null)
  try {
    await run(Effect.gen(function* () {
      const client = yield* make([rpc])
      const failure = yield* Effect.result(client.fetchOne({ method: 'eth_getLogs', params: [{ fromBlock: 1n, toBlock: 2n }] }))
      assert.equal(failure._tag, 'Failure')
      assert.deepEqual(yield* client.fetchOne({ method: 'eth_getLogs', params: [{ address: read.transaction.to, fromBlock: 1n, toBlock: 2n }] }), [])
    }))
    assert.equal(rpc.requests.filter(request => request.method === 'eth_getLogs' && request.params[0].address).length, 1)
  } finally { rpc.stop() }
})

test('client close cancels requests and streams, blocks new reads, and leaves another client usable', async () => {
  const { Fiber, Stream } = await import('effect')
  const rpc = server(() => historical, async () => { await new Promise(resolve => setTimeout(resolve, 300)); return '0x1234' })
  try {
    await run(Effect.gen(function* () {
      const client = yield* make([rpc])
      const other = yield* make([rpc])
      const watcher = yield* client.watchBlocks().pipe(Stream.runDrain, Effect.forkScoped)
      const pending = yield* client.call(read).pipe(Effect.forkScoped)
      yield* Effect.sleep(30)
      yield* Effect.all([client.close(), client.close()], { concurrency: 'unbounded' })
      assert.equal(client.isClosed, true)
      assert.equal((yield* Fiber.await(pending))._tag, 'Failure')
      yield* Fiber.join(watcher)
      const requests = rpc.requests.length
      assert.equal((yield* Effect.exit(client.getBlock()))._tag, 'Failure')
      assert.equal((yield* Effect.exit(client.call(read)))._tag, 'Failure')
      assert.equal((yield* Effect.exit(client.fetchOne({ method: 'eth_chainId', params: [] })))._tag, 'Failure')
      assert.equal((yield* client.watchBlocks().pipe(Stream.runCollect)).length, 0)
      assert.equal(rpc.requests.length, requests)
      assert.equal(yield* other.fetchOne({ method: 'eth_chainId', params: [] }), 1n)
    }))
  } finally { rpc.stop() }
})

test('explicit close and scope exit both close owned WebSocket connections', async () => {
  const sockets = new Set()
  const rpc = Bun.serve({ port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response('', { status: 400 }) },
    websocket: {
      open(ws) { sockets.add(ws) },
      close(ws) { sockets.delete(ws) },
      message(ws, raw) {
        const item = JSON.parse(String(raw))
        const result = item.method === 'eth_chainId' ? '0x1' : item.method === 'eth_subscribe' ? '0x123' : item.method === 'eth_unsubscribe' ? true : head
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: item.id, result }))
      },
    },
  })
  const config = { endpoints: { http: [], ws: [`ws://127.0.0.1:${rpc.port}`] }, network: { chainId: 1n, blockTime: 12000 }, options: { concurrentHttp: 0, concurrentWs: 1 } }
  let automatic
  try {
    await run(Effect.gen(function* () {
      const client = yield* EvmClient.make(config)
      assert.ok(sockets.size > 0)
      yield* client.close()
      for (let i = 0; i < 100 && sockets.size > 0; i++) yield* Effect.sleep(5)
      assert.equal(sockets.size, 0)
      automatic = yield* EvmClient.make(config)
      assert.ok(sockets.size > 0)
    }))
    for (let i = 0; i < 100 && sockets.size > 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(automatic.isClosed, true)
    assert.equal(sockets.size, 0)
  } finally { rpc.stop(true) }
})

test('watchState work stops with either its caller scope or its client', async () => {
  const { Scope, Exit } = await import('effect')
  const rpc = server(() => head)
  try {
    await run(Effect.gen(function* () {
      const client = yield* make([rpc])
      for (const closeClient of [false, true]) {
        const owner = yield* Scope.make()
        let entered = false
        let stopped = false
        yield* client.watchState({ transaction: read.transaction, multicall: false,
          decode: () => Effect.sync(() => { entered = true }).pipe(Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => { stopped = true }))),
        }).pipe(Scope.provide(owner))
        for (let i = 0; i < 100 && !entered; i++) yield* Effect.sleep(5)
        assert.equal(entered, true)
        if (closeClient) yield* client.close()
        else yield* Scope.close(owner, Exit.void)
        assert.equal(stopped, true)
        assert.equal(client.isClosed, closeClient)
        yield* Scope.close(owner, Exit.void)
      }
    }))
  } finally { rpc.stop() }
})

test('an endpoint HTTP 403 rotates to a healthy peer and lowers that method priority', async () => {
 let denied = 0
 const blocked = Bun.serve({ port: 0, async fetch(request) {
  const body = await request.json()
  const items = Array.isArray(body) ? body : [body]
  if (items.some(item => !['eth_chainId', 'eth_getBlockByNumber'].includes(item.method))) {
   denied++
   return new Response('Forbidden', { status: 403 })
  }
  const replies = items.map(item => ({ jsonrpc: '2.0', id: item.id, result: item.method === 'eth_chainId' ? '0x1' : head }))
  return Response.json(Array.isArray(body) ? replies : replies[0])
 } })
 const healthy = server(() => historical, () => '0x1234', async () => { await new Promise(resolve => setTimeout(resolve, 30)); return '0x1' })
 try {
  await run(Effect.gen(function* () {
   const client = yield* make([{ url: `http://127.0.0.1:${blocked.port}` }, healthy])
   for (const address of ['11', '22']) assert.equal(yield* client.fetchOne({ method: 'eth_getBalance', params: [`0x${address.repeat(20)}`, 'latest'] }), 1n)
   assert.equal(denied, 1)
  }))
 } finally { blocked.stop(true); healthy.stop() }
})

test('all upstream HTTP status and response decoding failures try another endpoint', async () => {
 for (const status of [400, 401, 402, 404, 405, 408, 413, 422, 429, 500, 503, 200]) {
  const bad = Bun.serve({ port: 0, async fetch(request) {
   const body = await request.json()
   const items = Array.isArray(body) ? body : [body]
   if (items.some(item => !['eth_chainId', 'eth_getBlockByNumber'].includes(item.method))) return new Response('not JSON', { status })
   const replies = items.map(item => ({ jsonrpc: '2.0', id: item.id, result: item.method === 'eth_chainId' ? '0x1' : head }))
   return Response.json(Array.isArray(body) ? replies : replies[0])
  } })
  const good = server(() => historical, () => '0x1234', () => '0x1')
  try {
   await run(Effect.gen(function* () {
    const client = yield* make([{ url: `http://127.0.0.1:${bad.port}` }, good])
    assert.equal(yield* client.fetchOne({ method: 'eth_getBalance', params: [`0x${'11'.repeat(20)}`, 'latest'] }), 1n, `HTTP ${status}`)
   }))
  } finally { bad.stop(true); good.stop() }
 }
})

test('remote parameter rejection and unknown provider errors rotate before failing a read', async () => {
 for (const code of [-32602, -32603, -32000]) {
  const bad = server(() => historical, () => ({ error: { code, message: 'provider rejected this request' } }))
  const good = server(() => historical, () => '0x1234')
  try {
   assert.equal(await run(Effect.gen(function* () { return yield* (yield* make([bad, good])).call(read) })), '0x1234')
  } finally { bad.stop(); good.stop() }
 }
})

test('a verified sixth endpoint is tried before the logical read fails', async () => {
 let attempts = 0
 const bad = Array.from({ length: 5 }, () => server(() => historical, () => { attempts++; return { error: { code: -32000, message: 'provider failure' } } }))
 const good = server(() => historical, () => { attempts++; return '0x1234' })
 const peers = [...bad, good]
 try {
  assert.equal(await run(Effect.gen(function* () { return yield* (yield* make(peers)).call(read) })), '0x1234')
  assert.ok(attempts >= 5 && attempts <= 6)
 } finally { peers.forEach(peer => peer.stop()) }
})

test('invalid local request parameters do not reach an upstream', async () => {
 const rpc = server(() => historical)
 try {
  await run(Effect.gen(function* () {
   const client = yield* make([rpc])
   const before = rpc.requests.length
   const result = yield* Effect.result(client.fetchOne({ method: 'eth_getBalance', params: ['not-an-address', 'latest'] }))
   assert.equal(result._tag, 'Failure')
   assert.equal(result.failure._tag, 'SchemaError')
   assert.equal(rpc.requests.length, before)
  }))
 } finally { rpc.stop() }
})

test('a temporary RPC internal error retries when there is only one upstream', async () => {
 let attempts = 0
 const rpc = server(() => historical, () => ++attempts === 1 ? { error: { code: -32603, message: 'internal error' } } : '0x1234')
 try {
  assert.equal(await run(Effect.gen(function* () { return yield* (yield* make([rpc])).call(read) })), '0x1234')
  assert.equal(attempts, 2)
 } finally { rpc.stop() }
})
