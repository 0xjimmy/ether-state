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
      const selected = params[0].blockHash === undefined
        ? blocks.filter(b => b.number >= params[0].fromBlock && b.number <= params[0].toBlock)
        : blocks.filter(b => b.hash === params[0].blockHash)
      return Effect.succeed(selected.map(b => ({ blockNumber: b.number, blockHash: b.hash, transactionHash: hash(Number(b.number) + 1000), transactionIndex: 0n, logIndex: 0n, data: String(b.number) })))
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

test('a state-only live model still backfills history before a partition boundary', async()=>{
 const stateOnly=Indexer.define({name:'state-only',version:1,params:Schema.Void,build:()=>{
  const source=Source.logs({name:'events',filter:{},schema:Schema.Number,decode:log=>Effect.succeed(Number(log.data))})
  return {current:Projection.state({source,schema:Schema.Number,seed:({block})=>Effect.succeed(Number(block.number)),reduce:({state,events})=>Effect.succeed(state+events.length)})}
 }})
 await run(Effect.gen(function*(){
  const instance=yield* stateOnly.make({client:fixture(chain()),params:undefined,plan:{live:{start:'head'},history:{from:0n,batchSize:16}}})
  const fiber=yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.history==='complete')))
  expect((yield* instance.status).coverage).toEqual([{from:0n,through:12n}])
  yield* Fiber.interrupt(fiber)
 }))
})

test('fast observed heads do not starve history unless a live lag limit is configured', async()=>{
 await run(Effect.gen(function*(){
  const blocks=chain();const base=fixture(blocks)
  const farHead=block(1000,10000)
  const client={...base,watchBlocks:()=>Stream.make({number:farHead.number,hash:farHead.hash,parentHash:farHead.parentHash,timestamp:farHead.timestamp})}
  const instance=yield* definition.make({client,params:{address:'fast-history'},plan:{live:{start:'head'},history:{from:0n,through:12n,batchSize:13}}})
  const fiber=yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.history==='complete')))
  expect((yield* instance.status).coverage).toEqual([{from:0n,through:12n}])
  yield* Fiber.interrupt(fiber)
 }))
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

test('history fetches logs by canonical range and splits provider range limits', async()=>{
 await run(Effect.gen(function*(){
  const blocks=chain();const base=fixture(blocks);let rangeReads=0
  const client={...base,fetchOne:request=>{
   if(request.method==='eth_getLogs' && request.params[0].fromBlock!==undefined) {
    rangeReads++
    if(request.params[0].toBlock-request.params[0].fromBlock>3n) return Effect.fail({_tag:'RpcError',code:-32005,message:'block range limit'})
   }
   return base.fetchOne(request)
  }}
  const instance=yield* definition.make({client,params:{address:'range'},plan:{history:{from:0n,batchSize:13}}})
  yield* instance.run()
  expect((yield* instance.status).coverage).toEqual([{from:0n,through:12n}])
  expect(rangeReads).toBeGreaterThan(1)
  expect(rangeReads).toBeLessThan(13)
  expect((yield* instance.read('candles')).find(row=>row.key==='60')?.value.total).toBe(51)
 }))
})

test('sparse history streams one broad log range and commits bounded block pages', async()=>{
 await run(Effect.gen(function*(){
  const blocks=Array.from({length:130},(_,number)=>block(number));const base=fixture(blocks);let rangeReads=0;let headerReads=0
  const client={...base,fetchOne:request=>{
   if(request.method==='eth_getBlockByNumber' && request.params[0]!=='latest') headerReads++
   if(request.method==='eth_getLogs' && request.params[0].fromBlock!==undefined) {
    rangeReads++
    return base.fetchOne(request).pipe(Effect.map(logs=>logs.filter(log=>log.blockNumber===0n || log.blockNumber===129n)))
   }
   return base.fetchOne(request)
  }}
  const instance=yield* definition.make({client,params:{address:'sparse-stream'},plan:{history:{from:0n,batchSize:130}}})
  yield* instance.run()
  expect((yield* instance.status).coverage).toEqual([{from:0n,through:129n}])
  expect(rangeReads).toBe(1)
  expect(headerReads).toBeLessThanOrEqual(6)
  expect((yield* instance.read('candles')).find(row=>row.key==='60')).toMatchObject({period:'closed',coverage:'complete',value:{total:0}})
 }))
})

