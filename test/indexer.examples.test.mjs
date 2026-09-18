import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Effect } from 'effect'
import { Interface } from 'ethers'
import { eventIndex } from '../examples/indexer/event-index.ts'
import { matchesLog } from '../src/rpc/watch.ts'

const user = `0x${'11'.repeat(20)}`
const other = `0x${'22'.repeat(20)}`
const token = `0x${'33'.repeat(20)}`
const abi = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Initialize(uint160 sqrtPriceX96, int24 tick)',
  'event Flash(address indexed sender, address indexed recipient, uint256 amount0, uint256 amount1, uint256 paid0, uint256 paid1)',
  'event IncreaseObservationCardinalityNext(uint16 observationCardinalityNextOld, uint16 observationCardinalityNextNew)',
  'event SetFeeProtocol(uint8 feeProtocol0Old, uint8 feeProtocol1Old, uint8 feeProtocol0New, uint8 feeProtocol1New)',
  'event CollectProtocol(address indexed sender, address indexed recipient, uint128 amount0, uint128 amount1)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)',
])
const log = (name, args, index = 0) => ({
  ...abi.encodeEventLog(abi.getEvent(name), args), address: token,
  transactionHash: `0x${'44'.repeat(32)}`, logIndex: BigInt(index),
})
const transform = (index, logs) => Effect.runPromise(index.transform({ logs: logs.filter(log => matchesLog(log, index.source.logs)) }))

test('transfer example selects either direction, counts self-transfers once, and preserves uint256', async () => {
  const index = eventIndex({ kind: 'transfers', startBlock: 1n, token, user, direction: 'both' })
  const large = 2n ** 200n
  const rows = await transform(index, [
    log('Transfer', [user, other, large], 0), log('Transfer', [other, user, 2n], 1),
    log('Transfer', [user, user, 3n], 2), log('Transfer', [other, other, 4n], 3),
    { ...log('Transfer', [user, other, 5n], 4), address: other },
  ])
  assert.equal(rows.length, 3)
  assert.equal(rows[0].value.args.value, large.toString())
  assert.equal(new Set(rows.map(row => row.key)).size, 3)
})

test('transfer example supports positional wildcards and all-token filters', async () => {
  const logs = [log('Transfer', [user, other, 1n]), log('Transfer', [other, user, 2n], 1)]
  for (const [direction, expected] of [['from', '1'], ['to', '2']]) {
    const index = eventIndex({ kind: 'transfers', startBlock: 1n, user, direction })
    const rows = await transform(index, logs)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].value.args.value, expected)
    assert.equal(index.source.logs.address, undefined)
  }
  const wildcard = eventIndex({ kind: 'transfers', startBlock: 1n, direction: 'both' })
  assert.equal((await transform(wildcard, logs)).length, 2)
})

test('V3 example decodes signed swaps, tick ranges, liquidity and collections', async () => {
  const logs = [
    log('Swap', [user, other, -10n, 20n, 2n ** 96n, 500n, -1], 0),
    log('Mint', [user, other, -120, 120, 50n, 10n, 20n], 1),
    log('Burn', [other, -120, 120, 25n, 5n, 10n], 2),
    log('Collect', [other, user, -120, 120, 5n, 10n], 3),
  ]
  const index = eventIndex({ kind: 'v3', startBlock: 1n, pools: [token], events: 'all' })
  const rows = await transform(index, logs)
  assert.deepEqual(rows.map(row => row.value.event), ['Swap', 'Mint', 'Burn', 'Collect'])
  assert.equal(rows[0].value.args.amount0, '-10')
  assert.equal(rows[1].value.args.tickLower, '-120')
  assert.equal(rows[2].value.args.amount, '25')
  assert.equal(rows[3].value.args.amount0, '5')
  for (const [events, count] of [['swaps', 1], ['liquidity', 3]]) {
    assert.equal((await transform(eventIndex({ kind: 'v3', startBlock: 1n, events }), logs)).length, count)
  }
  assert.equal((await transform(index, [{ ...logs[0], address: other }])).length, 0)
})

test('transfer example excludes ERC-721 layout and rejects incomplete logs', async () => {
  const index = eventIndex({ kind: 'transfers', startBlock: 1n, direction: 'both' })
  const transfer = log('Transfer', [user, other, 1n])
  assert.equal((await transform(index, [{ ...transfer, topics: [...transfer.topics, transfer.data], data: '0x' }])).length, 0)
  await assert.rejects(Effect.runPromise(index.transform({ logs: [{ ...transfer, data: undefined }] })), /Incomplete event log/)
})

test('V3 all-events index includes initialization, flash and pool administration', async () => {
  const logs = [
    log('Initialize', [2n ** 96n, -1], 0),
    log('Flash', [user, other, 10n, 20n, 11n, 21n], 1),
    log('IncreaseObservationCardinalityNext', [16, 32], 2),
    log('SetFeeProtocol', [0, 0, 4, 5], 3),
    log('CollectProtocol', [user, other, 30n, 40n], 4),
  ]
  const rows = await transform(eventIndex({ kind: 'v3', startBlock: 1n, events: 'all' }), logs)
  assert.deepEqual(rows.map(row => row.value.event), [
    'Initialize', 'Flash', 'IncreaseObservationCardinalityNext', 'SetFeeProtocol', 'CollectProtocol',
  ])
  assert.equal(rows[0].value.args.sqrtPriceX96, (2n ** 96n).toString())
  assert.equal(rows[1].value.args.paid0, '11')
  assert.equal(rows[2].value.args.observationCardinalityNextNew, '32')
  assert.equal(rows[3].value.args.feeProtocol1New, '5')
  assert.equal(rows[4].value.args.amount1, '40')
  for (const events of ['swaps', 'liquidity']) {
    assert.equal((await transform(eventIndex({ kind: 'v3', startBlock: 1n, events }), logs)).length, 0)
  }
})
