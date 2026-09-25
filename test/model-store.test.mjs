import { test, expect } from 'bun:test'
import { Effect } from 'effect'
import { PGlite } from '@electric-sql/pglite'
import { memoryModelStore, encodeModelBatch } from '../src/indexer/model-store.ts'
import { pgliteModelStore } from '../src/indexer/model-pglite.ts'
const run = Effect.runPromise
const block = (number, timestamp = number * 10) => ({ number: BigInt(number), timestamp: BigInt(timestamp), hash: `hash${number}`, parentHash: `hash${number-1}` })
const batch = (number, timestamp) => ({ block: block(number,timestamp), sources: {} })
const row = (key, endTime) => ({ projection: 'candles', key, value: {}, block: block(1), endTime: BigInt(endTime), period: 'closed', coverage: 'complete' })
for (const kind of ['memory', 'pglite']) {
  test(`${kind} sparse coverage is independent, merged, clipped, and invalidation uses preceding time`, async () => {
    const db = kind === 'pglite' ? new PGlite() : null
    const store = db ? await run(pgliteModelStore(db)) : memoryModelStore()
    try {
      await run(store.commit('a', { batches: [], rows: [], coverage: [{ from: 10n, through: 100n }] }))
      expect(await run(store.coverage('a'))).toEqual([{from:10n,through:100n}])
      await run(store.commit('a', { batches: [batch(10,100),batch(100,1000)], rows: [row('old',60),row('fork-minute',180)], coverage: [{from:101n,through:200n},{from:1n,through:9n}] }))
      expect(await run(store.coverage('a'))).toEqual([{from:1n,through:200n}])
      expect((await run(store.batches('a',{through:99n,direction:'backward',limit:1})))[0].block.number).toBe(10n)
      await run(store.invalidate('a',15n))
      expect(await run(store.coverage('a'))).toEqual([{from:1n,through:14n}])
      expect((await run(store.rows('a','candles'))).map(row=>row.key)).toEqual(['old'])
      await run(store.retain('a',{fromBlock:12n,fromTime:0n}))
      expect(await run(store.coverage('a'))).toEqual([{from:12n,through:14n}])
      expect(await run(store.batches('a'))).toEqual([])
      await run(store.commit('a',{batches:[batch(15)],rows:[]}))
      expect(await run(store.coverage('a'))).toEqual([{from:12n,through:15n}])
      if(db) expect(await run((await run(pgliteModelStore(db))).coverage('a'))).toEqual([{from:12n,through:15n}])
      await expect(run(store.commit('a',{batches:[batch(16)],rows:[],coverage:[{from:20n,through:19n}]}))).rejects.toBeDefined()
      expect(await run(store.coverage('a'))).toEqual([{from:12n,through:15n}])
      expect((await run(store.batches('a'))).map(value=>value.block.number)).toEqual([15n])
      expect(await run(store.coverage('other'))).toEqual([])
      await run(store.commit('exact',{batches:[batch(10,100),batch(15,150)],rows:[row('previous-minute',120),row('fork-minute',180)]}))
      await run(store.invalidate('exact',15n))
      expect((await run(store.rows('exact','candles'))).map(value=>value.key)).toEqual(['previous-minute'])
      if (db) {
        await db.exec("CREATE FUNCTION fail_model_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture write failure'; END $$; CREATE TRIGGER fail_model_insert BEFORE INSERT ON ether_model_blocks FOR EACH ROW EXECUTE FUNCTION fail_model_insert()")
        await expect(run(store.commit('a',{batches:[batch(16)],rows:[],coverage:[{from:16n,through:100n}]}))).rejects.toBeDefined()
        expect(await run(store.coverage('a'))).toEqual([{from:12n,through:15n}])
        await db.exec('DROP TRIGGER fail_model_insert ON ether_model_blocks; DROP FUNCTION fail_model_insert()')
      }
    } finally { await db?.close() }
  },30000)
}

test('PGlite migrates legacy contiguous block coverage once and keeps explicit empty spans across disk restart', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const directory = await mkdtemp(`${tmpdir()}/model-coverage-`)
  let db = new PGlite(directory)
  try {
    await db.exec('CREATE TABLE ether_model_blocks(instance TEXT NOT NULL,number NUMERIC(78,0) NOT NULL,timestamp NUMERIC(78,0) NOT NULL,data TEXT NOT NULL,PRIMARY KEY(instance,number))')
    for(const number of [1,2,4]) await db.query('INSERT INTO ether_model_blocks VALUES($1,$2,$3,$4)',['legacy',number,number*10,await run(encodeModelBatch(batch(number)))])
    let store=await run(pgliteModelStore(db))
    expect(await run(store.coverage('legacy'))).toEqual([{from:1n,through:2n},{from:4n,through:4n}])
    await run(store.commit('empty',{batches:[],rows:[],coverage:[{from:100n,through:1000n}]}))
    await db.close(); db=new PGlite(directory); store=await run(pgliteModelStore(db))
    expect(await run(store.coverage('empty'))).toEqual([{from:100n,through:1000n}])
    await run(store.invalidate('empty',500n))
    store=await run(pgliteModelStore(db))
    expect(await run(store.coverage('empty'))).toEqual([{from:100n,through:499n}])
  } finally { await db.close(); await rm(directory,{recursive:true,force:true}) }
},30000)
