import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const directory = path.join(root, '.tmp/package')
await rm(directory, { recursive: true, force: true })
await mkdir(directory, { recursive: true })
const manifest = await readFile('package.json', 'utf8')
const pkg = JSON.parse(manifest)
const archive = path.join(directory, `${pkg.name}-${pkg.version}.tgz`)
const run = (args, cwd = root) => execFileSync(process.execPath, args, { cwd, stdio: 'inherit' })
try {
  if (process.env.GITHUB_REF === 'refs/heads/release' && process.env.GITHUB_EVENT_NAME === 'push') {
    const gitHead = process.env.GITHUB_SHA
    assert.match(gitHead ?? '', /^[a-f0-9]{40}$/)
    await writeFile('package.json', JSON.stringify({ ...pkg, gitHead }))
  }
  run(['pm', 'pack', '--ignore-scripts', '--filename', archive, '--quiet'])
} finally {
  await writeFile('package.json', manifest)
}
const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').map(file => file.replace(/^package\//, ''))
for (const file of ['dist/esm/index.js', 'dist/esm/index.d.ts', 'dist/cjs/index.cjs', 'LICENSE', 'README.md']) {
  assert.ok(files.includes(file), `Missing package file: ${file}`)
}
assert.ok(files.every(file => file.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE'].includes(file)), 'Unexpected package file')
assert.ok(!files.some(file => /\/test\./.test(file)), 'Example must not ship')
await writeFile(path.join(directory, 'package.json'), '{"private":true,"type":"module"}')
run(['add', '--ignore-scripts', archive], directory)
await copyFile('test/runtime-smoke.mjs', path.join(directory, 'runtime-smoke.mjs'))
await writeFile(path.join(directory, 'esm.mjs'), "import * as api from 'ether-state'; import { smoke } from './runtime-smoke.mjs'; await smoke(api);\n")
await writeFile(path.join(directory, 'cjs.cjs'), "const api = require('ether-state'); import('./runtime-smoke.mjs').then(({ smoke }) => smoke(api)).catch(error => { console.error(error); process.exitCode = 1; });\n")
for (const file of ['esm.mjs', 'cjs.cjs']) run([file], directory)
const types = `import { EvmClient, getRpcEndpoints, getExplorers } from 'ether-state';
import type { EvmClientConfig } from 'ether-state';
const config: EvmClientConfig = { network: { chainId: 1n } };
void EvmClient.make(config);
void getRpcEndpoints(1n);
void getExplorers(8453n);
// @ts-expect-error Chain IDs use bigint.
EvmClient.make({network: {chainId: '1'}});
// @ts-expect-error Missing network.
EvmClient.make({});
`
for (const extension of ['mts', 'cts']) await writeFile(path.join(directory, `consumer.${extension}`), types)
run([path.join(root, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--noEmit', '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM,ESNext.Disposable', 'consumer.mts', 'consumer.cts'], directory)
console.log(`Verified ${pkg.name}@${pkg.version}: tarball, ESM, CommonJS, declarations`)
