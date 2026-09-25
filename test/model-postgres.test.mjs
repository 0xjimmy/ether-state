import { test, expect } from 'bun:test'
import { Effect } from 'effect'
import { PGlite } from '@electric-sql/pglite'
import { pgliteModelStore } from '../src/indexer/model-pglite.ts'
import { postgresModelStore } from '../src/indexer/model-postgres.ts'

test('Postgres adapter does not initialize schema and shares claims with the embedded wrapper', async () => {
  const db = await PGlite.create()
  try {
    const store = await Effect.runPromise(postgresModelStore(db))
    expect((await db.query("SELECT to_regclass('ether_model_blocks') AS name")).rows[0].name).toBeNull()
    const embedded = await Effect.runPromise(pgliteModelStore(db))
    const release = await Effect.runPromise(embedded.claim('same'))
    expect((await Effect.runPromise(Effect.result(store.claim('same'))))._tag).toBe('Failure')
    release()
    const close = await Effect.runPromise(store.claim('same'))
    close()
    const block = number => ({number, timestamp:number, hash:String(number), parentHash:String(number-1n)})
    await Promise.all(Array.from({length:8},(_,i)=>Effect.runPromise((i%2?embedded:store).commit('same', {batches:[{block:block(BigInt(i)),sources:{}}],rows:[]}))))
    expect(await Effect.runPromise(store.coverage('same'))).toEqual([{from:0n,through:7n}])
  } finally { await db.close() }
},10000)
