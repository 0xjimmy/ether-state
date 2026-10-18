import { expect, test } from 'bun:test'
import { Deferred, Effect, Fiber, Stream } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'
import { Socket } from 'effect/unstable/socket'
import { EvmClient } from '../src/index.ts'
import { ethHttpRpc } from '../src/rpc/transport/http.ts'
import { makeWsState } from '../src/rpc/transport/ws.ts'
import { viemTransport } from '../src/viem.ts'
const hash = '0x' + '11'.repeat(32)
const header = { number:'0x64',hash,parentHash:hash,timestamp:'0x1',logsBloom:'0x'+'00'.repeat(256),sha3Uncles:hash,miner:'0x'+'00'.repeat(20),stateRoot:hash,transactionsRoot:hash,receiptsRoot:hash,gasLimit:'0x1',gasUsed:'0x0',extraData:'0x',mixHash:hash,nonce:'0x0000000000000000',size:'0x1',transactions:[],uncles:[] }
const until = predicate => Effect.gen(function*(){for(let i=0;i<200;i++){if(predicate())return;yield* Effect.sleep(5)}throw Error('Timed out')})
test('raw send checks its guard after endpoint cooldown; decline and throw send no bytes',async()=>{
 let sends=0
 const server=Bun.serve({port:0,async fetch(req){const payload=await req.json();const reply=({id,method})=>{if(method==='eth_sendRawTransaction')sends++;return {jsonrpc:'2.0',id,result:method==='eth_chainId'?'0x1':method==='eth_sendRawTransaction'?hash:header}};return Response.json(Array.isArray(payload)?payload.map(reply):reply(payload))}})
 const endpoint=`http://127.0.0.1:${server.port}`
 try{await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const client=yield* EvmClient.make({network:{chainId:1n,blockTime:100000},endpoints:{http:[endpoint],ws:[]},options:{concurrentHttp:1,concurrentWs:0,maxRequestsPerSecond:1000}})
  let current=true,checks=0
  client.retryAt.set(endpoint,Date.now()+100)
  const queued=yield* client.sendRawTransaction('0x01',{beforeDispatch:()=>{checks++;return current?'approve':'decline'}}).pipe(Effect.result,Effect.forkScoped)
  yield* Effect.sleep(20);expect(checks).toBe(0);current=false
  const result=yield* Fiber.join(queued)
  expect(result._tag).toBe('Failure');expect(result.failure._tag).toBe('DispatchDeclined');expect(sends).toBe(0)
  const thrown=yield* client.sendRawTransaction('0x01',{beforeDispatch:()=>{throw Error('invalid')}}).pipe(Effect.result)
  expect(thrown.failure._tag).toBe('DispatchDeclined');expect(sends).toBe(0)
  expect(yield* client.sendRawTransaction('0x01',{beforeDispatch:()=> 'approve'})).toBe(hash);expect(sends).toBe(1)
 })).pipe(Effect.provide([FetchHttpClient.layer,Socket.layerWebSocketConstructorGlobal])))}finally{server.stop(true)}
})
test('WebSocket guard runs at native send and does not queue a declined request',async()=>{
 let sends=0
 const server=Bun.serve({port:0,fetch(req,server){if(server.upgrade(req))return;return new Response('bad',{status:400})},websocket:{message(ws,raw){sends++;const req=JSON.parse(raw);ws.send(JSON.stringify({jsonrpc:'2.0',id:req.id,result:hash}))}}})
 try{await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const state=yield* makeWsState({endpoint:`ws://127.0.0.1:${server.port}`})
  yield* state.connections.pipe(Stream.filter(s=>s._tag==='Connected'),Stream.take(1),Stream.runDrain)
  const declined=yield* state.request({method:'eth_sendRawTransaction',inputParams:['0x01'],beforeDispatch:()=> 'decline'}).pipe(Effect.result)
  expect(declined.failure._tag).toBe('DispatchDeclined');expect(sends).toBe(0)
  expect(yield* state.request({method:'eth_sendRawTransaction',inputParams:['0x01'],beforeDispatch:()=> 'approve'})).toBe(hash);expect(sends).toBe(1)
 })).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)))}finally{server.stop(true)}
})
test('viem forwards the raw-send guard without using it for reads',async()=>{
 const guard=()=> 'decline';let seen
 const client={isClosed:false,sendRawTransaction(raw,options){seen=options.beforeDispatch;return Effect.succeed(hash)},fetch(){return Effect.succeed(1n)}}
 const transport=viemTransport(client,{beforeDispatch:guard})()
 expect(await transport.request({method:'eth_sendRawTransaction',params:['0x01']})).toBe(hash);expect(seen).toBe(guard)
 expect(await transport.request({method:'eth_chainId',params:[]})).toBe('0x1')
})

