import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { Socket } from 'effect/unstable/socket'
import { createPublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { EvmClient } from '../src/index.ts'
import { viemTransport } from '../src/viem.ts'

const privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

test('Anvil: Viem submits an offline-signed transaction through EvmClient', async () => {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = reservation.port
  reservation.stop(true)
  const anvil = Bun.spawn(['node_modules/.bin/anvil', '--silent', '--port', String(port)], { stdout: 'ignore', stderr: 'pipe' })
  const endpoint = `http://127.0.0.1:${port}`
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
        })
        if (response.ok) break
      } catch {}
      await Bun.sleep(20)
    }
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const evm = yield* EvmClient.make({
        endpoints: { http: [endpoint], ws: [] }, network: { chainId: 31337n, blockTime: 100 },
        options: { concurrentHttp: 1, concurrentWs: 0 },
      })
      const client = createPublicClient({ chain: foundry, transport: viemTransport(evm) })
      const account = privateKeyToAccount(privateKey)
      const transaction = yield* Effect.promise(() => account.signTransaction({
        chainId: 31337, nonce: 0, gas: 21000n, gasPrice: 1_000_000_000n,
        to: account.address, value: 1n,
      }))
      const hash = yield* Effect.promise(() => client.sendRawTransaction({ serializedTransaction: transaction }))
      const receipt = yield* Effect.promise(() => client.waitForTransactionReceipt({ hash, pollingInterval: 25 }))
      assert.equal(receipt.status, 'success')
      assert.equal(receipt.transactionHash, hash)
    })).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(Socket.layerWebSocketConstructorGlobal)))
  } finally {
    anvil.kill()
    await anvil.exited
  }
}, 30000)
