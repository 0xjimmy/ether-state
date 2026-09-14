import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Effect, Exit, Stream } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { Socket } from 'effect/unstable/socket'
import { EvmClient, getRpcEndpoints, getExplorers } from '../src/index.ts'

const endpoint = process.env.RPC_HTTP_URL ?? 'https://ethereum-rpc.publicnode.com'
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const run = program => Effect.runPromise(Effect.scoped(program).pipe(
  Effect.provide(FetchHttpClient.layer), Effect.provide(Socket.layerWebSocketConstructorGlobal), Effect.timeout(110000)))

test('live RPC: batching, multicall, historical streams and shared watches', async () => {
  await run(Effect.gen(function* () {
    const endpoints = yield* getRpcEndpoints(1n)
    assert.ok(endpoints.http.length > 0)
    assert.ok((yield* getExplorers(1n)).length > 0)
    const client = yield* EvmClient.make({ endpoints: { http: [endpoint], ws: [] }, network: { chainId: 1n, blockTime: 12000 } })
    const head = yield* client.getBlock()
    const number = head.number - 8n
    const balances = yield* Effect.all([0, 1, 2].map(i => client.fetch({ method: 'eth_getBalance', params: ['0x' + i.toString(16).padStart(40, '0'), number] })), { concurrency: 'unbounded' })
    assert.ok(balances.every(value => typeof value === 'bigint'))
    assert.ok(client.metrics.http.some(stats => stats.batches > 0 && stats.requests > stats.envelopes))
    const calls = ['0x18160ddd', '0x313ce567'].map(data => ({ transaction: { to: usdc, data }, block: number }))
    const combined = yield* Effect.all(calls.map(call => client.call(call)), { concurrency: 'unbounded' })
    const direct = yield* Effect.all(calls.map(call => client.call({ ...call, multicall: false })), { concurrency: 'unbounded' })
    assert.deepEqual(combined, direct)
    assert.ok(client.metrics.multicall.batches > 0)
    const mixed = yield* Effect.all([calls[0], { transaction: { to: usdc, data: '0xffffffff' }, block: number }].map(call => Effect.exit(client.call(call))), { concurrency: 'unbounded' })
    assert.ok(Exit.isSuccess(mixed[0]))
    assert.ok(Exit.isFailure(mixed[1]))
    const range = { fromBlock: number, toBlock: number + 1n, concurrency: 2 }
    const blocks = yield* client.history.getBlocks({ ...range, full: true })
    assert.deepEqual(blocks.map(block => block.number), [number, number + 1n])
    const transactions = yield* client.history.getTransactions(range)
    assert.equal(transactions.length, blocks.reduce((sum, block) => sum + block.transactions.length, 0))
    const receipts = yield* client.history.getReceipts(range)
    const expected = receipts.flatMap(receipt => receipt.logs).filter(log => log.address.toLowerCase() === usdc && log.topics[0] === transfer)
    const pages = yield* client.history.streamLogPages({ ...range, chunkSize: 1n, filter: { address: usdc, topics: [transfer] } }).pipe(Stream.runCollect)
    assert.deepEqual(pages.map(page => page.fromBlock), [number, number + 1n])
    const identity = log => `${log.blockHash}:${log.logIndex}`
    assert.deepEqual(pages.flatMap(page => page.logs).map(identity).sort(), expected.map(identity).sort())
    const [left, right] = yield* Effect.all([0, 1].map(() => client.watchBlocks({ full: true, logs: true }).pipe(Stream.take(2), Stream.runCollect)), { concurrency: 'unbounded' })
    assert.equal(left[0], right[0])
    assert.equal(left[1], right[1])
    assert.ok(left[1].number > left[0].number)
    console.log({ historicalBlocks: blocks.length, logs: expected.length, watchedBlocks: left.map(block => block.number.toString()), metrics: client.metrics })
  }))
}, 120000)
