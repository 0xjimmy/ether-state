import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Cause, Deferred, Effect, Exit, Fiber, SubscriptionRef } from 'effect'
import { makeLifetime } from '../src/internal/lifetime.ts'
import { EvmClient } from '../src/rpc/client.ts'
import { RpcDeadline, RpcPriority } from '../src/rpc/priority.ts'

const raw = '0x1234'
const hash = `0x${'12'.repeat(32)}`
const rejected = { _tag: 'RpcError', code: -32000, message: 'Rejected' }
const make = Effect.fnUntraced(function* (requestAt, endpoints) {
  const client = Object.create(EvmClient.prototype)
  client.lifetime = yield* makeLifetime
  client.options = { requestTimeout: 1000 }
  client.endpointState = yield* SubscriptionRef.make(new Map(endpoints.map(([endpoint, status = 'Selected']) =>
    [endpoint, { endpoint, transport: 'http', status: { _tag: status }, observations: [] }])))
  client.requestAt = requestAt
  return client
})
const run = effect => Effect.runPromise(Effect.scoped(effect).pipe(Effect.timeout('2 seconds')))

test('broadcast returns the first acceptance and lets slower sends finish after the caller scope ends', async () => {
  await run(Effect.gen(function* () {
    const accept = yield* Deferred.make(), slow = yield* Deferred.make(), slowStarted = yield* Deferred.make(), firstFailed = yield* Deferred.make(), finished = yield* Deferred.make()
    const calls = []
    let interrupted = 0
    const client = yield* make((source, request) => Effect.gen(function* () {
      calls.push({ endpoint: source.endpoint, request, priority: yield* RpcPriority, deadline: yield* RpcDeadline })
      if (source.endpoint === 'reject') { yield* Deferred.succeed(firstFailed, undefined); return yield* Effect.fail(rejected) }
      if (source.endpoint === 'accept') { yield* Deferred.await(accept); return hash }
      yield* Deferred.succeed(slowStarted, undefined)
      return yield* Deferred.await(slow).pipe(Effect.andThen(Effect.fail(rejected)),
        Effect.onInterrupt(() => Effect.sync(() => interrupted++)), Effect.ensuring(Deferred.succeed(finished, undefined)))
    }), [['reject'], ['accept'], ['slow'], ['standby', 'Standby']])
    const pending = yield* Effect.scoped(client.sendRawTransaction(raw)).pipe(Effect.forkScoped)
    yield* Deferred.await(firstFailed)
    assert.equal(pending.pollUnsafe(), undefined)
    yield* Deferred.succeed(accept, undefined)
    assert.equal(yield* Fiber.join(pending), hash)
    yield* Deferred.await(slowStarted)
    assert.deepEqual(calls.map(call => call.endpoint).sort(), ['accept', 'reject', 'slow'])
    assert.ok(calls.every(call => call.request.method === 'eth_sendRawTransaction' && call.request.params[0] === raw && call.priority === 'action'))
    assert.equal(new Set(calls.map(call => call.deadline)).size, 1)
    assert.ok(Number.isFinite(calls[0].deadline))
    assert.equal(yield* Deferred.isDone(finished), false)
    assert.equal(interrupted, 0)
    yield* Deferred.succeed(slow, undefined)
    yield* Deferred.await(finished)
    assert.equal(interrupted, 0)
  }))
})

test('broadcast fails only after every selected endpoint fails', async () => {
  await run(Effect.gen(function* () {
    const last = yield* Deferred.make(), firstFailed = yield* Deferred.make()
    const client = yield* make(source => source.endpoint === 'last' ? Deferred.await(last).pipe(Effect.andThen(Effect.fail(rejected)))
      : Deferred.succeed(firstFailed, undefined).pipe(Effect.andThen(Effect.fail(rejected))), [['first'], ['last']])
    const pending = yield* client.sendRawTransaction(raw).pipe(Effect.forkScoped)
    yield* Deferred.await(firstFailed)
    assert.equal(pending.pollUnsafe(), undefined)
    yield* Deferred.succeed(last, undefined)
    const exit = yield* Fiber.await(pending)
    assert.ok(Exit.isFailure(exit))
    assert.deepEqual(Cause.squash(exit.cause), { _tag: 'BlockUnavailable' })
  }))
})

test('client close interrupts sends that remain after the first acceptance', async () => {
  await run(Effect.gen(function* () {
    const started = yield* Deferred.make(), interrupted = yield* Deferred.make()
    const client = yield* make(source => source.endpoint === 'accept' ? Effect.succeed(hash)
      : Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))), [['accept'], ['pending']])
    assert.equal(yield* client.sendRawTransaction(raw), hash)
    yield* Deferred.await(started)
    yield* client.close()
    assert.equal(yield* Deferred.isDone(interrupted), true)
    const closed = yield* Effect.exit(client.sendRawTransaction(raw))
    assert.ok(Exit.isFailure(closed) && Cause.hasInterruptsOnly(closed.cause))
  }))
})

test('client close interrupts a broadcast before any acceptance', async () => {
  await run(Effect.gen(function* () {
    const started = yield* Deferred.make()
    let running = 0
    const client = yield* make(() => Effect.gen(function* () {
      if (++running === 2) yield* Deferred.succeed(started, undefined)
      yield* Effect.never
    }).pipe(Effect.ensuring(Effect.sync(() => running--))), [['first'], ['second']])
    const pending = yield* client.sendRawTransaction(raw).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    yield* client.close()
    const exit = yield* Fiber.await(pending)
    assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
    assert.equal(running, 0)
  }))
})

test('an empty selected endpoint set and invalid input never dispatch', async () => {
  await run(Effect.gen(function* () {
    let calls = 0
    const client = yield* make(() => Effect.sync(() => { calls++; return hash }), [['standby', 'Standby']])
    const empty = yield* Effect.exit(client.sendRawTransaction(raw))
    assert.ok(Exit.isFailure(empty))
    assert.deepEqual(Cause.squash(empty.cause), { _tag: 'BlockUnavailable' })
    const invalid = yield* Effect.exit(client.sendRawTransaction('invalid'))
    assert.ok(Exit.isFailure(invalid))
    assert.equal(calls, 0)
  }))
})
