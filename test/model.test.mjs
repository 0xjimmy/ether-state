import { test, expect } from 'bun:test'
import { Effect, Fiber, Queue, Schema, Stream } from 'effect'
import { Indexer, Source, Projection, memoryModelStore, missingRange } from '../src/indexer.ts'

const hash = n => `0x${n.toString(16).padStart(64, '0')}`
const block = (number, timestamp = number * 10, fork = 0) => ({ number: BigInt(number), hash: hash(number + fork), parentHash: hash(number - 1 + fork), timestamp: BigInt(timestamp), logsBloom: '0x' })
const chain = () => Array.from({ length: 13 }, (_, i) => block(i))
const fixture = (blocks, liveQueue) => ({
  config: { network: { chainId: 1n } },
  watchBlocks: () => Stream.never,
  watchLogBlocks: () => liveQueue ? Stream.fromQueue(liveQueue) : Stream.never,
  fetchOne: ({ method, params }) => {
    if (method === 'eth_getBlockByNumber') return Effect.succeed(params[0] === 'latest' ? blocks.at(-1) : blocks.find(b => b.number === params[0]) ?? null)
    if (method === 'eth_getLogs') {
      const b = blocks.find(b => b.hash === params[0].blockHash)
      return Effect.succeed(b ? [{ blockNumber: b.number, blockHash: b.hash, transactionHash: hash(Number(b.number) + 1000), transactionIndex: 0n, logIndex: 0n, data: String(b.number) }] : [])
    }
    throw new Error(method)
  },
})
const definition = Indexer.define({
  name: 'test', version: 1, params: Schema.Struct({ address: Schema.String }),
  build: () => {
    const events = Source.logs({ name: 'events', filter: {}, schema: Schema.Number, decode: log => Effect.succeed(Number(log.data)) })
    return {
      current: Projection.state({ source: events, schema: Schema.Number, seed: ({ block }) => Effect.succeed(Number(block.number)), reduce: ({ state, events }) => Effect.succeed(state + events.reduce((a,b) => a+b, 0)) }),
      candles: Projection.partitioned({ source: events, schema: Schema.Struct({ open: Schema.NullOr(Schema.Number), close: Schema.NullOr(Schema.Number), total: Schema.Number }), intervalSeconds: 60n,
        rebuild: ({ events }) => Effect.succeed({ open: events[0]?.value ?? null, close: events.at(-1)?.value ?? null, total: events.reduce((n,e) => n+e.value, 0) }) }),
    }
  },
})
const run = (effect) => Effect.runPromise(Effect.scoped(effect))
const waitUntil = predicate => Effect.gen(function* () {
  for(let i=0;i<300;i++) { if(yield* predicate()) return; yield* Effect.sleep(10) }
  throw new Error('condition timeout')
})

test('coverage chooses newest gaps, including restart gaps, before old history', () => {
  expect(missingRange([{from: 80n, through: 100n}, {from:110n,through:120n}], 0n,120n,16)).toEqual({from:101n,through:109n})
  expect(missingRange([{from:80n,through:120n}],0n,120n,16)).toEqual({from:64n,through:79n})
})

test('definition creates isolated instances and backward history does not change live state', async () => {
 await run(Effect.gen(function* () {
  const store = memoryModelStore()
  const options = { client: fixture(chain()), store, plan: { history: { from:0n, batchSize:4 } } }
  const a = yield* definition.make({...options, params:{address:'a'}})
  const b = yield* definition.make({...options, params:{address:'b'}})
  expect(a.id).not.toBe(b.id)
  yield* a.run()
  expect((yield* a.read('current'))[0].value).toBe(12)
  expect(yield* b.read('current')).toEqual([])
  const candles = yield* a.read('candles')
  const first = candles.find(row => row.key === '0')
  expect(first.value).toEqual({open:0,close:5,total:15})
  expect(first.period).toBe('closed')
  expect(first.coverage).toBe('complete')
  expect((yield* a.status).coverage).toEqual([{from:0n,through:12n}])
  const restarted = yield* definition.make({...options, params:{address:'a'}})
  yield* restarted.run()
  expect((yield* restarted.read('candles')).find(row=>row.key==='0').value.total).toBe(15)
 }))
})

test('live empty blocks close candles and restart gaps remain recoverable', async () => {
 await run(Effect.gen(function* () {
  const blocks = chain().slice(0,6)
  const queue = yield* Queue.unbounded()
  const store = memoryModelStore()
  const client = fixture(blocks,queue)
  const instance = yield* definition.make({client,store,params:{address:'live'},plan:{live:{start:'head'},history:{from:0n,batchSize:8}}})
  const fiber = yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(() => instance.status.pipe(Effect.map(s=>s.history==='complete')))
  const next = block(6)
  blocks.push(next)
  yield* Queue.offer(queue,{block:next,logs:[],observedAt:Date.now()})
  yield* waitUntil(() => instance.status.pipe(Effect.map(s=>s.applied?.number===6n)))
  const candle = (yield* instance.read('candles')).find(row=>row.key==='0')
  expect(candle.period).toBe('closed')
  expect(candle.coverage).toBe('complete')
  expect(candle.value.total).toBe(15)
  yield* Fiber.interrupt(fiber)
  blocks.push(block(7),block(8))
  const restarted = yield* definition.make({client,store,params:{address:'live'},plan:{history:{from:0n,batchSize:4}}})
  yield* restarted.run()
  expect((yield* restarted.status).coverage).toEqual([{from:0n,through:8n}])
 }))
})