test('a ten thousand block empty span uses boundary headers and survives restart', async()=>{
 await run(Effect.gen(function*(){
  const blocks=Array.from({length:10_000},(_,number)=>block(number,number));const base=fixture(blocks);const store=memoryModelStore();let headerReads=0;let rangeReads=0
  const client={...base,fetchOne:request=>{
   if(request.method==='eth_getBlockByNumber' && request.params[0]!=='latest') headerReads++
   if(request.method==='eth_getLogs' && request.params[0].fromBlock!==undefined) {rangeReads++;return Effect.succeed([])}
   return base.fetchOne(request)
  }}
  const options={client,store,params:{address:'empty-span'},plan:{history:{from:0n,batchSize:10_000}}}
  const instance=yield* definition.make(options);yield* instance.run()
  expect((yield* instance.status).coverage).toEqual([{from:0n,through:9999n}])
  expect(rangeReads).toBe(1);expect(headerReads).toBeLessThanOrEqual(4)
  expect((yield* instance.read('candles')).find(row=>row.key==='60')).toMatchObject({period:'closed',coverage:'complete',value:{total:0}})
  const restarted=yield* definition.make(options);yield* restarted.run()
  expect((yield* restarted.read('candles')).find(row=>row.key==='60')).toMatchObject({period:'closed',coverage:'complete',value:{total:0}})
 }))
})

test('a sparse partial minute closes after a restart receives its boundary', async()=>{
 await run(Effect.gen(function*(){
  const blocks=Array.from({length:6},(_,number)=>block(number));const store=memoryModelStore()
  const sparse=()=>{const base=fixture(blocks);return {...base,fetchOne:request=>request.method==='eth_getLogs'&&request.params[0].fromBlock!==undefined?Effect.succeed([]):base.fetchOne(request)}}
  const options={store,params:{address:'sparse-resume'},plan:{history:{from:0n,batchSize:100}}}
  const first=yield* definition.make({...options,client:sparse()});yield* first.run()
  expect((yield* first.read('candles')).find(row=>row.key==='0')).toMatchObject({period:'open',value:{total:0}})
  blocks.push(block(6))
  const restarted=yield* definition.make({...options,client:sparse()});yield* restarted.run()
  expect((yield* restarted.read('candles')).find(row=>row.key==='0')).toMatchObject({period:'closed',coverage:'complete',value:{total:0}})
 }))
})

test('a sparse historical range is invalidated and regenerated after a restart fork', async()=>{
 await run(Effect.gen(function*(){
  const blocks=Array.from({length:130},(_,number)=>block(number));const store=memoryModelStore()
  const options={store,params:{address:'sparse-fork'},plan:{history:{from:0n,batchSize:130}}}
  const first=yield* definition.make({...options,client:fixture(blocks)});yield* first.run()
  for(let number=100;number<blocks.length;number++) blocks[number]={...block(number,number*10,1000),parentHash:number===100?hash(99):hash(number-1+1000)}
  const restarted=yield* definition.make({...options,client:fixture(blocks)});yield* restarted.run()
  expect((yield* restarted.status).coverage).toEqual([{from:0n,through:129n}])
  expect((yield* store.batches(restarted.id,{from:129n,through:129n}))[0].block.hash).toBe(hash(1129))
 }))
})

test('a later historical page failure preserves newer committed coverage', async()=>{
 await run(Effect.gen(function*(){
  const blocks=Array.from({length:130},(_,number)=>block(number));const base=fixture(blocks);const store=memoryModelStore()
  const client={...base,fetchOne:request=>{
   if(request.method==='eth_getLogs' && request.params[0].fromBlock!==undefined) {
    const filter=request.params[0];const width=filter.toBlock-filter.fromBlock+1n
    if(width>64n) return Effect.fail({_tag:'RpcError',code:-32005,message:'block range limit'})
    if(filter.toBlock<65n) return Effect.fail({_tag:'RpcError',code:-32000,message:'historical provider unavailable'})
   }
   return base.fetchOne(request)
  }}
  const instance=yield* definition.make({client,store,params:{address:'partial-pages'},plan:{history:{from:0n,batchSize:130}}})
  const error=yield* Effect.flip(instance.run())
  expect(error.stage).toBe('source')
  expect(yield* store.coverage(instance.id)).toEqual([{from:65n,through:129n}])
 }))
})

test('range capture supplies each canonical block and its fetched logs once', async()=>{
 const captured=[]
 const contextual=Indexer.define({name:'contextual',version:1,params:Schema.Void,build:()=>{
  const source=Source.logs({name:'events',filter:{},schema:Schema.Number,decode:(log,context)=>{
   captured.push({number:context.block.number,logs:context.logs.length,range:context.range===undefined?null:{from:context.range.from.number,through:context.range.through.number,logs:context.range.logs.length}})
   return Effect.succeed(Number(log.data))
  }})
  return {current:Projection.state({source,schema:Schema.Number,seed:()=>Effect.succeed(0),reduce:({state,events})=>Effect.succeed(state+events.length)})}
 }})
 await run(Effect.gen(function*(){
  const instance=yield* contextual.make({client:fixture(chain()),params:undefined,plan:{history:{from:0n,batchSize:13}}})
  yield* instance.run()
  expect(captured.sort((a,b)=>a.number<b.number?-1:1)).toEqual(Array.from({length:13},(_,number)=>({number:BigInt(number),logs:1,range:{from:0n,through:12n,logs:13}})))
 }))
})

