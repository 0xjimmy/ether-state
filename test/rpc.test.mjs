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
    const queue = new BatchQueue({ scope: yield* Scope.Scope, window: 5, size: 10, capacity: 20,
      run: inputs => Effect.sync(() => { batches++; return inputs.map(value => value < 0 ? Exit.fail('negative') : Exit.succeed(value * 2)) }) })
    const results = yield* Effect.all([1, -1, 3].map(value => Effect.exit(queue.request(value))), { concurrency: 'unbounded' })
    assert.equal(batches, 1)
    assert.equal(results[0].value, 2)
    assert.ok(Exit.isFailure(results[1]))
    assert.equal(results[2].value, 6)
    assert.equal(queue.size, 0)
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
