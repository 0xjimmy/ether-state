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
for (const file of [
  'dist/esm/index.js', 'dist/esm/index.d.ts', 'dist/cjs/index.cjs',
  'dist/esm/viem.js', 'dist/esm/viem.d.ts', 'dist/cjs/viem.cjs',
  'dist/esm/indexer.js', 'dist/esm/indexer.d.ts', 'dist/cjs/indexer.cjs',
  'dist/esm/indexer-pglite.js', 'dist/esm/indexer-pglite.d.ts', 'dist/cjs/indexer-pglite.cjs',
  'dist/esm/indexer-libsql.js', 'dist/esm/indexer-libsql.d.ts', 'dist/cjs/indexer-libsql.cjs',
  'dist/esm/indexer-d1.js', 'dist/esm/indexer-d1.d.ts', 'dist/cjs/indexer-d1.cjs',
  'LICENSE', 'README.md'
]) {
  assert.ok(files.includes(file), `Missing package file: ${file}`)
}
assert.ok(files.every(file => file.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE'].includes(file)), 'Unexpected package file')
assert.ok(!files.some(file => /\/test\./.test(file)), 'Example must not ship')
await writeFile(path.join(directory, 'package.json'), '{"private":true,"type":"module"}')
run(['add', '--ignore-scripts', archive], directory)
run(['add', '--ignore-scripts', 'viem@2.56.5'], directory)
await copyFile('test/runtime-smoke.mjs', path.join(directory, 'runtime-smoke.mjs'))
await writeFile(path.join(directory, 'esm.mjs'), "import * as api from 'ether-state'; import { smoke } from './runtime-smoke.mjs'; await smoke(api);\n")
await writeFile(path.join(directory, 'cjs.cjs'), "const api = require('ether-state'); import('./runtime-smoke.mjs').then(({ smoke }) => smoke(api)).catch(error => { console.error(error); process.exitCode = 1; });\n")
await writeFile(path.join(directory, 'viem-esm.mjs'), "import { viemTransport } from 'ether-state/viem'; if (typeof viemTransport !== 'function') throw new Error('Missing Viem adapter');\n")
await writeFile(path.join(directory, 'viem-cjs.cjs'), "const { viemTransport } = require('ether-state/viem'); if (typeof viemTransport !== 'function') throw new Error('Missing Viem adapter');\n")
await writeFile(path.join(directory, 'indexer-esm.mjs'), "import { Indexer } from 'ether-state/indexer'; import { pgliteStore } from 'ether-state/indexer/pglite'; import { libsqlStore } from 'ether-state/indexer/libsql'; import { d1Store } from 'ether-state/indexer/d1'; if (![Indexer, pgliteStore, libsqlStore, d1Store].every(value => typeof value === 'function')) throw new Error('Missing indexer export');\n")
await writeFile(path.join(directory, 'indexer-cjs.cjs'), "const core = require('ether-state/indexer'); const pg = require('ether-state/indexer/pglite'); const libsql = require('ether-state/indexer/libsql'); const d1 = require('ether-state/indexer/d1'); if (![core.Indexer, pg.pgliteStore, libsql.libsqlStore, d1.d1Store].every(value => typeof value === 'function')) throw new Error('Missing indexer export');\n")
for (const file of ['esm.mjs', 'cjs.cjs', 'viem-esm.mjs', 'viem-cjs.cjs', 'indexer-esm.mjs', 'indexer-cjs.cjs']) run([file], directory)
const types = `import { EvmClient, getRpcEndpoints, getExplorers } from 'ether-state';
import type { EvmClientConfig } from 'ether-state';
import { viemTransport } from 'ether-state/viem';
import { createPublicClient } from 'viem';
import { Effect, Schema } from 'effect';
import { callbackStore, defineIndex, Indexer } from 'ether-state/indexer';
import { pgliteStore } from 'ether-state/indexer/pglite';
import { libsqlStore } from 'ether-state/indexer/libsql';
import { d1Store } from 'ether-state/indexer/d1';
import type { PGliteDatabase } from 'ether-state/indexer/pglite';
import type { LibsqlClient } from 'ether-state/indexer/libsql';
import type { D1Database } from 'ether-state/indexer/d1';
const config: EvmClientConfig = { network: { chainId: 1n } };
const evm = EvmClient.make(config);
void evm;
declare const client: EvmClient;
createPublicClient({ transport: viemTransport(client) });
defineIndex({ id: 'blocks', version: 1, startBlock: 0n, finality: { mode: 'latest' }, source: {},
  valueSchema: Schema.String, transform: () => Effect.succeed([{ key: 'block', value: 'ok' }]) });
declare const pg: PGliteDatabase;
declare const sqlite: LibsqlClient;
declare const d1: D1Database;
void pgliteStore(pg); void libsqlStore(sqlite); void d1Store(d1); void Indexer;
void callbackStore({ load: () => Effect.succeed(null), recent: () => Effect.succeed([]), write: () => Effect.void });
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