test('source capture filters block and range logs with the same source filter', async()=>{
 const selected='0x0000000000000000000000000000000000000001';const other='0x0000000000000000000000000000000000000002';const contexts=[]
 const source=Source.logs({name:'filtered-context',filter:{address:selected},schema:Schema.Number,decode:(log,context)=>{contexts.push(context);return Effect.succeed(Number(log.data))}})
 const header=block(1);const base=fixture([header]);const log=(await Effect.runPromise(base.fetchOne({method:'eth_getLogs',params:[{blockHash:header.hash}]})))[0]
 const selectedLog={...log,address:selected};const otherLog={...log,address:other,logIndex:1n}
 await Effect.runPromise(source.capture([selectedLog,otherLog],header,{from:header,through:header,logs:[selectedLog,otherLog]}))
 expect(contexts).toHaveLength(1)
 expect(contexts[0].logs).toEqual([selectedLog])
 expect(contexts[0].range).toEqual({from:header,through:header,logs:[selectedLog]})
})

test('raw live logs are independent from slow source capture', async()=>{
 const slowSource=Source.logs({name:'slow',filter:{},schema:Schema.Number,decode:log=>Effect.sleep(300).pipe(Effect.as(Number(log.data)))})
 const slow=Indexer.define({name:'slow-live',version:1,params:Schema.Void,build:()=>({
  current:Projection.state({source:slowSource,schema:Schema.Number,seed:()=>Effect.succeed(0),reduce:({state,events})=>Effect.succeed(state+events.length)}),
 })})
 await run(Effect.gen(function*(){
  const blocks=[block(0)];const queue=yield* Queue.unbounded();const instance=yield* slow.make({client:fixture(blocks,queue),params:undefined,plan:{live:{start:'head'}}})
  const worker=yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.live==='following')))
  const raw=yield* instance.watchLogs(slowSource).pipe(Stream.take(1),Stream.runCollect,Effect.forkScoped)
  yield* Effect.sleep(10)
  blocks.push(block(1));const logs=yield* fixture(blocks).fetchOne({method:'eth_getLogs',params:[{blockHash:blocks[1].hash}]})
  yield* Queue.offer(queue,{block:blocks[1],logs,observedAt:Date.now()})
  const update=Array.from(yield* Fiber.join(raw))[0]
  expect(update).toMatchObject({kind:'apply',block:{number:1n}})
  expect((yield* instance.status).applied?.number).toBe(0n)
  yield* Fiber.interrupt(worker)
 }))
})

test('raw live logs revert a competing canonical height before replacement', async()=>{
 await run(Effect.gen(function*(){
  const blocks=[block(0)];const queue=yield* Queue.unbounded();const instance=yield* definition.make({client:fixture(blocks,queue),params:{address:'raw-reorg'},plan:{live:{start:'head'}}})
  const source=Source.logs({name:'events',filter:{},schema:Schema.Number,decode:log=>Effect.succeed(Number(log.data))})
  const worker=yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.live==='following')))
  const updates=yield* instance.watchLogs(source).pipe(Stream.take(3),Stream.runCollect,Effect.forkScoped)
  yield* Effect.sleep(10)
  const canonical=block(1);blocks.push(canonical)
  yield* Queue.offer(queue,{block:canonical,logs:yield* fixture(blocks).fetchOne({method:'eth_getLogs',params:[{blockHash:canonical.hash}]}),observedAt:Date.now()})
  const replacement={...block(1,10,100),parentHash:blocks[0].hash};blocks[1]=replacement
  yield* Queue.offer(queue,{block:replacement,logs:yield* fixture(blocks).fetchOne({method:'eth_getLogs',params:[{blockHash:replacement.hash}]}),observedAt:Date.now()})
  const values=Array.from(yield* Fiber.join(updates))
  expect(values.map(value=>value.kind)).toEqual(['apply','revert','apply'])
  expect(values[1]).toEqual({kind:'revert',from:1n})
  expect(values[2].block.hash).toBe(replacement.hash)
  yield* Fiber.interrupt(worker)
 }))
})

test('raw live logs fill a canonical height gap without waiting for capture', async()=>{
 await run(Effect.gen(function*(){
  const blocks=[block(0)];const queue=yield* Queue.unbounded();const instance=yield* definition.make({client:fixture(blocks,queue),params:{address:'raw-gap'},plan:{live:{start:'head'}}})
  const source=Source.logs({name:'events',filter:{},schema:Schema.Number,decode:log=>Effect.succeed(Number(log.data))})
  const worker=yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.live==='following')))
  const updates=yield* instance.watchLogs(source).pipe(Stream.take(3),Stream.runCollect,Effect.forkScoped)
  yield* Effect.sleep(10)
  blocks.push(block(1),block(2),block(3));const latest=blocks.at(-1)
  yield* Queue.offer(queue,{block:latest,logs:yield* fixture(blocks).fetchOne({method:'eth_getLogs',params:[{blockHash:latest.hash}]}),observedAt:Date.now()})
  expect(Array.from(yield* Fiber.join(updates)).map(update=>update.block.number)).toEqual([1n,2n,3n])
  yield* Fiber.interrupt(worker)
 }))
})

