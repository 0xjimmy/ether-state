# ether-state

Library for syncing state from contracts.

Originally designed for managing state in (Svelte Kit Ethers Template)[https://github.com/DecentralisedTech/svelte-kit-ethers-template], `ether-state` will query Ethereum contracts with the least amount of calls and event listeners.

## Basic Usage

```ts
import { providers, utils } from 'ethers'
import { Sync, Trigger } from 'ether-state'
import type { StateSync } from 'ether-state'

const IERC20 = new utils.Interface(['function totalSupply() external view returns (uint256)', 'function balanceOf(address) external view returns (uint256)', 'event Transfer(address indexed from, address indexed to, uint256 value)'])

// Check totalSupply of DAI every block, check balance of every DAI recipient on Transfer event
const syncs: StateSync[] = [
  {
    trigger: Trigger.BLOCK,
    input: () => [],
    call: {
      target: () => '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI contract
      interface: IERC20,
      selector: 'totalSupply'
    },
    output: (totalSupply) => {
      console.log("DAI Total Supply:", utils.formatEther(totalSupply[0]))
    } 
  },
  {
    trigger: Trigger.EVENT,
    triggerValue: { // Event filter
      address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      topics: [
       utils.id("Transfer(address,address,uint256)"),
      ]
    },
    input: (log) => {
      const event = IERC20.decodeEventLog("Transfer", log.data, log.topics)
      console.log(`${event.from} sent ${utils.formatEther(event.value)} DAI to ${event.to}`)
      return [event.to]
    },
    call: {
      target: () => '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI contract
      interface: IERC20,
      selector: 'balanceOf'
    },
    output: (balance) => {
      console.log("Recipents balance is now: ", utils.formatEther(balance[0]), " DAI")
    } 
  }
]

const provider = providers.getDefaultProvider()
const sync = new Sync(syncs, provider)
```
