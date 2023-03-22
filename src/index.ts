import { Provider, Contract, BytesLike, Interface } from 'ethers';
import { MulticallABI } from './abi';

export enum Trigger {
	BLOCK,
	EVENT,
	TIME,
}

export type ContractCall = {
	target: () => string;
	interface: Interface;
	selector: string;
};

export type StateSync = {
	trigger: Trigger;
	triggerValue?: any;
	input: Function;
	call: ContractCall;
	output: Function;
};

export class Sync {
	public provider: Provider
	private multicall: Contract;
	private blockHeight: BigInt;

	private blockSyncs: StateSync[];
	private timeSyncs: { timeout: number; syncs: StateSync[] }[];
	private eventSyncs: { event: any; syncs: StateSync[] }[];

	timeouts: NodeJS.Timer[];

	constructor(
		syncs: StateSync[],
		provider: Provider
	) {
		// Set state
		this.timeouts = [];
		this.provider = provider;
		this.multicall = new Contract(
			'0x5ba1e12693dc8f9c48aad8770482f4739beed696',
			MulticallABI,
			this.provider
		);
		this.blockHeight = 0n;
		this.blockSyncs = syncs.filter(
			(sync) => sync.trigger === Trigger.BLOCK
		);

		const timeFiltered = syncs.filter(
			(sync) => sync.trigger === Trigger.TIME
		);
		const uniqueTimeouts = new Set(
			timeFiltered.map((sync) => sync.triggerValue)
		);
		this.timeSyncs = [...uniqueTimeouts].map((timeout: number) => ({
			timeout,
			syncs: timeFiltered.filter((sync) => sync.triggerValue === timeout),
		}));

		const eventFiltered = syncs.filter(
			(sync) => sync.trigger === Trigger.EVENT
		);
		const uniqueEvents = new Set(
			eventFiltered.map((sync) => JSON.stringify(sync.triggerValue))
		);
		this.eventSyncs = [...uniqueEvents].map((stringifiedEvent: string) => {
			const matchingSyncs = eventFiltered.filter(
				(sync) => JSON.stringify(sync.triggerValue) === stringifiedEvent
			);
			return {
				event: matchingSyncs[0].triggerValue,
				syncs: matchingSyncs,
			};
		});

		// ## LISTNERS

		// Block listener
		this.provider.on('block', async (_blockHeight: number) => {
			const blockHeight = BigInt(_blockHeight);
			if (blockHeight > this.blockHeight) {
				this.blockHeight = blockHeight;
				if (this.blockSyncs.length > 0) {
					const contractCalls = this.blockSyncs.map((item) => ({
						target: item.call.target(),
						callData: item.call.interface.encodeFunctionData(
							item.call.selector,
							item.input(blockHeight)
						),
					}));
					const [blockNumber, , returnData]: [
						BigInt,
						null,
						[boolean, BytesLike][]
					] = await this.multicall.tryBlockAndAggregate.staticCall(
						false,
						contractCalls
					);
					if (blockNumber >= this.blockHeight) {
						returnData.forEach((result, index) => {
							if (result[0]) {
								const call = this.blockSyncs[index].call;
								this.blockSyncs[index].output(
									call.interface.decodeFunctionResult(
										call.selector,
										result[1]
									)
								);
							}
						});
					}
				}
			}
		});
		// Populate block calls straight away
		if (this.blockSyncs.length > 0) {
			const contractCalls = this.blockSyncs.map((item) => ({
				target: item.call.target(),
				callData: item.call.interface.encodeFunctionData(
					item.call.selector,
					item.input(0n)
				),
			}));
			this.multicall.tryBlockAndAggregate.staticCall(false, contractCalls)
				.then((result) => {
					const [blockNumber, , returnData]: [
						BigInt,
						null,
						[boolean, BytesLike][]
					] = result;
					if (blockNumber >= this.blockHeight) {
						returnData.forEach((result, index) => {
							if (result[0]) {
								const call = this.blockSyncs[index].call;
								this.blockSyncs[index].output(
									call.interface.decodeFunctionResult(
										call.selector,
										result[1]
									)
								);
							}
						});
					}
				});
		}

		// Time listners
		if (this.timeSyncs.length > 0) {
			this.timeouts = this.timeSyncs.map((uniqueTime) => {
				return setInterval(async () => {
					const contractCalls = uniqueTime.syncs.map((item) => ({
						target: item.call.target(),
						callData: item.call.interface.encodeFunctionData(
							item.call.selector,
							item.input()
						),
					}));
					const [blockNumber, , returnData]: [
						BigInt,
						null,
						[boolean, BytesLike][]
					] = await this.multicall.tryBlockAndAggregate.staticCall(
						false,
						contractCalls
					);
					if (blockNumber >= this.blockHeight) {
						returnData.forEach((result, index) => {
							if (result[0]) {
								const call = uniqueTime.syncs[index].call;
								uniqueTime.syncs[index].output(
									call.interface.decodeFunctionResult(
										call.selector,
										result[1]
									)
								);
							}
						});
					}
				}, uniqueTime.timeout);
			});
		}

		// Event listers
		if (this.eventSyncs.length > 0) {
			this.eventSyncs.forEach((uniqueEvent) => {
				this.provider.on(uniqueEvent.event, async (log, event) => {
					const contractCalls = uniqueEvent.syncs.map((item) => ({
						target: item.call.target(),
						callData: item.call.interface.encodeFunctionData(
							item.call.selector,
							item.input(log, event)
						),
					}));
					const [blockNumber, , returnData]: [
						BigInt,
						null,
						[boolean, BytesLike][]
					] = await this.multicall.tryBlockAndAggregate.staticCall(
						false,
						contractCalls
					);
					if (blockNumber >= this.blockHeight) {
						returnData.forEach((result, index) => {
							if (result[0]) {
								const call = uniqueEvent.syncs[index].call;
								uniqueEvent.syncs[index].output(
									call.interface.decodeFunctionResult(
										call.selector,
										result[1]
									)
								);
							}
						});
					}
				});
			});
		}
	}

