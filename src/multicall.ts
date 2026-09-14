import type { Contract } from 'ethers'

type MulticallResult = {
  readonly blockNumber: bigint
  readonly results: ReadonlyArray<{ readonly success: boolean; readonly returnData: string }>
}

export async function readMulticall(
  contract: Contract,
  calls: ReadonlyArray<{ readonly target: string; readonly callData: string }>,
): Promise<MulticallResult> {
  const value: unknown = await contract.getFunction('tryBlockAndAggregate').staticCall(false, calls)
  if (!Array.isArray(value)) throw new Error('Invalid multicall response')
  const blockNumber: unknown = value[0]
  const rawResults: unknown = value[2]
  if (typeof blockNumber !== 'bigint' || !Array.isArray(rawResults) || rawResults.length !== calls.length) {
    throw new Error('Invalid multicall response')
  }
  const results = rawResults.map((entry: unknown) => {
    if (!Array.isArray(entry)) throw new Error('Invalid multicall result')
    const success: unknown = entry[0]
    const returnData: unknown = entry[1]
    if (typeof success !== 'boolean' || typeof returnData !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(returnData)) {
      throw new Error('Invalid multicall result')
    }
    return { success, returnData }
  })
  return { blockNumber, results }
}
