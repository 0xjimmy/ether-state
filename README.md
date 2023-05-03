# ether-state

A Library for syncing state from contracts.
Trigger Ethereum contract calls whenever there is a new block, matching event or by time interval. `ether-state` bundles calls with [Multicall2](https://github.com/mds1/multicall) to reduce the amount of RPC calls and tries to reduce the amount of event listeners needed for all actions.

Originally designed for managing state in [Svelte Kit Ethers Template](https://github.com/0xjimmy/svelte-kit-ethers-template).

## TODO
- [ ] Start using Multicall3
- [ ] Add more default actions and action generators  

## Basic Usage

```ts
import { getDefaultProvider, formatEther, Interface, id, Log } from 'ethers';
import { EtherState, Actions, TriggerType } from 'ether-state';

const IERC20 = new Interface([
	'function totalSupply() external view returns (uint256)',
	'function balanceOf(address) external view returns (uint256)',
	'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

// Check totalSupply of DAI every block, check balance of every DAI recipient on Transfer event
const actions: Actions[] = [
	{
		trigger: {
			type: TriggerType.BLOCK
		},
		input: () => [],
		call: {
			target: () => '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI contract
			interface: IERC20,
			selector: 'totalSupply',
		},
		output: (returnParams) => {
			console.log('DAI Total Supply:', formatEther(returnParams[0]));
		},
	},
	{
		trigger: {
			type: TriggerType.EVENT,
			eventFilter: {
				address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
				topics: [id('Transfer(address,address,uint256)')]
			}
		},
		// Use the transfer recipient as the input param for balanceOf call
		input: (log: Log) => {
			const event = IERC20.decodeEventLog(
				'Transfer',
				log.data,
				log.topics
			);
			console.log(
				`${event.from} sent ${formatEther(event.value)} DAI to ${
					event.to
				}`
			);
			return [event.to];
		},
		call: {
			target: () => '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI contract
			interface: IERC20,
			selector: 'balanceOf',
		},
		output: (returnParams) => {
			console.log('Recipents balance is now: ', formatEther(returnParams[0]), ' DAI');
		},
	},
];

const provider = getDefaultProvider();
const etherState = new EtherState(actions, provider);
```

# API

- [EtherState](#EtherState)
- [Triggers](#Triggers)
- [Actions](#Actions)
	- [BlockAction](#BlockAction)
	- [EventAction](#EventAction)
	- [TimeAction](#TimeAction)

## EtherState


Takes an array of `Actions` and manages calling contracts based on their triggers.

```ts
import { EtherState, Action, TriggerType } from 'ether-state';
import { getDefaultProvider } from 'ethers';

const provider = getDefaultProvider();
const actions: Action[] = [];

// Create instance
const etherState = new EtherState(actions, provider)

// Manually trigger contract calls to all actions with BLOCK trigger
etherState.update(TriggerType.BLOCK);

// Destory instance, turn off all event listeners
etherState.destroy();
```

**Create new instance** -`new EtherState(actions: Action[], provider: Provider, options?: { customMulticallAddress?: string, populateTimeAndBlock?: boolean })`

**Manually Trigger Updates** - `EtherState.update(type: TriggerType.TIME | TriggerType.BLOCK)`
Triggers update calls to all Actions with trigger types of either TIME or BLOCK.

**Stop Updates** = `EtherState.destroy()`
Removes all event listeners and stops all updates

## Triggers

There are 3 trigger types, `BLOCK`, `TIME` and `EVENT`.

Time actions are triggered by setInterval, set the interval amount in ms.
Event actions are triggered by a matching ethers' [EventFilter](https://docs.ethers.org/v6/api/providers/#EventFilter), the Log from the event filter and block is passed to the `inputs` method of the action.

```ts
enum TriggerType {
	BLOCK,
	EVENT,
	TIME,
}

type BlockTrigger = { type: TriggerType.BLOCK }
type TimeTrigger = { type: TriggerType.TIME, interval: number }
type EventTrigger = { type: TriggerType.EVENT, eventFilter: EventFilter }
```

## Actions

There are 3 variation of `Action` for the 3 different trigger types.
They all include trigger, input, call and output with type specific parameters for the input and output functions.

The `input` function returns an array of input parameters for a contract function call.
The `output` function gets passed the return value of the contract call as well as trigger specific data like the Log of an event triggered action.
The `call` object defines the interface and function name to be called and a function that returns the contract address:
```ts
type ContractCall = {
	target: () => string
	interface: Interface
	selector: string
}

```

**Variations of Actions**

```ts
type BlockAction = {
	trigger: BlockTrigger
	input: (blockNumber: bigint) => Array<bigint | BytesLike | string | boolean>
	call: ContractCall
	output: (returnValues: Result, blockNumber: bigint) => unknown
}

type TimeAction = {
	trigger: TimeTrigger
	input: (currentTime: number) => Array<bigint | BytesLike | string | boolean>
	call: ContractCall
	output: (returnValues: Result, blockNumber: bigint) => unknown
}

type EventAction = {
	trigger: EventTrigger
	input: (log: Log, blockNumber: bigint) => Array<bigint | BytesLike | string | boolean>
	call: ContractCall
	output: (returnValues: Result, blockNumber: bigint, log: Log) => unknown
}

```
