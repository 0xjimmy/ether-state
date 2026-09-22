import { expect, test } from 'bun:test'
import { Effect, Schema, Stream } from 'effect'
import { Indexer, Projection, Source, memoryModelStore } from '../src/indexer.ts'

const hash = number => `0x${number.toString(16).padStart(64, '0')}`
const block = number => ({ number, timestamp: number, hash: hash(number), parentHash: hash(number > 0n ? number - 1n : 0n) })
const definition = Indexer.define({ name: 'sparse-restore', version: 1, params: Schema.Void, build: () => {
  const events = Source.logs({ name: 'events', filter: {}, schema: Schema.Number, decode: log => Effect.succeed(Number(log.data)) })
  return { candles: Projection.partitioned({ source: events, schema: Schema.Number, intervalSeconds: 60n,
    rebuild: ({ events }) => Effect.succeed(events.reduce((sum, event) => sum + event.value, 0)) }) }
} })
const client = {
  config: { network: { chainId: 1n } }, watchBlocks: () => Stream.never, watchLogBlocks: () => Stream.never,
  fetchOne: ({ method, params }) => method === 'eth_getBlockByNumber'
    ? Effect.succeed(block(params[0] === 'latest' ? 180n : params[0]))
    : Effect.fail({ _tag: 'RpcError', code: -32601, message: 'Missing history unavailable in this fixture' }),
}

for (const gap of [false, true]) test(`restart restores sparse source candles only with complete scanned coverage (gap=${gap})`, async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = memoryModelStore()
    const instance = yield* definition.make({ client, params: undefined, store, plan: { history: { from: 0n, batchSize: 181 } } })
    yield* store.commit(instance.id, { rows: [],
      batches: [
        { block: block(0n), sources: { events: [] } },
        { block: block(70n), sources: { events: [7] } },
        { block: block(180n), sources: { events: [] } },
      ], coverage: gap ? [{ from: 0n, through: 60n }, { from: 80n, through: 180n }] : [{ from: 0n, through: 180n }],
    })
    if (gap) yield* Effect.flip(instance.run())
    else yield* instance.run()
    const rows = yield* store.rows(instance.id, 'candles')
    if (gap) expect(rows.find(row => row.key === '60')).toBeUndefined()
    else {
      expect(rows.find(row => row.key === '60')).toMatchObject({ value: 7, period: 'closed', coverage: 'complete' })
      expect(rows.find(row => row.key === '120')).toMatchObject({ value: 0, period: 'closed', coverage: 'complete' })
    }
  })))
})
