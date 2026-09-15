import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { viemTransport, ViemAdapterError } from '../src/viem.ts'

test('viem transport is subscription capable and disables Viem retries', async () => {
  const transport = viemTransport(undefined)()
  assert.equal(transport.config.type, 'webSocket')
  assert.equal(transport.config.retryCount, 0)
  assert.equal(typeof transport.value.subscribe, 'function')
  await assert.rejects(
    transport.request({ method: 'eth_requestAccounts', params: [] }),
    error => error instanceof ViemAdapterError && error.code === 4200,
  )
})