	// Trigger update for any TIME or BLOCK triggered states
	async pushUpdate(trigger: Trigger.TIME | Trigger.BLOCK) {
		if (trigger === Trigger.BLOCK) {
			if (this.blockSyncs.length > 0) {
				const contractCalls = this.blockSyncs.map((item) => ({
					target: item.call.target(),
					callData: item.call.interface.encodeFunctionData(
						item.call.selector,
						item.input(this.blockHeight)
					),
				}));
				const [blockNumber, , returnData]: [
					BigInt,
					null,
					[boolean, BytesLike][]
				] = await this.multicall.tryBlockAndAggregate.staticCall(
					false,
					contractCalls
				);
				if (blockNumber >= this.blockHeight) {
					returnData.forEach((result, index) => {
						if (result[0]) {
							const call = this.blockSyncs[index].call;
							this.blockSyncs[index].output(
								call.interface.decodeFunctionResult(
									call.selector,
									result[1]
								)
							);
						}
					});
				}
			}
		} else {
			const syncs = this.timeSyncs.map((x) => x.syncs).flat();
			const contractCalls = syncs.map((item) => ({
				target: item.call.target(),
				callData: item.call.interface.encodeFunctionData(
					item.call.selector,
					item.input()
				),
			}));
			const [blockNumber, , returnData]: [
				BigInt,
				null,
				[boolean, BytesLike][]
			] = await this.multicall.tryBlockAndAggregate.staticCall(
				false,
				contractCalls
			);
			if (blockNumber >= this.blockHeight) {
				returnData.forEach((result, index) => {
					if (result[0]) {
						const call = syncs[index].call;
						syncs[index].output(
							call.interface.decodeFunctionResult(
								call.selector,
								result[1]
							)
						);
					}
				});
			}
		}
	}

	// Remove all event listners
	destroy() {
		this.provider.removeAllListeners();
		this.timeouts.forEach((id) => clearInterval(id));
	}
}
