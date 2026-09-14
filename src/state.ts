import type { Log } from 'ethers'
import { Contract } from 'ethers'
import type { Provider } from 'ethers'
import { readMulticall } from './multicall.js'
import { MulticallABI } from './abi.js'
import type { Action, BlockAction, EventAction, TimeAction } from './types.js'
import { TriggerType } from './types.js'

const MULTICALL2_ADDRESS = '0x5ba1e12693dc8f9c48aad8770482f4739beed696'

export class EtherState {
	public blockNumber: bigint

	private provider: Provider
	private multicall: Contract

	private blockCallback: ((newBlock: number) => Promise<void>) | undefined
	private timeActions: { intervalsIds: ReturnType<typeof setInterval>[], callbacks: (() => Promise<void>)[] } | undefined

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

		const blockActions = actions.filter((action): action is BlockAction => action.trigger.type === TriggerType.BLOCK)
		const timeActions = actions.filter((action): action is TimeAction => action.trigger.type === TriggerType.TIME)
		const eventActions = actions.filter((action): action is EventAction => action.trigger.type === TriggerType.EVENT)

		this.blockCallback = this.setupBlockActions(blockActions)
		this.timeActions = this.setupTimeActions(timeActions)
		this.setupEventActions(eventActions)

		// Populate if option selected
		if (options && 'populateTimeAndBlock' in options && options.populateTimeAndBlock) {
			void this.update(TriggerType.BLOCK)
			void this.update(TriggerType.TIME)
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
				const { blockNumber: multicallBlock, results } = await readMulticall(this.multicall, contractCalls)
				// Don't update with old data
				if (multicallBlock >= this.blockNumber) {
					results.forEach(({ success, returnData }, index) => {
						const action = actions[index]
						if (success && action !== undefined) action.output(action.call.interface.decodeFunctionResult(action.call.selector, returnData), multicallBlock)
					})
				}
			}
		}
		void this.provider.on('block', (newBlock: number) => { void callback(newBlock) })
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
				const { blockNumber: multicallBlock, results } = await readMulticall(this.multicall, contractCalls)
				results.forEach(({ success, returnData }, index) => {
					const action = timeActions[index]
					if (success && action !== undefined) action.output(action.call.interface.decodeFunctionResult(action.call.selector, returnData), multicallBlock)
				})
			}
			callbacks.push(callback)
			return setInterval(() => { void callback() }, interval)
		})
		return { intervalsIds, callbacks }
	}

	private setupEventActions(actions: EventAction[]) {
		if (actions.length === 0) return undefined
		const uniqueStringifiedEvents = [...new Set(actions.map(({ trigger }) => JSON.stringify(trigger.eventFilter)))]
		uniqueStringifiedEvents.forEach((stringifiedEvent) => {
			const matchingActions = actions.filter(({ trigger }) => JSON.stringify(trigger.eventFilter) === stringifiedEvent)
			const firstAction = matchingActions[0]
			if (firstAction === undefined) return
			const eventFilter = firstAction.trigger.eventFilter
			const callback = async (log: Log) => {
				const contractCalls = matchingActions.map((action) => ({
					target: action.call.target(),
					callData: action.call.interface.encodeFunctionData(
						action.call.selector,
						action.input(log, BigInt(log.blockNumber))
					)
				}))
				const { blockNumber: multicallBlock, results } = await readMulticall(this.multicall, contractCalls)
				results.forEach(({ success, returnData }, index) => {
					const action = matchingActions[index]
					if (success && action !== undefined) action.output(action.call.interface.decodeFunctionResult(action.call.selector, returnData), multicallBlock, log)
				})
			}
			void this.provider.on(eventFilter, (log: Log) => { void callback(log) })
		})
	}

	// Manual update for any TIME or BLOCK actions states
	async update(type: TriggerType.TIME | TriggerType.BLOCK): Promise<void> {
		if (type === TriggerType.BLOCK && this.blockCallback) {
			const block = await this.provider.getBlockNumber()
			await this.blockCallback(block)
		}
		if (type === TriggerType.TIME && this.timeActions) await Promise.all(this.timeActions.callbacks.map(cb => cb()))
	}

	// Remove all event listners
	public destroy(): void {
		void this.provider.removeAllListeners()
		if (this.timeActions) this.timeActions.intervalsIds.forEach((id) => { clearInterval(id); })
	}
}
