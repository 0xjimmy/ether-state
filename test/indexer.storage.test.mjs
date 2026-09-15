import assert from 'node:assert/strict'
import { test } from 'bun:test'

for (const adapter of ['pglite', 'libsql', 'd1']) {
  test(`${adapter} store commits and rolls back rows with its checkpoint`, async () => {
    const child = Bun.spawn([process.execPath, 'test/indexer-storage.mjs', adapter], {
      stdout: 'inherit', stderr: 'inherit',
    })
    assert.equal(await child.exited, 0)
  }, adapter === 'pglite' ? 30_000 : 5_000)
}
