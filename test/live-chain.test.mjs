import { expect, test } from 'bun:test'
import { Effect, References, Stream, SubscriptionRef } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { Socket } from 'effect/unstable/socket'
import { EvmClient } from '../src/index.ts'
import { liveChain } from '../src/rpc/live-chain.ts'
const hash = n => '0x' + BigInt(n).toString(16).padStart(64, '0')
const block = (number, fork = 0) => ({number: BigInt(number), hash: hash(number + fork), parentHash: hash(number - 1 + (number > 103 ? fork : 0)), timestamp: BigInt(Math.floor(Date.now()/1000)), logsBloom: '0x' + '00'.repeat(256), source: {endpoint: 'fixture', transport: 'http'}, observedAt: Date.now()})
const until = predicate => Effect.gen(function* () { for(let i=0;i<500;i++){if(predicate())return;yield* Effect.sleep(10)}throw new Error('Timed out') })

for (const receiptsSupported of [true, false]) test(`many consumers share acquisition and reorgs (block receipts: ${receiptsSupported})`, async () => {
 let current=100, fork=0
 const counts=new Map(), events=[]
 const header=n=>{const b=block(n,n>=103?fork:0);return {...b,number:'0x'+n.toString(16),timestamp:'0x'+b.timestamp.toString(16),sha3Uncles:hash(0),miner:'0x'+'00'.repeat(20),stateRoot:hash(0),transactionsRoot:hash(0),receiptsRoot:hash(0),gasLimit:'0x1',gasUsed:'0x0',extraData:'0x',mixHash:hash(0),nonce:'0x0000000000000000',size:'0x1',transactions:[],uncles:[]}}
 const server=Bun.serve({port:0,async fetch(request){const payload=await request.json();const reply=async({id,method,params})=>{
  let result=null
  if(method==='eth_chainId')result='0x1'
  else if(method==='eth_getBlockByNumber'){const n=params[0]==='latest'?current:Number(BigInt(params[0]));if(n<=current){result=header(n);if(params[1])counts.set('full:'+n,(counts.get('full:'+n)??0)+1)}}
  else if(method==='eth_getBlockReceipts'){counts.set('receipts',(counts.get('receipts')??0)+1);if(!receiptsSupported)return {jsonrpc:'2.0',id,error:{code:-32601,message:'unsupported'}};result=[]}
  else if(method==='eth_getLogs'){counts.set('logs',(counts.get('logs')??0)+1);result=[]}
  return {jsonrpc:'2.0',id,result}
 };return Response.json(Array.isArray(payload)?await Promise.all(payload.map(reply)):await reply(payload))}})
 try {await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const client=yield* EvmClient.make({network:{chainId:1n,blockTime:100000},endpoints:{http:[`http://127.0.0.1:${server.port}`],ws:[]},options:{concurrentHttp:1,concurrentWs:0,maxRequestsPerSecond:1000}})
  yield* client.watchChain().pipe(Stream.runForEach(event=>Effect.sync(()=>events.push(event))),Effect.forkScoped)
  const results=Array.from({length:24},()=>[])
  for(const [i,result] of results.entries())yield* (i%2?client.watchFilteredLogBlocks({address:'0x'+i.toString(16).padStart(40,'0')}):client.watchBlocks({full:true})).pipe(Stream.runForEach(value=>Effect.sync(()=>result.push(value.block.number))),Effect.forkScoped)
  yield* client.watchTransactions({from:'0x'+'11'.repeat(20)}).pipe(Stream.runDrain,Effect.forkScoped)
  yield* until(()=>results.every(rows=>rows.includes(100n)))
  current=104
  yield* until(()=>results.every(rows=>rows.includes(104n)))
  for(let n=100;n<=104;n++)expect(counts.get('full:'+n)).toBe(1)
  expect(counts.get('receipts')).toBe(receiptsSupported?5:1);expect(counts.get('logs')??0).toBe(receiptsSupported?0:5)
  expect(events.filter(e=>e.kind==='apply').every(e=>receiptsSupported?Array.isArray(e.value.receipts):e.value.receipts===null)).toBe(true)
  expect((yield* client.fetchOne({method:'eth_getBlockByNumber',params:[104n,true]})).number).toBe(104n)
  if(receiptsSupported)expect((yield* client.fetchOne({method:'eth_getBlockReceipts',params:[hash(104)]}))).toEqual([])
  expect(counts.get('full:104')).toBe(1);expect(counts.get('receipts')).toBe(receiptsSupported?5:1)
  for(const rows of results)expect(rows).toEqual([100n,101n,102n,103n,104n])
  fork=1000
  yield* until(()=>events.some(e=>e.kind==='apply'&&e.value.hash===hash(1104)))
  const revert=events.findIndex(e=>e.kind==='revert')
  expect(events[revert].from).toBe(103n)
  expect(events.slice(revert).map(e=>e.kind==='revert'?'revert':e.value.hash)).toEqual(['revert',hash(1103),hash(1104)])
 })).pipe(Effect.provide([FetchHttpClient.layer,Socket.layerWebSocketConstructorGlobal]),Effect.provideService(References.MinimumLogLevel,'None')))} finally{server.stop(true)}
},12000)