test('raw live logs revert a deep branch from its first replacement height', async()=>{
 await run(Effect.gen(function*(){
  const blocks=[block(0)];const queue=yield* Queue.unbounded();const instance=yield* definition.make({client:fixture(blocks,queue),params:{address:'raw-deep'},plan:{live:{start:'head'}}})
  const source=Source.logs({name:'events',filter:{},schema:Schema.Number,decode:log=>Effect.succeed(Number(log.data))})
  const worker=yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.live==='following')))
  const updates=yield* instance.watchLogs(source).pipe(Stream.take(8),Stream.runCollect,Effect.forkScoped);yield* Effect.sleep(10)
  for(const next of [block(1),block(2),block(3)]) {
   blocks[Number(next.number)]=next;yield* Queue.offer(queue,{block:next,logs:yield* fixture(blocks).fetchOne({method:'eth_getLogs',params:[{blockHash:next.hash}]}),observedAt:Date.now()})
  }
  const replacements=[1,2,3,4].map(number=>({...block(number,number*10,100),parentHash:number===1?blocks[0].hash:hash(number-1+100)}))
  for(const next of replacements) blocks[Number(next.number)]=next
  const latest=replacements.at(-1)
  yield* Queue.offer(queue,{block:latest,logs:yield* fixture(blocks).fetchOne({method:'eth_getLogs',params:[{blockHash:latest.hash}]}),observedAt:Date.now()})
  const values=Array.from(yield* Fiber.join(updates))
  expect(values.map(value=>value.kind)).toEqual(['apply','apply','apply','revert','apply','apply','apply','apply'])
  expect(values[3]).toEqual({kind:'revert',from:1n})
  expect(values.at(-1).block.hash).toBe(replacements[3].hash)
  yield* Fiber.interrupt(worker)
 }))
})

test('raw live logs fail instead of recursing on a stale next header', async()=>{
 await run(Effect.gen(function*(){
  const blocks=[block(0),block(1)];const queue=yield* Queue.unbounded();const instance=yield* definition.make({client:fixture(blocks,queue),params:{address:'raw-stale'},plan:{live:{start:'head'}}})
  yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.live==='following')))
  const stale={...block(2),parentHash:hash(999)};blocks.push(stale)
  yield* Queue.offer(queue,{block:stale,logs:yield* fixture(blocks).fetchOne({method:'eth_getLogs',params:[{blockHash:stale.hash}]}),observedAt:Date.now()})
  yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.live==='failed')))
  expect((yield* instance.status).error).not.toBeNull()
 }))
})

test('live capture drains a contiguous backlog with bounded concurrency', async()=>{
 const slowSource=Source.logs({name:'slow-batch',filter:{},schema:Schema.Number,decode:log=>Effect.sleep(200).pipe(Effect.as(Number(log.data)))})
 const slow=Indexer.define({name:'slow-batch',version:1,params:Schema.Void,build:()=>({
  current:Projection.state({source:slowSource,schema:Schema.Number,seed:()=>Effect.succeed(0),reduce:({state,events})=>Effect.succeed(state+events.length)}),
 })})
 await run(Effect.gen(function*(){
  const blocks=[block(0)];const queue=yield* Queue.unbounded();const instance=yield* slow.make({client:fixture(blocks,queue),params:undefined,plan:{live:{start:'head'}}})
  const worker=yield* instance.run().pipe(Effect.forkScoped);yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.live==='following')))
  const started=Date.now()
  for(let number=1;number<=8;number++) {
   const next=block(number);blocks.push(next);const logs=yield* fixture(blocks).fetchOne({method:'eth_getLogs',params:[{blockHash:next.hash}]})
   yield* Queue.offer(queue,{block:next,logs,observedAt:Date.now()})
  }
  yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.applied?.number===8n)))
  expect(Date.now()-started).toBeLessThan(1100)
  yield* Fiber.interrupt(worker)
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
  yield* waitUntil(() => instance.read('candles').pipe(Effect.map(rows=>rows.some(row=>row.key==='0'))))
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

