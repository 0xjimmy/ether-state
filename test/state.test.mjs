import assert from 'node:assert/strict'
import test from 'node:test'
import * as ethers from 'ethers'
import * as api from '../dist/esm/index.js'
import { readMulticall } from '../dist/esm/multicall.js'
import { smoke } from './runtime-smoke.mjs'

test('time updates wait and deliver each interval to its own action', async () => {
  assert.equal(await smoke(api, ethers), 'ok')
})

test('balance actions reject invalid addresses and decoded values', () => {
  const address = '0x0000000000000000000000000000000000000001'
  assert.throws(() => api.createERC20BalanceAction({ type: api.TriggerType.BLOCK }, 'bad', address, () => {}), /Invalid Address/)
  for (const trigger of [{ type: api.TriggerType.BLOCK }, { type: api.TriggerType.TIME, interval: 1000 }, { type: api.TriggerType.EVENT, eventFilter: { address } }]) {
    let balance
    const action = api.createEtherBalanceAction(trigger, address, value => { balance = value })
    action.output(ethers.Result.from([10n]), 1n)
    assert.equal(balance, 10n)
    assert.throws(() => action.output(ethers.Result.from(['bad']), 1n), /Invalid balance/)
  }
})

test('multicall validates untrusted results and preserves reverted calls', async () => {
  const contract = value => ({ getFunction: () => ({ staticCall: async () => value }) })
  const calls = [{ target: '0x00', callData: '0x' }]
  for (const value of [null, [], [1, '0x', []], [1n, '0x', []], [1n, '0x', [['yes', '0x']]], [1n, '0x', [[true, 'garbage']]]]) {
    await assert.rejects(readMulticall(contract(value), calls), /Invalid multicall/)
  }
  assert.deepEqual(await readMulticall(contract([1n, '0x', [[false, '0x']]]), calls), {
    blockNumber: 1n, results: [{ success: false, returnData: '0x' }],
  })
})

function harness(results = [[true, ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [42n])]]) {
  const abi = new ethers.Interface(['function tryBlockAndAggregate(bool, tuple(address target, bytes callData)[]) returns (uint256, bytes32, tuple(bool success, bytes returnData)[])'])
  const listeners = new Map()
  let reads = 0
  const provider = {
    getBlockNumber: async () => 16,
    on: async (event, callback) => { listeners.set(JSON.stringify(event), callback) },
    removeAllListeners: async () => { listeners.clear() },
    call: async transaction => {
      reads++
      const decoded = abi.decodeFunctionData('tryBlockAndAggregate', transaction.data)
      return abi.encodeFunctionResult('tryBlockAndAggregate', [16n, `0x${'00'.repeat(32)}`, decoded[1].map((_, index) => results[index % results.length])])
    },
  }
  return { provider, listeners, reads: () => reads }
}

test('block updates wait for outputs and suppress duplicate blocks', async () => {
  const fixture = harness()
  const balances = []
  const address = '0x0000000000000000000000000000000000000001'
  const action = api.createERC20BalanceAction({ type: api.TriggerType.BLOCK }, address, address, balance => balances.push(balance))
  const state = new api.EtherState([action], fixture.provider)
  try {
    await state.update(api.TriggerType.BLOCK)
    assert.deepEqual(balances, [42n])
    await state.update(api.TriggerType.BLOCK)
    assert.equal(fixture.reads(), 1)
  } finally { state.destroy() }
  assert.equal(fixture.listeners.size, 0)
})

test('event actions share one listener and decode successful calls', async () => {
  const fixture = harness()
  const address = '0x0000000000000000000000000000000000000001'
  const filter = { address }
  const balances = []
  let finish
  const complete = new Promise(resolve => { finish = resolve })
  const action = api.createERC20BalanceAction({ type: api.TriggerType.EVENT, eventFilter: filter }, address, address, balance => {
    balances.push(balance)
    if (balances.length === 2) finish()
  })
  const state = new api.EtherState([action, action], fixture.provider)
  try {
    assert.equal(fixture.listeners.size, 1)
    fixture.listeners.get(JSON.stringify(filter))({ blockNumber: 16 })
    await complete
    assert.deepEqual(balances, [42n, 42n])
    assert.equal(fixture.reads(), 1)
  } finally { state.destroy() }
})

test('reverted calls do not run output callbacks', async () => {
  const fixture = harness([[false, '0x']])
  const address = '0x0000000000000000000000000000000000000001'
  const action = api.createERC20BalanceAction({ type: api.TriggerType.BLOCK }, address, address, () => assert.fail('Reverted call was published'))
  const state = new api.EtherState([action], fixture.provider)
  try { await state.update(api.TriggerType.BLOCK) } finally { state.destroy() }
})
