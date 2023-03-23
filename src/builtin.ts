import { Interface, getAddress } from "ethers";
import { ERC20ABI } from "./abi";
import { BlockAction, EventAction, Triggers } from "./types";

export function createERC20BalanceAction(trigger: Triggers.BLOCK | Triggers.EVENT, tokenAddress: string, tokenOwner: string, setBalance: (balance: bigint) => unknown): BlockAction | EventAction | undefined {
	try {
		const token = getAddress(tokenAddress)
		const owner = getAddress(tokenOwner)
		if (trigger === Triggers.BLOCK) {
			return {
				trigger: { type: Triggers.BLOCK },
				call: { target: () => token, interface: new Interface(ERC20ABI), selector: 'balanceOf' },
				input: () => [owner],
				output: (returnValues) => setBalance(returnValues[0] as bigint)
			}
		}
		if (trigger === Triggers.EVENT) {
			return {
				trigger: { type: Triggers.EVENT, eventFilter: '' },
				call: { target: () => token, interface: new Interface(ERC20ABI), selector: 'balanceOf' },
				input: () => [owner],
				output: (returnValues) => setBalance(returnValues[0] as bigint)
			}
		}
	} catch {
		throw new Error("Invalid Address")
	}
}