test('source watchers receive every committed live block after startup bootstrap', async () => {
 await run(Effect.gen(function* () {
  const blocks=chain().slice(0,5);const queue=yield* Queue.unbounded();const client=fixture(blocks,queue)
  const instance=yield* definition.make({client,params:{address:'source-feed'},plan:{live:{start:'head'}}})
  const source=Source.logs({name:'events',filter:{},schema:Schema.Number,decode:log=>Effect.succeed(Number(log.data))})
  const worker=yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>instance.status.pipe(Effect.map(s=>s.live==='following')))
  const received=yield* instance.watchSource(source).pipe(Stream.take(3),Stream.runCollect,Effect.forkScoped)
  blocks.push(block(5),block(6),block(7))
  const logs=yield* client.fetchOne({method:'eth_getLogs',params:[{blockHash:blocks.at(-1).hash}]})
  yield* Queue.offer(queue,{block:blocks.at(-1),logs,observedAt:Date.now()})
  expect(Array.from(yield* Fiber.join(received)).map(update=>update.block.number)).toEqual([5n,6n,7n])
  yield* Fiber.interrupt(worker)
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
}, 30000)

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

test('closed partial candles are not exposed or persisted', async()=>{
 await run(Effect.gen(function*(){
  const instance=yield* definition.make({client:fixture(chain()),params:{address:'partial'},plan:{history:{from:3n,batchSize:16}}})
  yield* instance.run()
  expect((yield* instance.read('candles')).find(r=>r.key==='0')).toBeUndefined()
  const queue=yield* Queue.unbounded();const blocks=chain().slice(0,5)
  const live=yield* definition.make({client:fixture(blocks,queue),params:{address:'partial-live'},plan:{live:{start:'head'}}})
  const fiber=yield* live.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>live.status.pipe(Effect.map(s=>s.live==='following')))
  blocks.push(block(5))
  const logs=yield* fixture(blocks).fetchOne({method:'eth_getLogs',params:[{blockHash:blocks.at(-1).hash}]})
  yield* Queue.offer(queue,{block:blocks.at(-1),logs,observedAt:Date.now()})
  yield* waitUntil(()=>live.status.pipe(Effect.map(s=>s.applied?.number===5n)))
  expect(yield* live.read('candles')).toEqual([])
  yield* Fiber.interrupt(fiber)
 }))
})

test('startup history publishes closed candles immediately and closes its current minute at the live boundary', async()=>{
 await run(Effect.gen(function*(){
  const blocks=chain().slice(0,9);const queue=yield* Queue.unbounded();const store=memoryModelStore()
  const instance=yield* definition.make({client:fixture(blocks,queue),store,params:{address:'volatile'},plan:{live:{start:'head'},history:{from:0n,batchSize:16}}})
  const fiber=yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>instance.status.pipe(Effect.map(s=>s.live==='following')))
  yield* waitUntil(()=>instance.status.pipe(Effect.map(s=>s.history==='complete')))
  expect((yield* instance.read('candles')).find(row=>row.key==='0')).toMatchObject({period:'closed',coverage:'complete',value:{total:15}})
  expect((yield* instance.read('candles')).find(row=>row.key==='60')).toBeUndefined()
  blocks.push(block(9));const logs=yield* fixture(blocks).fetchOne({method:'eth_getLogs',params:[{blockHash:blocks.at(-1).hash}]})
  yield* Queue.offer(queue,{block:blocks.at(-1),logs,observedAt:Date.now()})
  yield* waitUntil(()=>instance.status.pipe(Effect.map(s=>s.applied?.number===9n)))
  expect((yield* instance.read('candles')).find(row=>row.key==='60')).toBeUndefined()
  blocks.push(block(10),block(11),block(12));const boundaryLogs=yield* fixture(blocks).fetchOne({method:'eth_getLogs',params:[{blockHash:blocks.at(-1).hash}]})
  yield* Queue.offer(queue,{block:blocks.at(-1),logs:boundaryLogs,observedAt:Date.now()})
  yield* waitUntil(()=>instance.read('candles').pipe(Effect.map(rows=>rows.some(row=>row.key==='60' && row.period==='closed'))))
  expect((yield* instance.read('candles')).find(row=>row.key==='120')).toMatchObject({period:'open',value:{total:12}})
  expect((yield* store.rows(instance.id,'candles')).find(row=>row.key==='60')).toMatchObject({period:'closed',coverage:'complete',value:{total:51}})
  yield* Fiber.interrupt(fiber)
  const restarted=yield* definition.make({client:fixture(blocks),store,params:{address:'volatile'},plan:{live:{start:'head'}}})
  const restartedFiber=yield* restarted.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>restarted.status.pipe(Effect.map(s=>s.live==='following')))
  expect((yield* restarted.read('candles')).find(row=>row.key==='120')).toBeUndefined()
  yield* Fiber.interrupt(restartedFiber)
 }))
})

