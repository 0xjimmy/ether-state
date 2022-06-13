import { BigNumber, Contract, providers } from "ethers"
import { BytesLike, Interface } from "ethers/lib/utils"
import multicallABI from './Multicall2.json'

/** @ignore */
const IMulticall = new Interface(multicallABI)

export enum Trigger {
  BLOCK,
  EVENT,
  TIME
}

export type ContractCall = {
  target: () => string,
  interface: Interface,
  selector: string
}

export type StateSync = {
  trigger: Trigger,
  triggerValue?: any
  input: Function,
  call: ContractCall,
  output: Function
}

export class Sync {
  provider: providers.Provider | providers.JsonRpcProvider | providers.WebSocketProvider | providers.Web3Provider
  multicall: Contract
  blockHeight: BigNumber

  blockSyncs: StateSync[]
  timeSyncs: { timeout: number, syncs: StateSync[] }[]
  eventSyncs: { event: any, syncs: StateSync[] }[]

  timeouts = []

  constructor(syncs: StateSync[], provider: providers.Provider | providers.JsonRpcProvider | providers.WebSocketProvider | providers.Web3Provider) {
    // Set state
    this.provider = provider
    this.multicall = new Contract('0x5ba1e12693dc8f9c48aad8770482f4739beed696', IMulticall, this.provider)
    this.blockHeight = BigNumber.from(0)
    this.blockSyncs = syncs.filter((sync) => sync.trigger === Trigger.BLOCK)

    const timeFiltered = syncs.filter((sync) => sync.trigger === Trigger.TIME)
    const uniqueTimeouts = new Set(timeFiltered.map(sync => sync.triggerValue))
    this.timeSyncs = [...uniqueTimeouts].map((timeout: number) => ({ timeout, syncs: timeFiltered.filter(sync => sync.triggerValue === timeout) }))

    const eventFiltered = syncs.filter((sync) => sync.trigger === Trigger.EVENT)
    const uniqueEvents = new Set(eventFiltered.map(sync => JSON.stringify(sync.triggerValue)))
    this.eventSyncs = [...uniqueEvents].map((stringifiedEvent: string) => {
      const matchingSyncs = eventFiltered.filter((sync) => JSON.stringify(sync.triggerValue) === stringifiedEvent)
      return { event: matchingSyncs[0].triggerValue, syncs: matchingSyncs }
    })

    // ## LISTNERS

    // BLOCK listener
    this.provider.on('block', async (_blockHeight: number) => {
      const blockHeight = BigNumber.from(_blockHeight)
      if (blockHeight.gt(this.blockHeight)) {
        this.blockHeight = blockHeight
        if (this.blockSyncs.length > 0) {
          const contractCalls = this.blockSyncs.map((item) => ({ target: item.call.target(), callData: item.call.interface.encodeFunctionData(item.call.selector, item.input(blockHeight)) }))
          const [blockNumber, _, returnData]: [BigNumber, null, [boolean, BytesLike]] = await this.multicall.callStatic.tryBlockAndAggregate(false, contractCalls)
          if (blockNumber.gte(this.blockHeight)) {
            returnData.forEach((result, index) => {
              if (result[0]) {
                const call = this.blockSyncs[index].call
                this.blockSyncs[index].output(call.interface.decodeFunctionResult(call.selector, result[1]))
              }
            })
          }
        }
      }
    })
    // Populate block calls straight away
    if (this.blockSyncs.length > 0) {
      const contractCalls = this.blockSyncs.map((item) => ({ target: item.call.target(), callData: item.call.interface.encodeFunctionData(item.call.selector, item.input(BigNumber.from(0))) }));
      this.multicall.callStatic.tryBlockAndAggregate(false, contractCalls).then((result) => {
        const [blockNumber, _, returnData]: [BigNumber, null, [boolean, BytesLike]] = result;
        if (blockNumber.gte(this.blockHeight)) {
          returnData.forEach((result, index) => {
            if (result[0]) {
              const call = this.blockSyncs[index].call;
              this.blockSyncs[index].output(call.interface.decodeFunctionResult(call.selector, result[1]));
            }
          })
        }
      })
    }

    // TIME listners
    if (this.timeSyncs.length > 0) {
      this.timeouts = this.timeSyncs.map(uniqueTime => {
        setInterval(async () => {
          const contractCalls = uniqueTime.syncs.map((item) => ({ target: item.call.target(), callData: item.call.interface.encodeFunctionData(item.call.selector, item.input()) }))
          const [blockNumber, _, returnData]: [BigNumber, null, [boolean, BytesLike]] = await this.multicall.callStatic.tryBlockAndAggregate(false, contractCalls)
          if (blockNumber.gte(this.blockHeight)) {
            returnData.forEach((result, index) => {
              if (result[0]) {
                const call = uniqueTime.syncs[index].call
                uniqueTime.syncs[index].output(call.interface.decodeFunctionResult(call.selector, result[1]))
              }
            })
          }
        }, uniqueTime.timeout)
      })
    }

    // EVENT listers
    if (this.eventSyncs.length > 0) {
      this.eventSyncs.forEach(uniqueEvent => {
        this.provider.on(uniqueEvent.event, async (log, event) => {
          const contractCalls = uniqueEvent.syncs.map((item) => ({ target: item.call.target(), callData: item.call.interface.encodeFunctionData(item.call.selector, item.input(log, event)) }))
          const [blockNumber, _, returnData]: [BigNumber, null, [boolean, BytesLike]] = await this.multicall.callStatic.tryBlockAndAggregate(false, contractCalls)
          if (blockNumber.gte(this.blockHeight)) {
            returnData.forEach((result, index) => {
              if (result[0]) {
                const call = uniqueEvent.syncs[index].call
                uniqueEvent.syncs[index].output(call.interface.decodeFunctionResult(call.selector, result[1]))
              }
            })
          }
        })
      })
    }
  }

  // Trigger update for any TIME or BLOCK triggered states
  async pushUpdate(trigger: Trigger.TIME | Trigger.BLOCK) {
    if (trigger === Trigger.BLOCK) {
      if (this.blockSyncs.length > 0) {
        const contractCalls = this.blockSyncs.map((item) => ({ target: item.call.target(), callData: item.call.interface.encodeFunctionData(item.call.selector, item.input(this.blockHeight)) }))
        const [blockNumber, _, returnData]: [BigNumber, null, [boolean, BytesLike]] = await this.multicall.callStatic.tryBlockAndAggregate(false, contractCalls)
        if (blockNumber.gte(this.blockHeight)) {
          returnData.forEach((result, index) => {
            if (result[0]) {
              const call = this.blockSyncs[index].call
              this.blockSyncs[index].output(call.interface.decodeFunctionResult(call.selector, result[1]))
            }
          })
        }
      }
    } else {
      const syncs = this.timeSyncs.map((x) => x.syncs).flat()
      const contractCalls = syncs.map((item) => ({ target: item.call.target(), callData: item.call.interface.encodeFunctionData(item.call.selector, item.input()) }))
      const [blockNumber, _, returnData]: [BigNumber, null, [boolean, BytesLike]] = await this.multicall.callStatic.tryBlockAndAggregate(false, contractCalls)
      if (blockNumber.gte(this.blockHeight)) {
        returnData.forEach((result, index) => {
          if (result[0]) {
            const call = syncs[index].call
            syncs[index].output(call.interface.decodeFunctionResult(call.selector, result[1]))
          }
        })
      }
    }
  }

  // Remove all event listners
  destroy() {
    this.provider.removeAllListeners()
    this.timeouts.forEach(id => clearInterval(id))
  }
}

