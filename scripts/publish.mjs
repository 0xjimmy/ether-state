import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { releaseVersion, shouldPublish } from './release.mjs'

if (process.env['GITHUB_REF'] !== 'refs/heads/release' || process.env['GITHUB_REPOSITORY'] !== '0xjimmy/ether-state' || process.env['GITHUB_EVENT_NAME'] !== 'push') {
  throw new Error('Publishing requires a push to 0xjimmy/ether-state release')
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const version = releaseVersion(pkg)
const response = await fetch('https://registry.npmjs.org/ether-state')
if (!response.ok) throw new Error(`Registry check failed: ${response.status}`)
const metadata = await response.json()
if (!shouldPublish(version, metadata)) {
  console.log(`ether-state@${version} is already published. No package was published.`)
} else {
  const filename = `.tmp/package/ether-state-${version}.tgz`
  execFileSync('npm', ['publish', filename, '--access', 'public', '--tag', 'latest', '--provenance', '--ignore-scripts'], { stdio: 'inherit' })
}