test('restart fills the newest missing minute and commits it once complete', async()=>{
 await run(Effect.gen(function*(){
  const blocks=Array.from({length:13},(_,i)=>block(i));const store=memoryModelStore()
  const first=yield* definition.make({client:fixture(blocks),store,params:{address:'restart-gap'},plan:{history:{from:0n,batchSize:16}}})
  yield* first.run()
  expect((yield* store.rows(first.id,'candles')).map(row=>row.key)).toEqual(['0','60'])
  blocks.push(...Array.from({length:6},(_,i)=>block(i+13)))
  const fetched=[];const base=fixture(blocks)
  const queue=yield* Queue.unbounded();const client={...base,watchLogBlocks:()=>Stream.fromQueue(queue),fetchOne:request=>{
   if(request.method==='eth_getLogs') fetched.push(request.params[0].fromBlock ?? blocks.find(b=>b.hash===request.params[0].blockHash)?.number)
   return base.fetchOne(request)
  }}
  const restarted=yield* definition.make({client,store,params:{address:'restart-gap'},plan:{live:{start:'head'},history:{from:0n,batchSize:2}}})
  const fiber=yield* restarted.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>restarted.status.pipe(Effect.map(status=>status.live==='following')))
  blocks.push(...Array.from({length:6},(_,i)=>block(i+19)))
  const logs=yield* base.fetchOne({method:'eth_getLogs',params:[{blockHash:blocks.at(-1).hash}]})
  yield* Queue.offer(queue,{block:blocks.at(-1),logs,observedAt:Date.now()})
  yield* waitUntil(()=>restarted.read('candles').pipe(Effect.map(rows=>rows.some(row=>row.key==='120' && row.period==='closed'))))
  expect(fetched.indexOf(15n)).toBeLessThan(fetched.indexOf(13n))
  expect((yield* restarted.read('candles')).find(row=>row.key==='120')).toMatchObject({period:'closed',coverage:'complete',value:{total:87}})
  expect((yield* store.rows(restarted.id,'candles')).filter(row=>row.key==='120')).toHaveLength(1)
  yield* Fiber.interrupt(fiber)
 }))
})

test('a boundary jump commits an empty closed minute', async()=>{
 await run(Effect.gen(function*(){
  const blocks=[block(0,0)];const queue=yield* Queue.unbounded();const store=memoryModelStore()
  const instance=yield* definition.make({client:fixture(blocks,queue),store,params:{address:'empty-minute'},plan:{live:{start:'head'}}})
  const fiber=yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.live==='following')))
  blocks.push(block(1,120));const logs=yield* fixture(blocks).fetchOne({method:'eth_getLogs',params:[{blockHash:blocks[1].hash}]})
  yield* Queue.offer(queue,{block:blocks[1],logs,observedAt:Date.now()})
  yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.applied?.number===1n)))
  expect((yield* instance.read('candles')).find(row=>row.key==='60')).toMatchObject({period:'closed',coverage:'complete',value:{total:0}})
  expect((yield* store.rows(instance.id,'candles')).find(row=>row.key==='60')).toBeDefined()
  yield* Fiber.interrupt(fiber)
 }))
})

test('historical adjacent headers commit an empty minute', async()=>{
 await run(Effect.gen(function*(){
  const blocks=[block(0,0),block(1,120)];const store=memoryModelStore();const options={client:fixture(blocks),store,params:{address:'empty-history'},plan:{history:{from:0n,batchSize:1}}}
  const instance=yield* definition.make(options)
  yield* instance.run()
  expect((yield* instance.read('candles')).find(row=>row.key==='60')).toMatchObject({period:'closed',coverage:'complete',value:{total:0}})
  const empty=(yield* store.rows(instance.id,'candles')).find(row=>row.key==='60')
  yield* store.commit(instance.id,{batches:[],rows:[{...empty,coverage:'partial',value:{open:null,close:null,total:-1}}]})
  const restarted=yield* definition.make(options)
  expect((yield* restarted.read('candles')).find(row=>row.key==='60')).toBeUndefined()
  yield* restarted.run()
  expect((yield* restarted.read('candles')).find(row=>row.key==='60')).toMatchObject({period:'closed',coverage:'complete',value:{total:0}})
 }))
})

test('restart rebuilds a missing complete row and replaces a legacy partial row', async()=>{
 await run(Effect.gen(function*(){
  const store=memoryModelStore();const options={client:fixture(chain()),store,params:{address:'restore-row'},plan:{history:{from:0n,batchSize:16}}}
  const first=yield* definition.make(options);yield* first.run()
  const complete=(yield* store.rows(first.id,'candles')).find(row=>row.key==='0')
  yield* store.commit(first.id,{batches:[],rows:[{...complete,period:'closed',coverage:'partial',value:{open:null,close:null,total:-1}}]})
  yield* store.commit(first.id,{batches:[],rows:[{...complete,key:'999',period:'open',coverage:'partial',value:{open:null,close:null,total:-1}}]})
  const restarted=yield* definition.make(options)
  expect((yield* restarted.read('candles')).some(row=>row.key==='0' || row.key==='999')).toBe(false)
  yield* restarted.run()
  expect((yield* store.rows(first.id,'candles')).find(row=>row.key==='0')).toMatchObject({period:'closed',coverage:'complete',value:{total:15}})
  expect((yield* restarted.read('candles')).find(row=>row.key==='0')).toMatchObject({period:'closed',coverage:'complete',value:{total:15}})
  expect((yield* restarted.read('candles')).find(row=>row.key==='999')).toBeUndefined()
 }))
})

