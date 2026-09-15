import assert from 'node:assert/strict'
import { Effect } from 'effect'

const checkpoint = {
  indexId: 'balances', version: 1, chainId: 8453n, startBlock: 10n,
  number: 10n, hash: `0x${'10'.repeat(32)}`, parentHash: `0x${'09'.repeat(32)}`, timestamp: 100n,
  finalized: { number: 8n, hash: `0x${'08'.repeat(32)}` },
}
const rows = [{ key: 'account', blockNumber: 10n, blockHash: checkpoint.hash, blockTimestamp: 100n, value: { balance: '12' } }]

const verifyStore = async store => {
  assert.equal(await Effect.runPromise(store.load('balances', 1)), null)
  await Effect.runPromise(store.commit({ checkpoint, rows }))
  assert.deepEqual(await Effect.runPromise(store.load('balances', 1)), checkpoint)
  assert.deepEqual(await Effect.runPromise(store.load('balances', 2)), checkpoint)
  assert.deepEqual(await Effect.runPromise(store.recent('balances', 1, 10)), [{
    number: checkpoint.number, hash: checkpoint.hash, parentHash: checkpoint.parentHash, timestamp: checkpoint.timestamp,
  }])
  await Effect.runPromise(store.commit({ checkpoint, rows }))
  await Effect.runPromise(store.rollback({ indexId: 'balances', version: 1, orphaned: [checkpoint], checkpoint: null }))
  assert.equal(await Effect.runPromise(store.load('balances', 1)), null)
  await assert.rejects(Effect.runPromise(store.commit({ checkpoint, rows: [rows[0], { ...rows[0], key: null }] })))
  assert.equal(await Effect.runPromise(store.load('balances', 1)), null)
}

const adapter = process.argv[2]
if (adapter === 'pglite') {
  const [{ PGlite }, { pgliteStore }] = await Promise.all([import('@electric-sql/pglite'), import('../src/indexer-pglite.ts')])
  const database = new PGlite()
  try {
    await verifyStore(await Effect.runPromise(pgliteStore(database)))
  } finally {
    await database.close()
  }
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'ether-state-pglite-'))
  try {
    const first = new PGlite(directory)
    const firstStore = await Effect.runPromise(pgliteStore(first))
    await Effect.runPromise(firstStore.commit({ checkpoint, rows }))
    await first.close()
    const second = new PGlite(directory)
    try {
      const secondStore = await Effect.runPromise(pgliteStore(second))
      assert.deepEqual(await Effect.runPromise(secondStore.load('balances', 1)), checkpoint)
    } finally {
      await second.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
} else if (adapter === 'libsql') {
  const [{ createClient }, { libsqlStore }] = await Promise.all([import('@libsql/client'), import('../src/indexer-libsql.ts')])
  const client = createClient({ url: 'file::memory:' })
  try {
    await verifyStore(await Effect.runPromise(libsqlStore(client)))
  } finally {
    client.close()
  }
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'ether-state-libsql-'))
  const url = `file:${join(directory, 'index.db')}`
  try {
    const first = createClient({ url })
    const firstStore = await Effect.runPromise(libsqlStore(first))
    await Effect.runPromise(firstStore.commit({ checkpoint, rows }))
    first.close()
    const second = createClient({ url })
    try {
      const secondStore = await Effect.runPromise(libsqlStore(second))
      assert.deepEqual(await Effect.runPromise(secondStore.load('balances', 1)), checkpoint)
    } finally {
      second.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
} else if (adapter === 'd1') {
  const [{ Miniflare }, { d1Store }] = await Promise.all([import('miniflare'), import('../src/indexer-d1.ts')])
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-09-01',
    d1Databases: { DB: 'ether-state-index-test' },
  })
  try {
    await verifyStore(await Effect.runPromise(d1Store(await miniflare.getD1Database('DB'))))
  } finally {
    await miniflare.dispose()
  }
} else {
  throw new Error(`Unknown storage adapter: ${adapter}`)
}
