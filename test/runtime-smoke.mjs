export async function smoke(api, ethers) {
  const { EtherState, TriggerType, createERC20BalanceAction } = api
  const { FetchRequest, Interface, JsonRpcProvider, toUtf8Bytes, toUtf8String } = ethers
  const target = '0x0000000000000000000000000000000000000001'
  const multicall = new Interface([
    'function tryBlockAndAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) returns (uint256 blockNumber, bytes32 blockHash, tuple(bool success, bytes returnData)[] returnData)',
  ])
  const token = new Interface(['function balanceOf(address) view returns (uint256)'])
  const request = new FetchRequest('http://ether-state.test')
  let calls = 0
  request.getUrlFunc = async req => {
    const payload = JSON.parse(toUtf8String(req.body))
    const respond = item => {
      let result
      if (item.method === 'eth_chainId') result = '0x1'
      else if (item.method === 'eth_blockNumber') result = '0x10'
      else if (item.method === 'eth_call') {
        calls++
        const decoded = multicall.decodeFunctionData('tryBlockAndAggregate', item.params[0].data)
        result = multicall.encodeFunctionResult('tryBlockAndAggregate', [
          16n, `0x${'00'.repeat(32)}`,
          decoded[1].map(() => [true, token.encodeFunctionResult('balanceOf', [42n])]),
        ])
      } else throw new Error(`Unexpected RPC method: ${item.method}`)
      return { jsonrpc: '2.0', id: item.id, result }
    }
    return {
      statusCode: 200, statusMessage: 'OK', headers: {},
      body: toUtf8Bytes(JSON.stringify(Array.isArray(payload) ? payload.map(respond) : respond(payload))),
    }
  }
  const provider = new JsonRpcProvider(request, 1, { staticNetwork: true, cacheTimeout: -1 })
  const received = []
  const action = interval => createERC20BalanceAction(
    { type: TriggerType.TIME, interval }, target, target,
    balance => received.push({ interval, balance }),
  )
  const state = new EtherState([action(600_000), action(900_000)], provider)
  try {
    await state.update(TriggerType.TIME)
    if (calls !== 2 || received.length !== 2) throw new Error('update did not wait for both interval groups')
    if (!received.some(item => item.interval === 600_000 && item.balance === 42n)) throw new Error('First interval result missing')
    if (!received.some(item => item.interval === 900_000 && item.balance === 42n)) throw new Error('Second interval result missing')
    return 'ok'
  } finally {
    state.destroy()
    provider.destroy()
  }
}
