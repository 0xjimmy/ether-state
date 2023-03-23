import { Provider, Contract, BytesLike } from 'ethers'
import { MulticallABI } from './abi'
import { Action, BlockAction, EventAction, TimeAction, Triggers } from './types'

const MULTICALL2_ADDRESS = '0x5ba1e12693dc8f9c48aad8770482f4739beed696'

export class EtherState {
	public blockNumber: bigint

	private provider: Provider
	private multicall: Contract
	// private timeouts: Array<unknown>

	private blockCallback: ((newBlock: number) => Promise<void>) | undefined
	private timeActions: { intervalsIds: ReturnType<typeof setInterval>[], callbacks: (() => Promise<void>)[] } | undefined
	// private eventActions: { event: any; syncs: EventAction[] }[]

	constructor(
		actions: Action[],
		provider: Provider,
		options?: {
			customMulticallAddress?: string,
			populateTimeAndBlock?: boolean
		}
	) {
		this.provider = provider;
		this.multicall = new Contract(
			options && 'customMulticallAddress' in options && options.customMulticallAddress ? options.customMulticallAddress : MULTICALL2_ADDRESS,
			MulticallABI,
			this.provider
		);
		this.blockNumber = 0n

		const blockActions = actions.filter(({ trigger }) => trigger.type === Triggers.BLOCK) as BlockAction[]
		const timeActions = actions.filter(({ trigger }) => trigger.type === Triggers.TIME) as TimeAction[]
		// const eventActions = actions.filter(({ trigger }) => trigger.type === Triggers.EVENT) as EventAction[]

		this.blockCallback = this.setupBlockActions(blockActions)
		this.timeActions = this.setupTimeActions(timeActions)
		// this.eventActions = this.setupEventActions(eventActions)

		// Populate if option selected
		if (options && 'populateTimeAndBlock' in options && options.populateTimeAndBlock) {
			this.update(Triggers.BLOCK)
			this.update(Triggers.TIME)
		}
	}

	private setupBlockActions(actions: BlockAction[]) {
		if (actions.length === 0) return undefined
		const callback = async (newBlock: number) => {
			const blockNumber = BigInt(newBlock)
			if (blockNumber > this.blockNumber) {
				this.blockNumber = blockNumber
				const contractCalls = actions.map((action) => ({
					target: action.call.target(),
					callData: action.call.interface.encodeFunctionData(
						action.call.selector,
						action.input(blockNumber)
					),
				}))
				const [multicallBlock, multicallBlockHash, results]: [bigint, BytesLike, { success: boolean, returnData: BytesLike }[]] = await this.multicall.tryBlockAndAggregate.staticCall(
					false,
					contractCalls
				)
				// Don't update with old data
				if (multicallBlock >= this.blockNumber) {
					results.forEach(({ success, returnData }, index) => {
						if (success) actions[index].output(actions[index].call.interface.decodeFunctionResult(actions[index].call.selector, returnData), multicallBlock, multicallBlockHash)
					})
				}
			}
		}
		this.provider.on('block', callback)
		return callback
	}

	private setupTimeActions(actions: TimeAction[]) {
		if (actions.length === 0) return undefined
		const uniqueIntervals = [...new Set(actions.map(({ trigger }) => trigger.interval))]
		const callbacks: (() => Promise<void>)[] = []
		const intervalsIds = uniqueIntervals.map((interval) => {
			const timeActions = actions.filter(({ trigger }) => trigger.interval === interval)
			const callback = async () => {
				const contractCalls = timeActions.map((action) => ({
					target: action.call.target(),
					callData: action.call.interface.encodeFunctionData(
						action.call.selector,
						action.input(Date.now())
					),
				}))
				const [multicallBlock, multicallBlockHash, results]: [bigint, BytesLike, { success: boolean, returnData: BytesLike }[]] = await this.multicall.tryBlockAndAggregate.staticCall(
					false,
					contractCalls
				)
				results.forEach(({ success, returnData }, index) => {
					if (success) actions[index].output(actions[index].call.interface.decodeFunctionResult(actions[index].call.selector, returnData), multicallBlock, multicallBlockHash)
				})
			}
			callbacks.push(callback)
			return setInterval(callback, interval)
		})
		return { intervalsIds, callbacks }
	}

	// // Event listers
	// if (this.eventSyncs.length > 0) {
	// 	this.eventSyncs.forEach((uniqueEvent) => {
	// 		this.provider.on(uniqueEvent.event, async (log, event) => {
	// 			const contractCalls = uniqueEvent.syncs.map((item) => ({
	// 				target: item.call.target(),
	// 				callData: item.call.interface.encodeFunctionData(
	// 					item.call.selector,
	// 					item.input(log, event)
	// 				),
	// 			}));
	// 			const [blockNumber, , returnData]: [
	// 				bigint,
	// 				null,
	// 				[boolean, BytesLike][]
	// 			] = await this.multicall.tryBlockAndAggregate.staticCall(
	// 				false,
	// 				contractCalls
	// 			);
	// 			if (blockNumber >= this.blockHeight) {
	// 				returnData.forEach((result, index) => {
	// 					if (result[0]) {
	// 						const call = uniqueEvent.syncs[index].call;
	// 						uniqueEvent.syncs[index].output(
	// 							call.interface.decodeFunctionResult(
	// 								call.selector,
	// 								result[1]
	// 							)
	// 						);
	// 					}
	// 				});
	// 			}
	// 		});
	// 	});
	// }
	// }

	// Manual update for any TIME or BLOCK actions states
	async update(type: Triggers.TIME | Triggers.BLOCK) {
		if (type === Triggers.BLOCK && this.blockCallback) {
			const block = await this.provider.getBlockNumber()
			this.blockCallback(block)
		}
		if (type === Triggers.TIME && this.timeActions) this.timeActions.callbacks.forEach(cb => cb())
	}

	// Remove all event listners
	public destroy() {
		this.provider.removeAllListeners()
		if (this.timeActions) this.timeActions.intervalsIds.forEach((id) => clearInterval(id))
	}
}
