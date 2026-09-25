import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Effect, Stream } from 'effect'
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

test('viem eth_call requests use the EvmClient call path', async () => {
  const calls = []
  const client = {
    isClosed: false,
    call(read) { calls.push(read); return Effect.succeed('0x1234') },
    fetch() { throw new Error('eth_call must not use fetch directly') },
  }
  const result = await viemTransport(client)().request({
    method: 'eth_call',
    params: [{ to: `0x${'11'.repeat(20)}`, data: '0xabcdef' }, 'latest'],
  })
  assert.equal(result, '0x1234')
  assert.deepEqual(calls, [{ transaction: { to: `0x${'11'.repeat(20)}`, data: '0xabcdef' }, block: 'latest' }])
})

test('viem newHeads subscriptions use complete shared blocks without fetching again', async () => {
  const hash = value => `0x${value.repeat(64)}`
  const address = `0x${'11'.repeat(20)}`
  const block = number => ({
    hash: hash('1'), parentHash: hash('2'), sha3Uncles: hash('3'), miner: address,
    stateRoot: hash('4'), transactionsRoot: hash('5'), receiptsRoot: hash('6'), logsBloom: '0x00',
    number, gasLimit: 30_000_000n, gasUsed: 1n, timestamp: number, extraData: '0x', mixHash: hash('7'),
    nonce: '0x0000000000000000', size: 1n, transactions: [], uncles: [],
  })
  const fetched = []
  const client = {
    isClosed: false,
    watchBlocks: () => Stream.fromIterable([10n,11n,12n,13n].map(number => ({block:block(number)}))),
    fetch(request) { fetched.push(request); return Effect.succeed(block(request.params[0])) },
  }
  const numbers = []
  await new Promise(async (resolve, reject) => {
    await viemTransport(client)().value.subscribe({
      params: ['newHeads'],
      onData({ result }) {
        numbers.push(result.number)
        if (numbers.length === 4) resolve()
      },
      onError: reject,
    })
  })
  assert.deepEqual(numbers, ['0xa', '0xb', '0xc', '0xd'])
  assert.deepEqual(fetched, [])
})


test('viem log subscriptions filter the shared stream and emit removed logs on reverts', async () => {
 const address='0x'+'11'.repeat(20), hash=n=>'0x'+n.toString(16).padStart(64,'0')
 const log=(number,h)=>({address,topics:[hash(1)],data:'0x',transactionHash:hash(99),transactionIndex:0n,logIndex:0n,blockNumber:number,blockHash:h,removed:false})
 const client={isClosed:false,fetch:()=>{throw new Error('Subscription must not fetch')},watchChain:()=>Stream.fromIterable([
  {kind:'apply',value:{number:10n,logs:[log(10n,hash(10))]}},
  {kind:'revert',from:10n},
  {kind:'apply',value:{number:10n,logs:[log(10n,hash(110))]}},
 ])}
 const values=[]
 await new Promise(async(resolve,reject)=>{await viemTransport(client)().value.subscribe({params:['logs',{address}],onData:({result})=>{values.push(result);if(values.length===3)resolve()},onError:reject})})
 assert.deepEqual(values.map(value=>[value.blockHash,value.removed]),[[hash(10),false],[hash(10),true],[hash(110),false]])
})