test('a failed block holds publication, retains successful neighbours and recovers in order',async()=>{
 await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const heads=yield* SubscriptionRef.make(block(100));const counts=new Map(),events=[];let allow=false
  const stream=liveChain({heads:SubscriptionRef.changes(heads),header:n=>Effect.succeed(block(Number(n))),recover:work=>work.pipe(Effect.retry({times:50})),load:n=>Effect.suspend(()=>{
   counts.set(n,(counts.get(n)??0)+1)
   return n===101n&&!allow?Effect.sleep(20).pipe(Effect.andThen(Effect.fail({_tag:'BlockUnavailable'}))):Effect.succeed({...block(Number(n)),block:block(Number(n)),logs:[],receipts:[]})
  })})
  yield* stream.pipe(Stream.runForEach(e=>Effect.sync(()=>events.push(e))),Effect.forkScoped)
  yield* until(()=>events.length===1);yield* SubscriptionRef.set(heads,block(104));yield* Effect.sleep(80)
  expect(events.length).toBe(1);expect(counts.get(102n)).toBe(1)
  allow=true;yield* until(()=>events.length===5)
  expect(events.map(e=>e.value.number)).toEqual([100n,101n,102n,103n,104n]);expect(counts.get(102n)).toBe(1)
 })))
})

test('a repeated block hash cannot change height or enter the complete stream', async () => {
 const {Option}=await import('effect')
 const client=Object.create(EvmClient.prototype)
 client.knownHeads=new Map();client.logProgress={error:null};client.head=await Effect.runPromise(SubscriptionRef.make(Option.none()))
 const first=block(100)
 await Effect.runPromise(client.observe(first))
 await Effect.runPromise(client.observe({...first,number:101n}))
 expect((await Effect.runPromise(SubscriptionRef.get(client.head))).value.number).toBe(100n)
 expect(client.knownHeads.get(first.hash).number).toBe(100n)
 expect(client.logProgress.error).toContain('different heights')
 client.fetchPhysical=()=>Effect.succeed({...first,number:101n,transactions:[]})
 const result=await Effect.runPromise(client.loadLiveBlock(101n).pipe(Effect.result))
 expect(result._tag).toBe('Failure')
})

test('receipt validation rejects missing, duplicate and unordered log indices', async () => {
 const {orderedReceipts}=await import('../src/rpc/live.ts')
 const h=block(100), tx=hash(999), b={...h,transactions:[tx]}
 const log=index=>({blockHash:h.hash,blockNumber:h.number,transactionHash:tx,transactionIndex:0n,logIndex:index,address:'0xabc',data:'0x',topics:[]})
 const receipt=logs=>({blockHash:h.hash,blockNumber:h.number,transactionHash:tx,transactionIndex:0n,logs})
 expect(orderedReceipts(b,[receipt([log(0n),log(1n)])])).toBeDefined()
 for(const indices of [[1n],[0n,0n],[1n,0n]])expect(orderedReceipts(b,[receipt(indices.map(log))])).toBeUndefined()
})
