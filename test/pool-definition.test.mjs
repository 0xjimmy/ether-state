import { test, expect } from 'bun:test'
import { Effect, Queue, Stream } from 'effect'
import { Interface } from 'ethers'
import { PoolIndex } from '../examples/indexer/pool-definition.ts'
const pool='0x0000000000000000000000000000000000000010'
const actor='0x0000000000000000000000000000000000000020'
const hash=n=>`0x${n.toString(16).padStart(64,'0')}`
const abi=new Interface([
 'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
 'function liquidity() view returns (uint128)',
 'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
])
const makeBlock=n=>({number:BigInt(n),hash:hash(n),parentHash:hash(n-1),timestamp:BigInt(n*10),logsBloom:'0x'})
const log=(block,amount0,amount1,price)=>{
 const event=abi.encodeEventLog(abi.getEvent('Swap'),[actor,actor,amount0,amount1,price,1000n,0])
 return {...event,address:pool,blockHash:block.hash,blockNumber:block.number,transactionHash:hash(100+Number(block.number)),transactionIndex:0n,logIndex:0n}
}
test('pool example builds ordered OHLC and absolute raw volume from backward history',async()=>{
 await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const blocks=[0,1,2,3,4,5,6].map(makeBlock)
  const logs=[log(blocks[1],100n,-90n,1000n),log(blocks[2],-30n,40n,1500n),log(blocks[5],50n,-60n,800n)]
  const client={config:{network:{chainId:1n}},watchBlocks:()=>Stream.never,watchLogBlocks:()=>Stream.never,
   call:({transaction})=>Effect.succeed(transaction.data===abi.encodeFunctionData('slot0')?abi.encodeFunctionResult('slot0',[800n,0,0,0,0,0,true]):abi.encodeFunctionResult('liquidity',[1000n])),
   fetchOne:({method,params})=>Effect.succeed(method==='eth_getLogs'?logs.filter(log=>log.blockHash===params[0].blockHash):params[0]==='latest'?blocks.at(-1):blocks.find(block=>block.number===params[0])??null),
  }
  const instance=yield* PoolIndex.make({client,params:{address:pool},plan:{history:{from:0n,batchSize:2}}})
  yield* instance.run()
  const candle=(yield* instance.read('candles')).find(row=>row.key==='0')
  expect(candle.value).toEqual({open:1000n,high:1500n,low:800n,close:800n,volume0:180n,volume1:190n,swaps:3})
  expect(candle.period).toBe('closed')
  expect(candle.coverage).toBe('complete')
  expect((yield* instance.read('current'))[0].value.sqrtPriceX96).toBe(800n)
 })))
})

test('creation discovery falls back from unsupported archive state and splits only range limits', async()=>{
 const { findPoolCreation } = await import('../examples/indexer/pool-definition.ts')
 const metadata=new Interface(['function factory() view returns(address)','function token0() view returns(address)','function token1() view returns(address)','function fee() view returns(uint24)'])
 const factory=new Interface(['event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)'])
 const creation=makeBlock(2)
 const encoded=factory.encodeEventLog(factory.getEvent('PoolCreated'),[actor,pool,3000,60,pool])
 const requests=[]
 const client={
  getBlock:()=>Effect.succeed(makeBlock(12)),
  call:({transaction})=>Effect.sync(()=>{const name=metadata.parseTransaction({data:transaction.data}).name;return metadata.encodeFunctionResult(name,[name==='fee'?3000: name==='token1'?pool:actor])}),
  fetchOne:(request)=>{
   requests.push(request)
   if(request.method==='eth_getCode') return Effect.fail({_tag:'RpcError',code:-32000,message:'unsupported block number'})
   if(request.method==='eth_getBlockByNumber') return Effect.succeed(creation)
   const filter=request.params[0]
   if(filter.toBlock-filter.fromBlock+1n>4n) return Effect.fail({_tag:'RpcError',code:-32602,message:'block range too large'})
   return Effect.succeed(filter.fromBlock<=2n&&filter.toBlock>=2n?[{...encoded,blockNumber:2n,blockHash:creation.hash,transactionHash:hash(1002)}]:[])
  },
 }
 const result=await Effect.runPromise(findPoolCreation(client,pool))
 expect(result.hash).toBe(creation.hash)
 expect(requests.filter(r=>r.method==='eth_getCode')).toHaveLength(1)
 expect(requests.filter(r=>r.method==='eth_getLogs').length).toBeLessThan(8)
 const limited={...client,fetchOne:request=>request.method==='eth_getLogs'?Effect.fail({_tag:'RpcError',code:-32005,message:'rate limit exceeded'}):client.fetchOne(request)}
 const failure=await Effect.runPromise(Effect.flip(findPoolCreation(limited,pool)))
 expect(failure.message).toBe('rate limit exceeded')
})