test('live closes the first full minute after startup without history', async()=>{
 await run(Effect.gen(function*(){
  const blocks=[block(0,50)];const queue=yield* Queue.unbounded();const instance=yield* definition.make({client:fixture(blocks,queue),params:{address:'live-close'},plan:{live:{start:'head'}}})
  const fiber=yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.live==='following')))
  for(const next of [block(1,60),block(2,120)]) {
   blocks.push(next);const logs=yield* fixture(blocks).fetchOne({method:'eth_getLogs',params:[{blockHash:next.hash}]})
   yield* Queue.offer(queue,{block:next,logs,observedAt:Date.now()})
   yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.applied?.number===next.number)))
  }
  yield* waitUntil(()=>instance.read('candles').pipe(Effect.map(rows=>rows.some(row=>row.key==='60' && row.period==='closed'))))
  expect((yield* instance.read('candles')).find(row=>row.key==='60')).toMatchObject({period:'closed',coverage:'complete',value:{total:1}})
  yield* Fiber.interrupt(fiber)
 }))
})

test('retention bounds history and preserves the source boundary and reorg window', async()=>{
 await run(Effect.gen(function*(){
  const blocks=Array.from({length:201},(_,i)=>block(i));const store=memoryModelStore();const base=fixture(blocks)
  let blockReads=0
  const client={...base,fetchOne:request=>{
   if(request.method==='eth_getBlockByNumber') blockReads++
   return base.fetchOne(request)
  }}
  const instance=yield* definition.make({client,store,params:{address:'retained'},
   plan:{history:{from:0n,batchSize:32},retention:{blocks:20n,everyBlocks:1}}})
  yield* instance.run()
  expect((yield* instance.status).coverage).toEqual([{from:72n,through:200n}])
  const stored=yield* store.batches(instance.id)
  // Retention keeps the wider 128-block recovery window even though history starts at its boundary block.
  expect(stored[0].block.number).toBe(72n)
  expect(stored.at(-1).block.number).toBe(200n)
  // The timestamp boundary search runs once for the applied canonical head, not once per history batch.
  expect(blockReads).toBeLessThan(155)
 }))
})

