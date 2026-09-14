import type { Result } from "ethers";
import { Interface, getAddress } from "ethers";
import { ERC20ABI, MulticallABI } from "./abi.js";
import type { Action, Trigger } from "./types.js";
import { TriggerType } from "./types.js";

export function createERC20BalanceAction(trigger: Trigger, tokenAddress: string, tokenOwner: string, setBalance: (balance: bigint) => unknown): Action {
	try {
		const token = getAddress(tokenAddress)
		const owner = getAddress(tokenOwner)
		return withTrigger(trigger, {
			call: { target: () => token, interface: new Interface(ERC20ABI), selector: 'balanceOf' },
			input: () => [owner],
			output: (returnValues: Result) => setBalance(readBalance(returnValues))
		})
	} catch {
		throw new Error("Invalid Address")
	}
}

export function createEtherBalanceAction(trigger: Trigger, userAddress: string, setBalance: (balance: bigint) => unknown, multicallAddress?: string): Action {
	try {
		const multicall2 = multicallAddress ? getAddress(multicallAddress) : "0x5ba1e12693dc8f9c48aad8770482f4739beed696"
		const owner = getAddress(userAddress)
		return withTrigger(trigger, {
			call: { target: () => multicall2, interface: new Interface(MulticallABI), selector: 'getEthBalance' },
			input: () => [owner],
			output: (returnValues: Result) => setBalance(readBalance(returnValues))
		})
	} catch {
		throw new Error("Invalid Address")
	}
}

function readBalance(values: Result): bigint {
  const balance: unknown = values[0]
  if (typeof balance !== 'bigint') throw new Error('Invalid balance result')
  return balance
}

function withTrigger(trigger: Trigger, action: {
  call: Action['call']
  input: () => string[]
  output: (values: Result) => unknown
}): Action {
  switch (trigger.type) {
    case TriggerType.BLOCK: return { ...action, trigger }
    case TriggerType.TIME: return { ...action, trigger }
    case TriggerType.EVENT: return { ...action, trigger }
    default: {
      const exhaustive: never = trigger
      return exhaustive
    }
  }
}