test('HTTP middleware delay rechecks the guard at fetch and sends no bytes',async()=>{
 let sends=0,current=true,waiting=false
 const server=Bun.serve({port:0,async fetch(req){sends++;const {id}=await req.json();return Response.json({jsonrpc:'2.0',id,result:hash})}})
 try{await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const base=yield* HttpClient.HttpClient,gate=yield* Deferred.make()
  const delayed=HttpClient.transformResponse(base,response=>Effect.sync(()=>{waiting=true}).pipe(Effect.andThen(Deferred.await(gate)),Effect.andThen(response)))
  const pending=yield* ethHttpRpc({endpoint:`http://127.0.0.1:${server.port}`,method:'eth_sendRawTransaction',inputParams:['0x01'],beforeDispatch:()=>current?'approve':'decline'}).pipe(Effect.provideService(HttpClient.HttpClient,delayed),Effect.result,Effect.forkScoped)
  yield* until(()=>waiting);current=false;yield* Deferred.succeed(gate,undefined)
  const result=yield* Fiber.join(pending);expect(result.failure._tag).toBe('DispatchDeclined');expect(sends).toBe(0)
 })).pipe(Effect.provide(FetchHttpClient.layer)))}finally{server.stop(true)}
})

test('a clean WebSocket close rejects an in-flight raw send without waiting for its timeout',async()=>{
 const server=Bun.serve({port:0,fetch(req,server){if(server.upgrade(req))return;return new Response('bad',{status:400})},websocket:{message(ws){ws.close(1000)}}})
 try{await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const state=yield* makeWsState({endpoint:`ws://127.0.0.1:${server.port}`,requestTimeout:2000})
  yield* state.connections.pipe(Stream.filter(s=>s._tag==='Connected'),Stream.take(1),Stream.runDrain)
  const result=yield* state.request({method:'eth_sendRawTransaction',inputParams:['0x01'],beforeDispatch:()=> 'approve'}).pipe(Effect.result,Effect.timeout(500))
  expect(result.failure._tag).toBe('SocketError')
 })).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)))}finally{server.stop(true)}
})

test('one possible send plus a declined endpoint remains an uncertain failure',async()=>{
 let sends=0
 const server=Bun.serve({port:0,async fetch(req){const body=await req.json();if(body.method==='eth_sendRawTransaction'){sends++;return new Response('response lost',{status:500})}return Response.json({jsonrpc:'2.0',id:body.id,result:body.method==='eth_chainId'?'0x1':header})}})
 const first=`http://127.0.0.1:${server.port}/first`,second=`http://127.0.0.1:${server.port}/second`
 try{await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const client=yield* EvmClient.make({network:{chainId:1n,blockTime:100000},endpoints:{http:[first,second],ws:[]},options:{concurrentHttp:2,concurrentWs:0,maxRequestsPerSecond:1000}})
  client.retryAt.set(second,Date.now()+100)
  const result=yield* client.sendRawTransaction('0x01',{beforeDispatch:()=>sends?'decline':'approve'}).pipe(Effect.result)
  expect(sends).toBe(1);expect(result.failure._tag).toBe('BlockUnavailable')
 })).pipe(Effect.provide([FetchHttpClient.layer,Socket.layerWebSocketConstructorGlobal])))}finally{server.stop(true)}
})
