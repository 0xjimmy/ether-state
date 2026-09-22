import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Effect, Fiber, Scope } from 'effect'
import { MulticallReads, multicallAddress } from '../src/rpc/multicall.ts'
import { encodeAbiParameters, parseAbiParameters } from 'viem'

const request = '0x82ad56cb000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000418160ddd000000000000000000000000000000000000000000000000000000000000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000004313ce56700000000000000000000000000000000000000000000000000000000000000000000000000000000ca11bde05977b3631167028862be2a173976ca1100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000442cbb15c00000000000000000000000000000000000000000000000000000000'
const response = '0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000002111100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000322222200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000011'

test('multicall uses the fixed aggregate3 ABI without a runtime ABI library', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const transactions = []
    const reads = new MulticallReads({
      scope: yield* Scope.Scope, window: 0, size: 10, capacity: 20, maxCalldataBytes: 1_024,
      code: () => Effect.succeed('0x01'),
      fetch: transaction => Effect.sync(() => { transactions.push(transaction); return response }),
    })
    const results = yield* Effect.all([
      reads.request({ transaction: { to: `0x${'11'.repeat(20)}`, data: '0x18160ddd' }, block: 17n, blockNumber: 17n }),
      reads.request({ transaction: { to: `0x${'11'.repeat(20)}`, data: '0x18160ddd' }, block: 17n, blockNumber: 17n }),
      reads.request({ transaction: { to: `0x${'22'.repeat(20)}`, data: '0x313ce567' }, block: 17n, blockNumber: 17n }),
    ], { concurrency: 'unbounded' })
    assert.deepEqual(results, ['0x1111', '0x1111', '0x222222'])
    assert.deepEqual(transactions, [{ to: multicallAddress, data: request }])
    assert.equal(reads.stats.calls, 2)
  })))
})

test('duplicate multicall failures fan out without changing other results', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const failed = encodeAbiParameters(parseAbiParameters('(bool, bytes)[]'), [[
      [true, '0x1111'], [false, '0xdead'], [true, `0x${17n.toString(16).padStart(64, '0')}`],
    ]])
    const reads = new MulticallReads({
      scope: yield* Scope.Scope, window: 0, size: 10, capacity: 20, maxCalldataBytes: 1_024,
      code: () => Effect.succeed('0x01'), fetch: () => Effect.succeed(failed),
    })
    const first = { transaction: { to: `0x${'11'.repeat(20)}`, data: '0x18160ddd' }, block: 17n, blockNumber: 17n }
    const second = { transaction: { to: `0x${'22'.repeat(20)}`, data: '0x313ce567' }, block: 17n, blockNumber: 17n }
    const results = yield* Effect.all([reads.request(first), reads.request(second), reads.request(second)].map(Effect.result), { concurrency: 'unbounded' })
    assert.equal(results[0]._tag, 'Success')
    assert.deepEqual(results.slice(1).map(result => result.failure), [
      { _tag: 'ContractReverted', data: '0xdead' }, { _tag: 'ContractReverted', data: '0xdead' },
    ])
    assert.equal(reads.stats.calls, 2)
  })))
})

test('cancelling one duplicate multicall waiter preserves the remaining call', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const transactions = []
    const reads = new MulticallReads({
      scope: yield* Scope.Scope, window: 20, size: 10, capacity: 20, maxCalldataBytes: 1_024,
      code: () => Effect.succeed('0x01'),
      fetch: transaction => Effect.sync(() => { transactions.push(transaction); return response }),
    })
    const first = { transaction: { to: `0x${'11'.repeat(20)}`, data: '0x18160ddd' }, block: 17n, blockNumber: 17n }
    const second = { transaction: { to: `0x${'22'.repeat(20)}`, data: '0x313ce567' }, block: 17n, blockNumber: 17n }
    const cancelled = yield* reads.request(first).pipe(Effect.forkScoped)
    const survivor = yield* reads.request(first).pipe(Effect.forkScoped)
    const other = yield* reads.request(second).pipe(Effect.forkScoped)
    yield* Fiber.interrupt(cancelled)
    assert.deepEqual(yield* Effect.all([Fiber.join(survivor), Fiber.join(other)]), ['0x1111', '0x222222'])
    assert.deepEqual(transactions, [{ to: multicallAddress, data: request }])
  })))
})