test('a slow retention boundary lookup does not block live application', async()=>{
 await run(Effect.gen(function*(){
  const blocks=Array.from({length:201},(_,i)=>block(i));const queue=yield* Queue.unbounded();const base=fixture(blocks,queue)
  let releaseLookup;let enteredLookup
  const gate=new Promise(resolve=>{releaseLookup=resolve});const entered=new Promise(resolve=>{enteredLookup=resolve})
  let held=false
  const client={...base,fetchOne:request=>{
   if(request.method==='eth_getBlockByNumber' && request.params[0]!=='latest' && request.params[0]<200n && !held) {
    held=true;enteredLookup();return Effect.promise(()=>gate).pipe(Effect.andThen(base.fetchOne(request)))
   }
   return base.fetchOne(request)
  }}
  const instance=yield* definition.make({client,params:{address:'retention-live'},plan:{live:{start:'head'},retention:{seconds:50n,everyBlocks:1,everySeconds:1}}})
  const fiber=yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.live==='following')))
  yield* Effect.promise(()=>entered)
  const next=block(201);blocks.push(next);const logs=yield* base.fetchOne({method:'eth_getLogs',params:[{blockHash:next.hash}]})
  yield* Queue.offer(queue,{block:next,logs,observedAt:Date.now()})
  yield* waitUntil(()=>instance.status.pipe(Effect.map(status=>status.applied?.number===201n)))
  releaseLookup()
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
	let gateTransactions=false
 const gate = new Promise(resolve => { releaseTransaction = resolve })
 const entered = new Promise(resolve => { transactionEntered = resolve })
 const connection = {
  exec: (...args) => database.exec(...args),
  query: (...args) => database.query(...args),
  transaction: callback => database.transaction(async tx => {
	 if(!gateTransactions) return callback(tx)
   transactionEntered()
   await gate
   return callback(tx)
  }),
 }
 try {
  await run(Effect.gen(function* () {
   const store = yield* pgliteModelStore(connection)
	 gateTransactions=true
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

for (const direction of ['forward', 'backward']) test(`history reads runtime minute batches between ordered concurrent windows (${direction})`, async () => run(Effect.gen(function* () {
  const blocks = Array.from({length: 31}, (_, i) => block(i, i))
  const base = fixture(blocks)
  let batch = { unit: 'minutes', size: 0.05, bufferSeconds: 0, concurrency: 1 }
  const requests = []
  let active = 0, maximum = 0
  const client = { ...base, config: { network: { chainId: 1n, blockTime: 1000 } },
    fetchOne: request => {
      if (request.method !== 'eth_getLogs') return base.fetchOne(request)
      return Effect.gen(function* () {
        const {fromBlock, toBlock} = request.params[0]
        requests.push([fromBlock, toBlock])
        active++; maximum = Math.max(maximum, active)
        yield* Effect.sleep(fromBlock % 2n === 0n ? 4 : 1)
        active--
        // Simulate a controller changing settings while this window is in flight.
        batch = { unit: 'minutes', size: 0.1, bufferSeconds: 0, concurrency: 2 }
        return yield* base.fetchOne(request)
      })
    },
  }
  const instance = yield* definition.make({client, params: {address: `runtime-${direction}`},
    plan: {history: {from: 0n, through: 30n, direction, batch: () => batch}}})
  yield* instance.run()
  expect(maximum).toBe(2)
  expect(requests[0]).toEqual(direction === 'forward' ? [0n, 2n] : [28n, 30n])
  expect(requests.slice(1, 3)).toEqual(direction === 'forward' ? [[3n, 8n], [9n, 14n]] : [[22n, 27n], [16n, 21n]])
  const covered = requests.flatMap(([from, through]) => Array.from({length: Number(through - from + 1n)}, (_, i) => from + BigInt(i)))
  expect(covered.length).toBe(31)
  expect(new Set(covered).size).toBe(31)
  expect((yield* instance.status).coverage).toEqual([{from: 0n, through: 30n}])
  const candles = yield* instance.read('candles')
  expect(candles.find(row => row.key === '0')?.value).toEqual({open: 0, close: 30, total: 465})
})))

test('minute batches include the buffer and use the network block time', async () => run(Effect.gen(function* () {
  const blocks = Array.from({length: 14}, (_, i) => block(i))
  const base = fixture(blocks), requests = []
  const client = {...base, config: {network: {chainId: 1n, blockTime: 12000}}, fetchOne: request => {
    if (request.method === 'eth_getLogs') requests.push(request.params[0])
    return base.fetchOne(request)
  }}
  const instance = yield* definition.make({client, params: {address: 'buffer'},
    plan: {history: {from: 0n, direction: 'forward', batch: {unit: 'minutes', size: 1}}}})
  yield* instance.run()
  expect(requests.map(r => [r.fromBlock, r.toBlock])).toEqual([[0n, 6n], [7n, 13n]])
})))

test('invalid runtime batch fails before the next request', async () => run(Effect.gen(function* () {
  const base = fixture(chain())
  let size = 3, requests = 0
  const client = {...base, fetchOne: request => {
    if (request.method === 'eth_getLogs') { requests++; size = 0 }
    return base.fetchOne(request)
  }}
  const instance = yield* definition.make({client, params: {address: 'invalid-batch'},
    plan: {history: {from: 0n, batch: () => ({unit: 'blocks', size})}}})
  const result = yield* Effect.result(instance.run())
  expect(result._tag).toBe('Failure')
  expect(result.failure.stage).toBe('definition')
  expect(requests).toBe(1)
})))

test('closing the index cancels all concurrent history requests', async () => run(Effect.gen(function* () {
  const base = fixture(chain())
  let active = 0
  const client = {...base, fetchOne: request => request.method === 'eth_getLogs'
    ? Effect.scoped(Effect.acquireRelease(Effect.sync(() => { active++ }), () => Effect.sync(() => { active-- })).pipe(Effect.andThen(Effect.never)))
    : base.fetchOne(request)}
  const instance = yield* definition.make({client, params: {address: 'cancel-history'},
    plan: {history: {from: 0n, batch: {unit: 'blocks', size: 2, concurrency: 3}}}})
  const worker = yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(() => Effect.succeed(active === 3))
  yield* instance.close()
  yield* Fiber.await(worker)
  expect(active).toBe(0)
})))

test('history yields within a large request window when live head moves ahead', async () => run(Effect.gen(function* () {
  const blocks = Array.from({length: 201}, (_, i) => block(i))
  const live = yield* Queue.unbounded(), heads = yield* Queue.unbounded()
  const base = fixture(blocks, live), storage = memoryModelStore()
  const next = block(201)
  let paused = false, historyHeaders = 0
  const client = {...base, watchBlocks: () => Stream.fromQueue(heads), fetchOne: request => {
    if (request.method === 'eth_getBlockByNumber' && typeof request.params[0] === 'bigint' && request.params[0] < 200n) historyHeaders++
    return base.fetchOne(request)
  }}
  const store = {...storage, commit: (id, commit) => storage.commit(id, commit).pipe(Effect.andThen(Effect.gen(function* () {
    if (!paused && commit.batches.some(batch => batch.block.number < 200n)) {
      paused = true
      blocks.push(next)
      yield* Queue.offer(heads, next)
      yield* Effect.sleep(20)
    }
  })))}
  const instance = yield* definition.make({client, store, params: {address: 'yield-history'}, plan: {
    live: {start: 'head'}, history: {from: 0n, batchSize: 200, maxLiveLagBlocks: 0n},
  }})
  yield* instance.run().pipe(Effect.forkScoped)
  yield* waitUntil(() => instance.status.pipe(Effect.map(status => status.head?.number === 201n)))
  yield* Effect.sleep(60)
  const before = historyHeaders
  yield* Effect.sleep(150)
  expect(historyHeaders).toBe(before)
  const logs = yield* base.fetchOne({method: 'eth_getLogs', params: [{blockHash: next.hash}]})
  yield* Queue.offer(live, {block: next, logs, observedAt: Date.now()})
  yield* waitUntil(() => instance.status.pipe(Effect.map(status => status.applied?.number === 201n)))
  yield* waitUntil(() => Effect.succeed(historyHeaders > before))
})))
