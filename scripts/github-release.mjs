export function githubPackageManifest(pkg) {
  if (pkg.name !== 'ether-state' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error('Expected a stable ether-state package')
  }
  if (!/^[a-f0-9]{40}$/.test(pkg.gitHead)) throw new Error('Published package has no valid source commit')
  return {
    ...pkg,
    name: '@0xjimmy/ether-state',
    repository: { type: 'git', url: 'git+https://github.com/0xjimmy/ether-state.git' },
    publishConfig: { registry: 'https://npm.pkg.github.com/', access: 'public', provenance: false },
  }
}

export async function ensureGitHubRelease(api, version, sourceCommit) {
  const tag = `v${version}`
  const ref = await api(`git/ref/tags/${tag}`, { allow404: true })
  if (ref !== undefined) {
    let object = ref.object
    for (let depth = 0; object.type === 'tag' && depth < 5; depth++) {
      object = (await api(`git/tags/${object.sha}`)).object
    }
    if (object.type !== 'commit' || object.sha !== sourceCommit) {
      throw new Error(`${tag} does not point to the published source commit`)
    }
  }
  const existing = await api(`releases/tags/${tag}`, { allow404: true })
  if (existing !== undefined) {
    if (ref === undefined || existing.draft || existing.prerelease) throw new Error('Existing release is not a complete stable release')
    return existing
  }
  return api('releases', {
    method: 'POST',
    body: { tag_name: tag, target_commitish: sourceCommit, name: tag, generate_release_notes: true, draft: false, prerelease: false, make_latest: 'legacy' },
  })
}

export async function registryVersion(url, { headers = {}, attempts = 1, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), request = fetch } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await request(url, { headers })
    if (response.ok) return response.json()
    if (response.status !== 404) throw new Error(`Registry request failed: ${response.status}`)
    if (attempt + 1 < attempts) await wait(5000)
  }
  return undefined
}
