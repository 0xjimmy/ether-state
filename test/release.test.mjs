import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { releaseVersion, shouldPublish } from '../scripts/release.mjs'
test('release accepts a stable package version', () => {
  assert.equal(releaseVersion({ name: 'ether-state', version: '0.2.2' }), '0.2.2')
})
test('release rejects prereleases, invalid versions, and wrong names', () => {
  for (const version of ['0.3.0-experimental.0', 'v0.2.2', '01.2.2', '0.2', '0.2.2+build']) {
    assert.throws(() => releaseVersion({ name: 'ether-state', version }))
  }
  assert.throws(() => releaseVersion({ name: 'other', version: '0.2.2' }))
})

test('release skips existing versions and prevents npm latest downgrades', () => {
  const metadata = { versions: { '0.2.1': {} }, 'dist-tags': { latest: '0.2.1' } }
  assert.equal(shouldPublish('0.2.1', metadata), false)
  assert.equal(shouldPublish('0.2.2', metadata), true)
  assert.throws(() => shouldPublish('0.1.9', metadata), /downgrade/)
  assert.throws(() => shouldPublish('0.2.2', {}), /missing/)
})
