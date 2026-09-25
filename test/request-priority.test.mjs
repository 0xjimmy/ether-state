import { test, expect } from 'bun:test'
import { Deferred, Effect, Fiber, Scope, Stream, SubscriptionRef } from 'effect'
import { RequestScheduler } from '../src/rpc/transport/queue.ts'
import { RpcPriority } from '../src/rpc/priority.ts'
import { MulticallReads, multicallAddress } from '../src/rpc/multicall.ts'
import { RpcHistory } from '../src/rpc/history.ts'
import { EvmClient } from '../src/rpc/client.ts'

const timeout = { _tag: 'EndpointRequestTimeout', endpoint: 'request-budget', transport: 'http', method: 'eth_call' }

test('background load across endpoints leaves live capacity and cancellation releases admission', async () => {
  const scheduler = new RequestScheduler({ rps: 100, concurrency: 4, capacity: 20 })
  let active = 0, maximum = 0
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const gate = yield* Deferred.make()
    const jobs = []
    for (let i = 0; i < 12; i++) jobs.push(yield* scheduler.run(`endpoint-${i % 2}`, 'background', Effect.sync(() => { maximum = Math.max(maximum, ++active) }).pipe(Effect.andThen(Deferred.await(gate)), Effect.ensuring(Effect.sync(() => active--)))).pipe(Effect.forkScoped))
    yield* Effect.sleep(20)
    const start = Date.now()
    yield* scheduler.run('endpoint-0', 'live', Effect.void).pipe(Effect.timeout(200))
    expect(Date.now() - start).toBeLessThan(200)
    expect(maximum).toBe(3)
    yield* Effect.forEach(jobs, Fiber.interrupt)
    yield* scheduler.run('endpoint-0', 'background', Effect.void).pipe(Effect.timeout(200))
  })))
  expect(active).toBe(0)
})

test('background rate limit leaves request tokens for live calls', async () => {
  const scheduler = new RequestScheduler({ rps: 5, concurrency: 10, capacity: 30 })
  let completed = 0
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    for (let i = 0; i < 10; i++) yield* scheduler.run('endpoint', 'background', Effect.sync(() => completed++)).pipe(Effect.forkScoped)
    yield* Effect.sleep(20)
    expect(completed).toBe(4)
    yield* scheduler.run('endpoint', 'action', Effect.void).pipe(Effect.timeout(200))
  })))
})

test('a timed out multicall does not fan out; live calls do not join a blocked background batch', async () => {
  let aggregates = 0, singles = 0
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const reads = new MulticallReads({ scope: yield* Scope.Scope, window: 0, size: 64, capacity: 128, maxCalldataBytes: 8192,
      code: () => Effect.succeed('0x01'), fetch: tx => Effect.gen(function* () {
        if (tx.to === multicallAddress) { aggregates++; return yield* Effect.fail(timeout) }
        singles++; return '0x01'
      }),
    })
    const results = yield* Effect.all(Array.from({ length: 64 }, (_, i) => reads.request({ transaction: { to: '0x' + (i + 1).toString(16).padStart(40, '0'), data: '0x12345678' }, block: 17n, blockNumber: 17n }).pipe(Effect.result)), { concurrency: 'unbounded' })
    expect(results.every(result => result._tag === 'Failure')).toBe(true)
    expect(aggregates).toBe(1); expect(singles).toBe(0)
    const gate = yield* Deferred.make()
    const isolated = new MulticallReads({ scope: yield* Scope.Scope, window: 0, size: 64, capacity: 128, maxCalldataBytes: 8192,
      code: () => Effect.succeed('0x01'), fetch: () => Effect.flatMap(RpcPriority, priority => priority === 'background' ? Deferred.await(gate) : Effect.succeed('live')) })
    const read = { transaction: { to: '0x' + '11'.repeat(20), data: '0x12345678' }, block: 17n, blockNumber: 17n }
    yield* isolated.request(read).pipe(Effect.provideService(RpcPriority, 'background'), Effect.forkScoped)
    yield* Effect.sleep(10)
    expect(yield* isolated.request(read).pipe(Effect.timeout(200))).toBe('live')
  })))
})

test('request budget timeouts never split historical log ranges', async () => {
  const ranges = []
  const history = new RpcHistory({ fetchOne: request => Effect.sync(() => ranges.push(request.params[0])).pipe(Effect.andThen(Effect.fail(timeout))) })
  await Effect.runPromise(history.getLogs({ fromBlock: 1n, toBlock: 100n }).pipe(Effect.result))
  expect(ranges.length).toBe(3)
  expect(ranges.every(range => range.fromBlock === 1n && range.toBlock === 100n)).toBe(true)
})


test('cancelling every batch waiter cancels upstream work without cancelling the next batch', async () => {
  let active = 0
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const reads = new MulticallReads({ scope: yield* Scope.Scope, window: 0, size: 2, capacity: 16, maxCalldataBytes: 8192,
      code: () => Effect.succeed('0x01'), fetch: tx => tx.data === '0x02' ? Effect.succeed('done') : Effect.sync(() => { active++ }).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { active-- }))) })
    const input = data => ({ transaction: { to: '0x' + '11'.repeat(20), data }, block: 17n, blockNumber: 17n })
    const first = yield* reads.request(input('0x01')).pipe(Effect.forkScoped)
    yield* Effect.sleep(10)
    expect(active).toBe(1)
    yield* Fiber.interrupt(first)
    expect(yield* reads.request(input('0x02')).pipe(Effect.timeout(200))).toBe('done')
    expect(active).toBe(0)
  })))
})



test('nested RPC stages share one deadline instead of restarting the timeout', async () => {
  const client = Object.create(EvmClient.prototype)
  client.options = { requestTimeout: 80 }
  let cancelled = 0
  const started = Date.now()
  const result = await Effect.runPromise(client.budget('eth_call', Effect.sleep(50).pipe(
    Effect.andThen(client.budget('eth_getBlockByHash', Effect.sleep(60).pipe(
      Effect.ensuring(Effect.sync(() => { cancelled++ }))))),
  )).pipe(Effect.result))
  expect(result._tag).toBe('Failure')
  expect(Date.now() - started).toBeLessThan(110)
  expect(cancelled).toBe(1)
})
