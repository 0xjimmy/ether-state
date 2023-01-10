# ether-state

Library for syncing state from contracts.

Originally designed for managing state in [Svelte Kit Ethers Template](https://github.com/0xjimmy/svelte-kit-ethers-template), `ether-state` will query Ethereum contracts with the least amount of calls and event listeners.

## Basic Usage

```ts
import { providers, utils } from 'ethers';
import { Sync, Trigger } from 'ether-state';
import type { StateSync } from 'ether-state';

const IERC20 = new utils.Interface([
	'function totalSupply() external view returns (uint256)',
	'function balanceOf(address) external view returns (uint256)',
	'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

// Check totalSupply of DAI every block, check balance of every DAI recipient on Transfer event
const syncs: StateSync[] = [
	{
		trigger: Trigger.BLOCK,
		input: () => [],
		call: {
			target: () => '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI contract
			interface: IERC20,
			selector: 'totalSupply',
		},
		output: (totalSupply) => {
			console.log('DAI Total Supply:', utils.formatEther(totalSupply[0]));
		},
	},
	{
		trigger: Trigger.EVENT,
		triggerValue: {
			// Event filter
			address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
			topics: [utils.id('Transfer(address,address,uint256)')],
		},
		input: (log) => {
			const event = IERC20.decodeEventLog(
				'Transfer',
				log.data,
				log.topics
			);
			console.log(
				`${event.from} sent ${utils.formatEther(event.value)} DAI to ${
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
		output: (balance) => {
			console.log(
				'Recipents balance is now: ',
				utils.formatEther(balance[0]),
				' DAI'
			);
		},
	},
];

const provider = providers.getDefaultProvider();
const sync = new Sync(syncs, provider);
```

## API

-   [Sync](#Sync)
-   [StateSync](#StateSync)
-   [Trigger](#Trigger)
-   [ContractCall](#ContractCall)

### Sync

Takes an array of `StateSyncs` and manages calling contracts based on their triggers.

```ts
import { Sync, Trigger, StateSync } from 'ether-state';
import { providers } from 'ethers';

const provider = providers.getDefaultProvider();
const stateSyncs: StateSync[] = [];

// Create Sync
const mySync = new Sync(provider, stateSyncs);

// Manually trigger contract calls to all StateSyncs with BLOCK trigger
mySync.triggerUpdate(Trigger.BLOCK);

// Destory Sync, turn off all event listeners
mySync.destroy();
```

**Create new Sync** -`Sync.constructor(ethers.providers.Provider, StateSync[])`

**Manually Trigger Updates** - `Sync.pushUpdate(Trigger.TIME | Trigger.BLOCK)`
Triggers update calls to all StateSyncs with trigger types of either TIME or BLOCK.

**Stop Updates** = `Sync.destroy()`
Removes all event listeners and stops all updates

### StateSync

Type for passing to Syncs.

```ts
type StateSync = {
	trigger: Trigger;
	triggerValue?: any;
	input: Function;
	call: ContractCall;
	output: Function;
};
```

-   `trigger` - What type of _Trigger_ to call contract
-   `triggerValue` (Optional) - Used for _EVENT_ or _TIME_ triggers, being an Ethers [EventFilter](https://docs.ethers.io/v5/api/providers/types/#providers-EventFilter) object or interval in milliseconds.
-   `input` - Function that returns an array of function parameters. Eg `["0x6B175474E89094C44Da98b954EedeAC495271d0F", "5000"]`
-   `call` - See [ContractCall](#ContractCall)
-   `output` - Callback function that takes first argument as the call return value

### Trigger

Enum type for specifiying what to trigger a contract call.

```ts
enum Trigger {
	BLOCK,
	EVENT,
	TIME,
}
```

### ContractCall

Type that contains interface, selector and target of a call.

```ts
type ContractCall = {
	target: () => string;
	interface: Interface;
	selector: string;
};
```

`target` - A function that returns the target contract address
`interface` - An Ethers [Interface](https://docs.ethers.io/v5/api/utils/abi/interface/#Interface) type, can be created with `new ethers.Interface(ABI)`
`selector` - Name of the function, just name like `balanceOf` or include full selector if needed like `balanceOf(address)`
