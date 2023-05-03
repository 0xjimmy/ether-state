import { Result } from "ethers";
import { Interface, getAddress } from "ethers";
import { ERC20ABI, MulticallABI } from "./abi";
import { Action, TriggerType, Trigger } from "./types";

export function createERC20BalanceAction(trigger: Trigger, tokenAddress: string, tokenOwner: string, setBalance: (balance: bigint) => unknown): Action {
	try {
		const token = getAddress(tokenAddress)
		const owner = getAddress(tokenOwner)
		return {
			trigger,
			call: { target: () => token, interface: new Interface(ERC20ABI), selector: 'balanceOf' },
			input: () => [owner],
			output: (returnValues: Result) => setBalance(returnValues[0] as bigint)
		} as Action
	} catch {
		throw new Error("Invalid Address")
	}
}

export function createEtherBalanceAction(trigger: Trigger, userAddress: string, setBalance: (balance: bigint) => unknown, multicallAddress?: string): Action {
	try {
		const multicall2 = multicallAddress ? getAddress(multicallAddress) : "0x5ba1e12693dc8f9c48aad8770482f4739beed696"
		const owner = getAddress(userAddress)
		return {
			trigger: trigger,
			call: { target: () => multicall2, interface: new Interface(MulticallABI), selector: 'getEthBalance' },
			input: () => [owner],
			output: (returnValues: Result) => setBalance(returnValues[0] as bigint)
		} as Action
	} catch {
		throw new Error("Invalid Address")
	}
}
