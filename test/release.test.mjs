import assert from 'node:assert/strict'
import test from 'node:test'
import { releaseVersion, shouldPublish } from '../scripts/release.mjs'
const lock = version => ({ version, packages: { '': { version } } })
test('release accepts matching stable package and lockfile versions', () => {
  assert.equal(releaseVersion({ name: 'ether-state', version: '0.2.2' }, lock('0.2.2')), '0.2.2')
})
test('release rejects prereleases, invalid versions, wrong names, and stale lockfiles', () => {
  for (const version of ['0.3.0-experimental.0', 'v0.2.2', '01.2.2', '0.2', '0.2.2+build']) {
    assert.throws(() => releaseVersion({ name: 'ether-state', version }, lock(version)))
  }
  assert.throws(() => releaseVersion({ name: 'other', version: '0.2.2' }, lock('0.2.2')))
  assert.throws(() => releaseVersion({ name: 'ether-state', version: '0.2.2' }, lock('0.2.1')))
})

test('release skips existing versions and prevents npm latest downgrades', () => {
  const metadata = { versions: { '0.2.1': {} }, 'dist-tags': { latest: '0.2.1' } }
  assert.equal(shouldPublish('0.2.1', metadata), false)
  assert.equal(shouldPublish('0.2.2', metadata), true)
  assert.throws(() => shouldPublish('0.1.9', metadata), /downgrade/)
  assert.throws(() => shouldPublish('0.2.2', {}), /missing/)
})
