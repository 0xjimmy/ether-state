import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { Socket } from 'effect/unstable/socket'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { EvmClient } from '../src/index.ts'
import { viemTransport } from '../src/viem.ts'

const endpoint = process.env.BASE_RPC_HTTP_URL ?? 'https://mainnet.base.org'
const zero = '0x0000000000000000000000000000000000000000'
const weth = '0x4200000000000000000000000000000000000006'
const run = program => Effect.runPromise(Effect.scoped(program).pipe(
  Effect.provide(FetchHttpClient.layer), Effect.provide(Socket.layerWebSocketConstructorGlobal), Effect.timeout(110000)))

test('live Base RPC: Viem public reads match the EvmClient adapter', async () => {
  await run(Effect.gen(function* () {
    const evm = yield* EvmClient.make({
      endpoints: { http: [endpoint], ws: [] },
      network: { chainId: 8453n, blockTime: 2000 },
      options: { concurrentHttp: 1, concurrentWs: 0 },
    })
    const direct = createPublicClient({ chain: base, transport: http(endpoint, { retryCount: 0 }) })
    const adapted = createPublicClient({ chain: base, transport: viemTransport(evm), batch: { multicall: false } })
    const head = yield* Effect.promise(() => direct.getBlockNumber())
    const blockNumber = head - 5n
    const checks = [
      () => direct.getChainId(),
      () => direct.getBlockNumber(),
      () => direct.getBalance({ address: zero, blockNumber }),
      () => direct.getCode({ address: weth, blockNumber }),
      () => direct.getTransactionCount({ address: zero, blockNumber }),
      () => direct.getBlock({ blockNumber, includeTransactions: false }),
      () => direct.getBlockTransactionCount({ blockNumber }),
      () => direct.getGasPrice(),
      () => direct.getLogs({ address: weth, fromBlock: blockNumber, toBlock: blockNumber }),
    ]
    const adaptedChecks = [
      () => adapted.getChainId(),
      () => adapted.getBlockNumber(),
      () => adapted.getBalance({ address: zero, blockNumber }),
      () => adapted.getCode({ address: weth, blockNumber }),
      () => adapted.getTransactionCount({ address: zero, blockNumber }),
      () => adapted.getBlock({ blockNumber, includeTransactions: false }),
      () => adapted.getBlockTransactionCount({ blockNumber }),
      () => adapted.getGasPrice(),
      () => adapted.getLogs({ address: weth, fromBlock: blockNumber, toBlock: blockNumber }),
    ]
    for (let index = 0; index < checks.length; index++) {
      const expected = yield* Effect.promise(checks[index])
      const actual = yield* Effect.promise(adaptedChecks[index])
      assert.deepEqual(actual, expected)
    }
  }))
}, 120000)

test('live Base RPC: equal Viem watchers share EvmClient block work', async () => {
  await run(Effect.gen(function* () {
    const evm = yield* EvmClient.make({
      endpoints: { http: [endpoint], ws: [] },
      network: { chainId: 8453n, blockTime: 2000 },
      options: { concurrentHttp: 1, concurrentWs: 0 },
    })
    const client = createPublicClient({ chain: base, transport: viemTransport(evm) })
    for (const count of [1, 10, 100]) {
      const before = evm.metrics.http.reduce((total, metric) => total + metric.requests, 0)
      const block = yield* Effect.promise(() => new Promise((resolve, reject) => {
        const values = []
        let stops = []
        stops = Array.from({ length: count }, () => client.watchBlockNumber({
          onBlockNumber(value) {
            values.push(value)
            if (values.length === count) {
              for (const stop of stops) stop()
              resolve(value)
            }
          },
          onError: reject,
        }))
      }))
      const after = evm.metrics.http.reduce((total, metric) => total + metric.requests, 0)
      assert.equal(typeof block, 'bigint')
      assert.ok(after - before < 20, `${count} watchers caused ${after - before} upstream requests`)
    }
  }))
}, 120000)
