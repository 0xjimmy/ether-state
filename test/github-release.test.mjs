import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { ensureGitHubRelease, githubPackageManifest, registryVersion } from '../scripts/github-release.mjs'
const sha = 'a'.repeat(40)

test('GitHub package changes only name, repository and registry metadata', () => {
  const pkg = { name: 'ether-state', version: '0.2.3', gitHead: sha, exports: { '.': './dist/index.js' }, dependencies: { effect: '^4.0.0-rc.115' }, publishConfig: { registry: 'https://registry.npmjs.org/' } }
  const result = githubPackageManifest(pkg)
  assert.equal(result.name, '@0xjimmy/ether-state')
  assert.equal(result.publishConfig.registry, 'https://npm.pkg.github.com/')
  assert.deepEqual(result.exports, pkg.exports)
  assert.deepEqual(result.dependencies, pkg.dependencies)
  assert.equal(pkg.name, 'ether-state')
  assert.throws(() => githubPackageManifest({ ...pkg, gitHead: undefined }), /source commit/)
  assert.throws(() => githubPackageManifest({ ...pkg, version: '0.2.3-beta.1' }), /stable/)
})

test('release uses published source commit and is idempotent', async () => {
  const calls = []
  const release = { html_url: 'https://github.com/0xjimmy/ether-state/releases/tag/v0.2.3', draft: false, prerelease: false }
  await ensureGitHubRelease(async (endpoint, options) => {
    calls.push({ endpoint, options })
    return endpoint === 'releases' ? release : undefined
  }, '0.2.3', sha)
  assert.equal(calls.at(-1).options.body.target_commitish, sha)
  assert.equal(calls.at(-1).options.body.tag_name, 'v0.2.3')
  assert.equal(calls.at(-1).options.body.generate_release_notes, true)
  assert.deepEqual(await ensureGitHubRelease(async endpoint => {
    if (endpoint.startsWith('git/ref/')) return { object: { type: 'commit', sha } }
    if (endpoint.startsWith('releases/tags/')) return release
    assert.fail('Rerun attempted to create a release')
  }, '0.2.3', sha), release)
})

test('release rejects an existing tag on a different commit', async () => {
  await assert.rejects(ensureGitHubRelease(async () => ({ object: { type: 'commit', sha: 'b'.repeat(40) } }), '0.2.3', sha), /published source/)
})

test('registry retries propagation delays but fails authentication errors', async () => {
  let calls = 0
  const options = { attempts: 3, wait: async () => {}, request: async () => ++calls < 3 ? { ok: false, status: 404 } : { ok: true, json: async () => ({ version: '0.2.3' }) } }
  assert.deepEqual(await registryVersion('https://example.test', options), { version: '0.2.3' })
  assert.equal(calls, 3)
  await assert.rejects(registryVersion('https://example.test', { request: async () => ({ ok: false, status: 401 }) }), /401/)
  assert.equal(await registryVersion('https://example.test', { request: async () => ({ ok: false, status: 404 }) }), undefined)
})
