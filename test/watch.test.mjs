import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Effect, Stream } from 'effect'
import { EvmClient } from '../src/index.ts'
import { callChanges, makeWatchedState } from '../src/rpc/watch.ts'

const head = (hash) => ({ number: 10n, hash, parentHash: 'parent', timestamp: 1n, logsBloom: '0x00', observedAt: 1000 })

test('watched calls pin competing heads at the same height to their hashes', async () => {
  const reads = []
  const client = {
    watchBlocks: () => Stream.fromIterable([head(null), head('original'), head('replacement')]).pipe(Stream.mapEffect((value) => Effect.sleep(5).pipe(Effect.as(value)))),
    call: (read) => Effect.sync(() => { reads.push(read.block); return read.block.blockHash }),
  }
  const values = await Effect.runPromise(callChanges(client, { transaction: {}, decode: Effect.succeed }).pipe(Stream.runCollect))
  assert.deepEqual(reads, [
    { blockHash: 'original', requireCanonical: true },
    { blockHash: 'replacement', requireCanonical: true },
  ])
  assert.deepEqual(values.map((entry) => entry.value), ['original', 'replacement'])
})

test('watched state pins the call to its reported head', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const client = {
      watchBlocks: () => Stream.make(head('original')),
      call: (read) => Effect.sync(() => {
        assert.deepEqual(read.block, { blockHash: 'original', requireCanonical: true })
        return '0x'
      }),
    }
    const state = yield* makeWatchedState(client, { transaction: {}, decode: Effect.succeed })
    const result = yield* state.changes.pipe(Stream.filter((entry) => entry._tag === 'Ready'), Stream.take(1), Stream.runCollect)
    assert.equal(result[0].current.block.hash, 'original')
  })).pipe(Effect.timeout('1 second')))
})

test('log consumers share upstream blocks and batches retain empty matches', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let fetches = 0
    const log = { address: '0xabc', topics: ['0x01'], transactionHash: 'tx' }
    const receiptBlocks = yield* Stream.fromEffect(Effect.sync(() => {
      fetches++
      return { ...head('hash'), block: head('hash'), logs: [log] }
    })).pipe(Stream.share({ capacity: 16, replay: 1 }))
    const client = Object.create(EvmClient.prototype)
    client.logBlocks = receiptBlocks
    const [all, matched, empty] = yield* Effect.all([
      client.watchLogs().pipe(Stream.take(1), Stream.runCollect),
      client.watchLogBlocks({ address: '0xABC', topics: ['0x01'] }).pipe(Stream.take(1), Stream.runCollect),
      client.watchLogBlocks({ address: '0xdef' }).pipe(Stream.take(1), Stream.runCollect),
    ], { concurrency: 'unbounded' })
    assert.equal(fetches, 1)
    assert.deepEqual(all, [log])
    assert.deepEqual(matched[0].logs, [log])
    assert.deepEqual(empty[0].logs, [])
    assert.equal(empty[0].block.hash, 'hash')
  })).pipe(Effect.timeout('1 second')))
})

test('call watches recover on the latest head after a transient outage', async () => {
  let subscriptions = 0
  let attempts = 0
  const client = {
    watchBlocks: () => Stream.suspend(() => Stream.make(head(++subscriptions === 1 ? 'old' : 'new'))),
    call: (read) => Effect.suspend(() => {
      attempts++
      return read.block.blockHash === 'old' ? Effect.fail({ _tag: 'BlockUnavailable' }) : Effect.succeed('recovered')
    }),
  }
  const values = await Effect.runPromise(callChanges(client, { transaction: {}, decode: Effect.succeed }).pipe(
    Stream.take(1), Stream.runCollect, Effect.timeout('2 seconds')))
  assert.equal(attempts, 2)
  assert.equal(values[0].block.hash, 'new')
  assert.equal(values[0].value, 'recovered')
})

test('call watches do not retry contract reverts', async () => {
  let attempts = 0
  const client = {
    watchBlocks: () => Stream.make(head('hash')),
    call: () => Effect.suspend(() => { attempts++; return Effect.fail({ _tag: 'ContractReverted', data: '0x' }) }),
  }
  const result = await Effect.runPromise(callChanges(client, { transaction: {}, decode: Effect.succeed }).pipe(Stream.runCollect, Effect.result))
  assert.equal(result._tag, 'Failure')
  assert.equal(result.failure._tag, 'ContractReverted')
  assert.equal(attempts, 1)
})

test('watched state reports retrying then ready without caller intervention', async () => {
  let attempts = 0
  const client = {
    watchBlocks: () => Stream.make(head('hash')),
    call: () => Effect.suspend(() => ++attempts === 1 ? Effect.fail({ _tag: 'BlockUnavailable' }) : Effect.succeed('ok')),
  }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const state = yield* makeWatchedState(client, { transaction: {}, decode: Effect.succeed })
    const states = yield* state.changes.pipe(Stream.filter((s) => s._tag !== 'Loading'), Stream.take(2), Stream.runCollect)
    assert.deepEqual(states.map((s) => s._tag), ['Retrying', 'Ready'])
  })).pipe(Effect.timeout('2 seconds')))
})

test('watched state reports permanent errors as failed', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const client = { watchBlocks: () => Stream.make(head('hash')), call: () => Effect.fail({ _tag: 'ContractReverted', data: '0x' }) }
    const state = yield* makeWatchedState(client, { transaction: {}, decode: Effect.succeed })
    const states = yield* state.changes.pipe(Stream.filter((s) => s._tag !== 'Loading'), Stream.take(1), Stream.runCollect)
    assert.equal(states[0]._tag, 'Failed')
  })).pipe(Effect.timeout('1 second')))
})

test('slow watched calls coalesce pending heads without cancelling the active read', async () => {
  const reads = []
  const client = {
    watchBlocks: () => Stream.fromIterable(Array.from({ length: 20 }, (_, i) => ({ ...head(`hash-${i}`), number: BigInt(i) }))).pipe(
      Stream.mapEffect((value) => Effect.sleep(5).pipe(Effect.as(value)))),
    call: (read) => Effect.sleep(30).pipe(Effect.andThen(Effect.sync(() => {
      reads.push(read.block.blockHash)
      return read.block.blockHash
    }))),
  }
  const values = await Effect.runPromise(callChanges(client, { transaction: {}, decode: Effect.succeed }).pipe(Stream.runCollect))
  assert.equal(values.at(-1).block.number, 19n)
  assert.ok(reads.length < 10)
  assert.ok(reads.length >= 3)
})

test('a latest-state watch advances after an endpoint prunes the previous block state', async () => {
  let subscriptions = 0
  const client = {
    watchBlocks: () => Stream.suspend(() => Stream.make(head(++subscriptions === 1 ? 'old' : 'new'))),
    call: (read) => read.block.blockHash === 'old'
      ? Effect.fail({ _tag: 'RpcError', code: -32000, message: 'historical state old is not available' })
      : Effect.succeed('current'),
  }
  const values = await Effect.runPromise(callChanges(client, { transaction: {}, decode: Effect.succeed }).pipe(
    Stream.take(1), Stream.runCollect, Effect.timeout('2 seconds')))
  assert.equal(values[0].block.hash, 'new')
})