test('one stored instance permits only one writer', async () => {
 await run(Effect.gen(function* () {
  const store=memoryModelStore(); const options={client:fixture(chain()),store,params:{address:'same'},plan:{live:{start:'head'}}}
  const a=yield* definition.make(options);const b=yield* definition.make(options)
  const fiber=yield* a.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>a.status.pipe(Effect.map(s=>s.live==='following')))
  const error=yield* Effect.flip(b.run())
  expect(error.stage).toBe('running')
  yield* Fiber.interrupt(fiber)
 }))
})

test('PGlite persists batches and projections after closing and reopening the database', async () => {
 const { PGlite } = await import('@electric-sql/pglite')
 const { pgliteModelStore } = await import('../src/indexer/model-pglite.ts')
 const { mkdtemp, rm } = await import('node:fs/promises')
 const { tmpdir } = await import('node:os')
 const { join } = await import('node:path')
 const directory = await mkdtemp(join(tmpdir(), 'ether-model-'))
 let db = await PGlite.create(directory)
 try {
  await run(Effect.gen(function* () {
   const store=yield* pgliteModelStore(db)
   const options={client:fixture(chain()),store,params:{address:'db'},plan:{history:{from:0n,batchSize:8}}}
   const a=yield* definition.make(options);yield* a.run()
   yield* Effect.promise(() => db.close())
   db = yield* Effect.promise(() => PGlite.create(directory))
   const reopenedStore = yield* pgliteModelStore(db)
   const b=yield* definition.make({...options, store: reopenedStore});yield* b.run()
   expect((yield* b.read('candles')).find(r=>r.key==='0').value.total).toBe(15)
   expect((yield* b.status).coverage).toEqual([{from:0n,through:12n}])
  }))
 } finally { await db.close(); await rm(directory, { recursive: true, force: true }) }
})

test('historical transform failures do not commit coverage or report success', async () => {
 const broken=Indexer.define({name:'broken',version:1,params:Schema.Void,build:()=>{
  const source=Source.logs({name:'events',filter:{},schema:Schema.Number,decode:()=>Effect.succeed(1)})
  return {candles:Projection.partitioned({source,schema:Schema.Number,intervalSeconds:60n,rebuild:()=>Effect.fail(new Error('bad reducer'))})}
 }})
 await run(Effect.gen(function*(){
  const index=yield* broken.make({client:fixture(chain()),params:undefined,plan:{history:{from:0n}}})
  const failure=yield* Effect.flip(index.run())
  expect(failure.stage).toBe('projection')
  expect((yield* index.status).coverage).toEqual([])
 }))
})

test('a restart after a fork invalidates orphaned volume and repairs the range', async()=>{
 await run(Effect.gen(function*(){
  const blocks=chain(); const store=memoryModelStore()
  const options={client:fixture(blocks),store,params:{address:'fork'},plan:{history:{from:0n,batchSize:4}}}
  const first=yield* definition.make(options);yield* first.run()
  const ancestor=blocks[8]
  blocks.splice(9,4,...[9,10,11,12].map(n=>({...block(n,n*10,100),parentHash:n===9?ancestor.hash:hash(n-1+100)})))
  const second=yield* definition.make(options);yield* second.run()
  expect((yield* second.status).coverage).toEqual([{from:0n,through:12n}])
  expect((yield* second.read('candles')).find(r=>r.key==='60').value.total).toBe(51)
  const stored=yield* store.batches(second.id)
  expect(stored.find(b=>b.block.number===9n).block.hash).toBe(hash(109))
 }))
})

test('checkpoint mode catches up every missed block before following', async()=>{
 await run(Effect.gen(function*(){
  const blocks=chain();const store=memoryModelStore();const queue=yield* Queue.unbounded();const client=fixture(blocks,queue)
  const initial=yield* definition.make({client,store,params:{address:'resume'},plan:{history:{from:0n,batchSize:16}}});yield* initial.run()
  blocks.push(block(13),block(14))
  const resumed=yield* definition.make({client,store,params:{address:'resume'},plan:{live:{start:'checkpoint'}}})
  const fiber=yield* resumed.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>resumed.status.pipe(Effect.map(s=>s.live==='following')))
  const logs=yield* client.fetchOne({method:'eth_getLogs',params:[{blockHash:blocks.at(-1).hash}]})
  yield* Queue.offer(queue,{block:blocks.at(-1),logs,observedAt:Date.now()})
  yield* waitUntil(()=>resumed.status.pipe(Effect.map(s=>s.applied?.number===14n)))
  expect((yield* resumed.read('current'))[0].value).toBe(12+13+14)
  yield* Fiber.interrupt(fiber)
 }))
})

