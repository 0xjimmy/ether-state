import { BytesLike, Interface } from 'ethers'

export enum Triggers {
	BLOCK,
	EVENT,
	TIME,
}

export type ContractCall = {
	target: () => string
	interface: Interface
	selector: string
}

export type BlockAction = {
	trigger: { type: Triggers.BLOCK }
	input: (blockNumber: bigint) => Array<bigint | BytesLike | boolean>
	call: ContractCall
	output: (returnValues: unknown[], blockNumber: bigint, blockHash: BytesLike) => unknown
}

export type TimeAction = {
	trigger: { type: Triggers.TIME, interval: number }
	input: (currentTime: number) => Array<bigint | BytesLike | boolean>
	call: ContractCall
	output: (returnValues: unknown[], blockNumber: bigint, blockHash: BytesLike) => unknown
}

export type EventAction = {
	trigger: { type: Triggers.EVENT, eventFilter: string }
	input: (blockNumber: bigint, eventParams: unknown[]) => Array<bigint | BytesLike | boolean>
	call: ContractCall
	output: (returnValues: unknown[], blockNumber: bigint, blockHash: BytesLike) => unknown
}

export type Action = BlockAction | TimeAction | EventAction
