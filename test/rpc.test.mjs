import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Effect, Exit, Schema, Scope } from 'effect'
import * as api from '../src/index.ts'
import { BatchQueue } from '../src/rpc/transport/queue.ts'
import { matchesLog } from '../src/rpc/watch.ts'
import { getRpcMethod } from '../src/rpc/schema.ts'
import { smoke } from './runtime-smoke.mjs'

test('package exports only the current runtime API', async () => {
  assert.equal(await smoke(api), 'ok')
})

test('batch queue collects reads and preserves per-item failures', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let batches = 0
    const queue = new BatchQueue({ scope: yield* Scope.Scope, window: 0, size: 10, capacity: 20,
      run: inputs => Effect.sync(() => { batches++; return inputs.map(value => value < 0 ? Exit.fail('negative') : Exit.succeed(value * 2)) }) })
    const results = yield* Effect.all([1, -1, 3].map(value => Effect.exit(queue.request(value))), { concurrency: 'unbounded' })
    assert.equal(batches, 1)
    assert.equal(results[0].value, 2)
    assert.ok(Exit.isFailure(results[1]))
    assert.equal(results[2].value, 6)
    assert.equal(queue.size, 0)
  })))
})

test('batch queue flushes as soon as its item limit is full', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const batches = []
    const queue = new BatchQueue({ scope: yield* Scope.Scope, window: 10_000, size: 2, capacity: 20,
      run: inputs => Effect.sync(() => { batches.push([...inputs]); return inputs.map(Exit.succeed) }) })
    const result = yield* Effect.all([queue.request(1), queue.request(2)], { concurrency: 'unbounded' }).pipe(Effect.timeout('500 millis'))
    assert.deepEqual(result, [1, 2])
    assert.deepEqual(batches, [[1, 2]])
  })))
})

test('batch queue limits each batch by weight', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const batches = []
    const queue = new BatchQueue({ scope: yield* Scope.Scope, window: 1, size: 10, maxWeight: 3,
      weight: value => value.length, capacity: 20,
      run: inputs => Effect.sync(() => { batches.push([...inputs]); return inputs.map(Exit.succeed) }) })
    yield* Effect.all(['aa', 'bb', 'c'].map(value => queue.request(value)), { concurrency: 'unbounded' })
    assert.deepEqual(batches, [['aa'], ['bb', 'c']])
  })))
})

test('log filters support address sets and positional topic alternatives', () => {
  const log = { address: '0xabc', topics: ['0x01', '0x02'] }
  assert.ok(matchesLog(log, { address: ['0xABC'], topics: ['0x01', ['0x03', '0x02']] }))
  assert.ok(matchesLog(log, { topics: [null, '0x02'] }))
  assert.equal(matchesLog(log, { topics: ['0x02'] }), false)
})

test('RPC schemas encode bigint quantities and hash-pinned reads', async () => {
  const request = await Effect.runPromise(Schema.encodeEffect(getRpcMethod('eth_getBalance').request)({
    jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: ['0x' + '00'.repeat(20), { blockNumber: 42n }],
  }))
  assert.deepEqual(request.params[1], { blockNumber: '0x2a' })
})

test('HTTP batches learn a provider item limit and split future batches', async () => {
  const { HttpBatcher } = await import('../src/rpc/transport/http.ts')
  const { HttpClient, FetchHttpClient } = await import('effect/unstable/http')
  const { Scope } = await import('effect')
  const sizes = []
  const server = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json()
    const items = Array.isArray(body) ? body : [body]
    sizes.push(items.length)
    if (items.length > 2) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32014, message: 'maximum 2 calls in 1 batch' } })
    const results = items.map((item) => ({ jsonrpc: '2.0', id: item.id, result: '0x1' }))
    return Response.json(Array.isArray(body) ? results : results[0])
  } })
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const batch = new HttpBatcher({ endpoint: `http://127.0.0.1:${server.port}`, client: yield* HttpClient.HttpClient,
        scope: yield* Scope.Scope, window: 5, size: 4, maxBytes: 10000, capacity: 20, timeout: 1000 })
      for (let round = 0; round < 2; round++) {
        const values = yield* Effect.all(Array.from({ length: 4 }, () => batch.request({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [] })), { concurrency: 'unbounded' })
        assert.ok(values.every((value) => value.result === '0x1'))
      }
    })).pipe(Effect.provide(FetchHttpClient.layer)))
    assert.equal(sizes.filter((size) => size > 2).length, 1)
    assert.ok(sizes.slice(1).every((size) => size <= 2))
  } finally { server.stop(true) }
})