test('partial candles are not marked complete when their first blocks are missing', async()=>{
 await run(Effect.gen(function*(){
  const instance=yield* definition.make({client:fixture(chain()),params:{address:'partial'},plan:{history:{from:3n,batchSize:16}}})
  yield* instance.run()
  // A requested range start does not prove that the earlier part of this candle is empty.
  expect((yield* instance.read('candles')).find(r=>r.key==='0').coverage).toBe('partial')
  const queue=yield* Queue.unbounded();const blocks=chain().slice(0,5)
  const live=yield* definition.make({client:fixture(blocks,queue),params:{address:'partial-live'},plan:{live:{start:'head'}}})
  const fiber=yield* live.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>live.status.pipe(Effect.map(s=>s.live==='following')))
  blocks.push(block(5))
  const logs=yield* fixture(blocks).fetchOne({method:'eth_getLogs',params:[{blockHash:blocks.at(-1).hash}]})
  yield* Queue.offer(queue,{block:blocks.at(-1),logs,observedAt:Date.now()})
  yield* waitUntil(()=>live.status.pipe(Effect.map(s=>s.applied?.number===5n)))
  expect((yield* live.read('candles'))[0].coverage).toBe('partial')
  expect((yield* live.read('candles'))[0].period).toBe('open')
  yield* Fiber.interrupt(fiber)
 }))
})

test('close stops an instance, ends subscriptions, and releases its writer without closing shared resources', async () => {
 await run(Effect.gen(function* () {
  const client = fixture(chain())
  const store = memoryModelStore()
  const options = { client, store, params: { address: 'close' }, plan: { live: { start: 'head' } } }
  const instance = yield* definition.make(options)
  const watcher = yield* instance.watch('current').pipe(Stream.runDrain, Effect.forkScoped)
  const worker = yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(() => instance.status.pipe(Effect.map(s => s.live === 'following')))
  yield* Effect.all([instance.close(), instance.close()], { concurrency: 'unbounded' })
  expect(instance.isClosed).toBe(true)
  expect((yield* instance.status).live).toBe('closed')
  yield* Fiber.join(watcher)
  expect((yield* Fiber.await(worker))._tag).toBe('Failure')
  expect((yield* Effect.exit(instance.run()))._tag).toBe('Failure')
  expect((yield* instance.read('current')).length).toBe(1)
  const replacement = yield* definition.make(options)
  yield* replacement.run().pipe(Effect.forkScoped)
  yield* waitUntil(() => replacement.status.pipe(Effect.map(s => s.live === 'following')))
  yield* replacement.close()
 }))
}, 5000)

test('the instance owner scope closes an externally running worker', async () => {
 const { Scope, Exit } = await import('effect')
 await run(Effect.gen(function* () {
  const owner = yield* Scope.make()
  const instance = yield* definition.make({ client: fixture(chain()), params: { address: 'owner' }, plan: { live: { start: 'head' } } }).pipe(Scope.provide(owner))
  const worker = yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(() => instance.status.pipe(Effect.map(s => s.live === 'following')))
  yield* Scope.close(owner, Exit.void)
  expect(instance.isClosed).toBe(true)
  expect((yield* Fiber.await(worker))._tag).toBe('Failure')
 }))
}, 5000)

test('close waits for an active PGlite transaction before releasing its writer', async () => {
 const { PGlite } = await import('@electric-sql/pglite')
 const { pgliteModelStore } = await import('../src/indexer-pglite.ts')
 const database = await PGlite.create()
 let releaseTransaction
 let transactionEntered
 const gate = new Promise(resolve => { releaseTransaction = resolve })
 const entered = new Promise(resolve => { transactionEntered = resolve })
 const connection = {
  exec: (...args) => database.exec(...args),
  query: (...args) => database.query(...args),
  transaction: callback => database.transaction(async tx => {
   transactionEntered()
   await gate
   return callback(tx)
  }),
 }
 try {
  await run(Effect.gen(function* () {
   const store = yield* pgliteModelStore(connection)
   const instance = yield* definition.make({ client: fixture(chain()), store, params: { address: 'pending-write' }, plan: { live: { start: 'head' } } })
   yield* instance.run().pipe(Effect.forkScoped)
   yield* Effect.promise(() => entered)
   const closing = yield* instance.close().pipe(Effect.forkScoped)
   yield* Effect.sleep(20)
   const closedEarly = closing.pollUnsafe() !== undefined
   const claimDuringClose = yield* Effect.result(store.claim(instance.id))
   releaseTransaction()
   yield* Fiber.join(closing)
   expect(closedEarly).toBe(false)
   expect(claimDuringClose._tag).toBe('Failure')
   expect((yield* instance.read('current')).length).toBe(1)
   const release = yield* store.claim(instance.id)
   release()
  }))
 } finally { releaseTransaction(); await database.close() }
}, 10000)
