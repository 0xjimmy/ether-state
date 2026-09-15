import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Effect, Schema, Stream } from 'effect'
import { Indexer, callbackStore, defineIndex, indexChanges, runIndexChanges } from '../src/indexer.ts'

const hash = value => `0x${value.toString(16).padStart(2, '0').repeat(32)}`
const block = (number, parentHash, salt = 0) => ({
  number: BigInt(number), hash: hash(number + salt), parentHash, timestamp: BigInt(number * 2), transactions: [],
})
const genesis = block(0, hash(255))
const first = block(1, genesis.hash)
const original = [genesis, first, block(2, first.hash), block(3, hash(2))]
const replacement = [genesis, first, block(2, first.hash, 20), block(3, hash(22), 20)]

const fakeClient = (chain, archive = []) => ({
  config: { network: { chainId: 8453n, blockTime: 10 } },
  blocks: Stream.empty,
  fetchOne(request) {
    if (request.method === 'eth_getBlockByNumber') {
      const reference = request.params[0]
      const found = reference === 'latest' ? chain.value.at(-1)
        : reference === 'finalized' ? chain.value[0]
          : chain.value.find(entry => entry.number === reference)
      return Effect.succeed(found ?? null)
    }
    if (request.method === 'eth_getBlockByHash') {
      return Effect.succeed([...chain.value, ...archive].find(entry => entry.hash === request.params[0]) ?? null)
    }
    if (request.method === 'eth_getLogs') return Effect.succeed([])
    throw new Error(`Unexpected RPC method ${request.method}`)
  },
})

const memoryStore = () => {
  const state = { checkpoint: null, blocks: [], rows: [], rollbacks: 0, commits: 0 }
  return {
    state,
    store: {
      load: () => Effect.sync(() => state.checkpoint),
      recent: (_id, _version, limit) => Effect.sync(() => [...state.blocks].sort((left, right) => left.number > right.number ? -1 : 1).slice(0, limit)),
      commit: commit => Effect.sync(() => {
        state.checkpoint = commit.checkpoint
        state.blocks = [...state.blocks.filter(entry => entry.hash !== commit.checkpoint.hash), commit.checkpoint]
        state.rows = [...state.rows.filter(row => row.blockHash !== commit.checkpoint.hash), ...commit.rows]
        state.commits++
      }),
      rollback: rollback => Effect.sync(() => {
        const hashes = new Set(rollback.orphaned.map(entry => entry.hash))
        state.blocks = state.blocks.filter(entry => !hashes.has(entry.hash))
        state.rows = state.rows.filter(row => !hashes.has(row.blockHash))
        state.checkpoint = rollback.checkpoint
        state.rollbacks++
      }),
    },
  }
}

const definition = defineIndex({
  id: 'blocks', version: 1, startBlock: 1n, finality: { mode: 'latest' }, source: {}, valueSchema: Schema.String,
  transform: bundle => Effect.succeed([{ key: 'block', value: bundle.block.hash }]),
})

test('indexer resumes, rolls back a fork, and replays in order', async () => {
  const chain = { value: original }
  const client = fakeClient(chain, original)
  const memory = memoryStore()
  const indexer = await Effect.runPromise(Indexer.make({ client, index: definition, store: memory.store, bootstrapConcurrency: 3 }))
  const firstCheckpoint = await Effect.runPromise(indexer.sync(3n))
  assert.equal(firstCheckpoint.hash, original[3].hash)
  assert.equal(memory.state.commits, 3)

  chain.value = replacement
  const replacementCheckpoint = await Effect.runPromise(indexer.sync(3n))
  assert.equal(replacementCheckpoint.hash, replacement[3].hash)
  assert.equal(memory.state.rollbacks, 1)
  assert.deepEqual(memory.state.blocks.map(entry => entry.hash), replacement.slice(1).map(entry => entry.hash))
  assert.deepEqual(memory.state.rows.map(row => row.blockHash), replacement.slice(1).map(entry => entry.hash))

  const restarted = await Effect.runPromise(Indexer.make({ client, index: definition, store: memory.store }))
  await Effect.runPromise(restarted.sync(3n))
  assert.equal(memory.state.commits, 5)
})

test('indexer rejects a stored checkpoint from another definition version', async () => {
  const chain = { value: original }
  const memory = memoryStore()
  const firstIndexer = await Effect.runPromise(Indexer.make({ client: fakeClient(chain), index: definition, store: memory.store }))
  await Effect.runPromise(firstIndexer.sync(1n))
  const changed = defineIndex({ ...definition, version: 2 })
  const changedIndexer = await Effect.runPromise(Indexer.make({ client: fakeClient(chain), index: changed, store: memory.store }))
  const failure = await Effect.runPromise(Effect.flip(changedIndexer.sync(1n)))
  assert.equal(failure._tag, 'IndexMetadataMismatch')
  assert.equal(failure.checkpoint.version, 1)
})

