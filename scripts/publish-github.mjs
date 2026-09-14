import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureGitHubRelease, githubPackageManifest, registryVersion } from './github-release.mjs'
import { releaseVersion, shouldPublish } from './release.mjs'

if (process.env['GITHUB_REF'] !== 'refs/heads/release' || process.env['GITHUB_REPOSITORY'] !== '0xjimmy/ether-state' || process.env['GITHUB_EVENT_NAME'] !== 'push') {
  throw new Error('GitHub publishing requires a push to 0xjimmy/ether-state release')
}
const token = process.env['GH_TOKEN']
if (!token) throw new Error('GH_TOKEN is required')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const version = releaseVersion(pkg, JSON.parse(await readFile('package-lock.json', 'utf8')))
const metadata = await registryVersion(`https://registry.npmjs.org/ether-state/${version}`, { attempts: 60 })
if (metadata === undefined) throw new Error('Published npm version is not available yet; rerun the job')
const tarballUrl = new URL(metadata.dist.tarball)
if (tarballUrl.origin !== 'https://registry.npmjs.org') throw new Error('Unexpected npm tarball origin')
const response = await fetch(tarballUrl)
if (!response.ok) throw new Error(`Tarball download failed: ${response.status}`)
const bytes = Buffer.from(await response.arrayBuffer())
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
if (integrity !== metadata.dist.integrity) throw new Error('npm tarball integrity mismatch')
const directory = path.resolve('.tmp/github-package')
await rm(directory, { recursive: true, force: true })
await mkdir(directory, { recursive: true })
const archive = path.join(directory, 'npm.tgz')
await writeFile(archive, bytes)
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
if (!entries.every(entry => entry.startsWith('package/') && !entry.split('/').includes('..'))) {
  throw new Error('Unexpected path in npm archive')
}
execFileSync('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', directory])
const packageDirectory = path.join(directory, 'package')
const original = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
if (original.version !== version) throw new Error('Downloaded package version differs')
const scoped = githubPackageManifest(original)
const api = async (endpoint, { method = 'GET', body, allow404 = false } = {}) => {
  const result = await fetch(`https://api.github.com/repos/0xjimmy/ether-state/${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (allow404 && result.status === 404) return undefined
  if (!result.ok) throw new Error(`GitHub ${method} ${endpoint} failed: ${result.status}`)
  return result.json()
}
const release = await ensureGitHubRelease(api, version, scoped.gitHead)
console.log(`GitHub Release: ${release.html_url}`)
const githubMetadata = await registryVersion('https://npm.pkg.github.com/@0xjimmy%2fether-state', {
  headers: { Authorization: `Bearer ${token}` },
})
const alreadyPublished = githubMetadata?.versions?.[version]
if (alreadyPublished !== undefined) {
  if (alreadyPublished.gitHead !== scoped.gitHead) throw new Error('Existing GitHub package has a different source commit')
  console.log(`@0xjimmy/ether-state@${version} is already published`)
} else {
  if (githubMetadata !== undefined) shouldPublish(version, githubMetadata)
  await writeFile(path.join(packageDirectory, 'package.json'), `${JSON.stringify(scoped, null, 2)}\n`)
  const config = path.join(directory, '.npmrc')
  await writeFile(config, '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n')
  execFileSync('npm', ['publish', packageDirectory, '--registry=https://npm.pkg.github.com/', '--tag=latest', '--ignore-scripts', '--provenance=false'], {
    stdio: 'inherit',
    env: { ...process.env, NODE_AUTH_TOKEN: token, NPM_CONFIG_USERCONFIG: config },
  })
}
