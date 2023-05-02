import { Result, Log, BytesLike, Interface, EventFilter } from 'ethers'

export enum TriggerType {
	BLOCK,
	EVENT,
	TIME,
}

export type BlockTrigger = { type: TriggerType.BLOCK }
export type TimeTrigger = { type: TriggerType.TIME, interval: number }
export type EventTrigger = { type: TriggerType.EVENT, eventFilter: EventFilter }

export type Trigger = BlockTrigger | EventTrigger | TimeTrigger

export type ContractCall = {
	target: () => string
	interface: Interface
	selector: string
}

export type BlockAction = {
	trigger: BlockTrigger
	input: (blockNumber: bigint) => Array<bigint | BytesLike | boolean>
	call: ContractCall
	output: (returnValues: Result, blockNumber: bigint) => unknown
}

export type TimeAction = {
	trigger: TimeTrigger
	input: (currentTime: number) => Array<bigint | BytesLike | boolean>
	call: ContractCall
	output: (returnValues: Result, blockNumber: bigint) => unknown
}

export type EventAction = {
	trigger: EventTrigger
	input: (log: Log, blockNumber: bigint) => Array<bigint | BytesLike | boolean>
	call: ContractCall
	output: (returnValues: Result, blockNumber: bigint) => unknown
}

export type Action = BlockAction | TimeAction | EventAction