test('stream/callback path emits encoded block changes in order', async () => {
  const chain = { value: original }
  const changes = indexChanges({ client: fakeClient(chain), index: definition, fromBlock: 1n, toBlock: 3n })
  const seen = []
  await Effect.runPromise(runIndexChanges(changes, change => Effect.sync(() => { seen.push(change) })))
  assert.deepEqual(seen.map(change => change.block.number), [1n, 2n, 3n])
  assert.deepEqual(seen.map(change => change.rows[0].value), original.slice(1).map(entry => entry.hash))
})

test('receipt fallback reuses receipt logs without an extra log request', async () => {
  const transaction = {
    blockHash: first.hash, blockNumber: 1n, transactionIndex: 0n, hash: hash(90), from: `0x${'11'.repeat(20)}`,
    r: 1n, s: 1n,
  }
  const log = {
    blockHash: first.hash, blockNumber: 1n, transactionHash: transaction.hash, transactionIndex: 0n,
    logIndex: 0n, address: `0x${'22'.repeat(20)}`, topics: [hash(91)], data: '0x',
  }
  const receipt = {
    blockHash: first.hash, blockNumber: 1n, transactionHash: transaction.hash, transactionIndex: 0n,
    from: transaction.from, gasUsed: 1n, cumulativeGasUsed: 1n, effectiveGasPrice: 1n, logs: [log],
  }
  const methods = []
  const client = {
    config: { network: { chainId: 8453n, blockTime: 10 } }, blocks: Stream.empty,
    fetchOne(request) {
      methods.push(request.method)
      if (request.method === 'eth_getBlockByNumber') return Effect.succeed({ ...first, transactions: [transaction] })
      if (request.method === 'eth_getBlockReceipts') return Effect.fail({ _tag: 'RpcError', code: -32601, message: 'not supported' })
      if (request.method === 'eth_getTransactionReceipt') return Effect.succeed(receipt)
      throw new Error(`Unexpected RPC method ${request.method}`)
    },
  }
  const receipts = defineIndex({
    id: 'receipts', version: 1, startBlock: 1n, finality: { mode: 'latest' },
    source: { receipts: true, logs: { address: log.address, topics: [log.topics[0]] } },
    valueSchema: Schema.Number,
    transform: bundle => Effect.succeed([{ key: 'counts', value: bundle.receipts.length + bundle.logs.length }]),
  })
  const seen = []
  await Effect.runPromise(runIndexChanges(indexChanges({ client, index: receipts, fromBlock: 1n, toBlock: 1n }),
    change => Effect.sync(() => { seen.push(change.rows[0].value) })))
  assert.deepEqual(seen, [2])
  assert.deepEqual(methods, ['eth_getBlockByNumber', 'eth_getBlockReceipts', 'eth_getTransactionReceipt'])
})

test('callback store acknowledges apply and revert changes with checkpoints', async () => {
  const changes = []
  const store = callbackStore({
    load: () => Effect.succeed(null), recent: () => Effect.succeed([]),
    write: change => Effect.sync(() => { changes.push(change) }),
  })
  const checkpoint = {
    ...first, indexId: 'callback', version: 1, chainId: 8453n, startBlock: 1n, finalized: null,
  }
  await Effect.runPromise(store.commit({ checkpoint, rows: [] }))
  await Effect.runPromise(store.rollback({ indexId: 'callback', version: 1, orphaned: [first], checkpoint: null }))
  assert.deepEqual(changes.map(change => change._tag), ['Apply', 'Revert'])
  assert.equal(changes[0].checkpoint, checkpoint)
  assert.equal(changes[1].checkpoint, null)
})

test('RPC failure during recovery preserves the checkpoint and rows', async () => {
  const chain = { value: original }
  const memory = memoryStore()
  const client = fakeClient(chain)
  const indexer = await Effect.runPromise(Indexer.make({ client, index: definition, store: memory.store }))
  await Effect.runPromise(indexer.sync(3n))
  // Exercise recovery without a finalized anchor, as on chains without that RPC tag.
  memory.state.checkpoint = { ...memory.state.checkpoint, finalized: null }
  const before = structuredClone(memory.state)
  const fetch = client.fetchOne.bind(client)
  client.fetchOne = request => request.method === 'eth_getBlockByNumber'
    ? Effect.fail({ _tag: 'RpcError', code: -32000, message: 'temporary outage' }) : fetch(request)
  const failure = await Effect.runPromise(Effect.flip(indexer.sync(3n)))
  assert.equal(failure._tag, 'IndexBlockUnavailable')
  assert.deepEqual(memory.state, before)
})
