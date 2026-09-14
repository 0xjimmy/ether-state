import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

const root = process.cwd()
const directory = path.join(root, '.tmp/package')
await rm(directory, { recursive: true, force: true })
await mkdir(directory, { recursive: true })
const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { encoding: 'utf8' }))[0]
const files = packed.files.map(file => file.path)
for (const file of ['dist/esm/index.js', 'dist/esm/index.d.ts', 'dist/cjs/index.js', 'dist/cjs/index.d.ts', 'dist/cjs/package.json', 'LICENSE', 'README.md']) {
  assert.ok(files.includes(file), `Missing package file: ${file}`)
}
assert.ok(files.every(file => file.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE'].includes(file)), 'Unexpected file in package')
await writeFile(path.join(directory, 'package.json'), '{"private":true,"type":"module"}\n')
execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `./${packed.filename}`], { cwd: directory, stdio: 'inherit' })
await copyFile('test/runtime-smoke.mjs', path.join(directory, 'runtime-smoke.mjs'))
await writeFile(path.join(directory, 'esm.mjs'), "import * as api from 'ether-state'; import * as ethers from 'ethers'; import { smoke } from './runtime-smoke.mjs'; if (await smoke(api, ethers) !== 'ok') throw Error('ESM failed');\n")
await writeFile(path.join(directory, 'cjs.cjs'), "const api = require('ether-state'); const ethers = require('ethers'); import('./runtime-smoke.mjs').then(({smoke}) => smoke(api, ethers)).catch(error => { console.error(error); process.exitCode = 1; });\n")
const runtime = process.env['TEST_RUNTIME'] ?? process.execPath
for (const file of ['esm.mjs', 'cjs.cjs']) execFileSync(runtime, [file], { cwd: directory, stdio: 'inherit' })
const types = `import { EtherState, TriggerType, createERC20BalanceAction } from 'ether-state';
import type { Action } from 'ether-state';
import { JsonRpcProvider } from 'ethers';
const action: Action = createERC20BalanceAction({type: TriggerType.BLOCK}, '0x00', '0x00', balance => { const typed: bigint = balance; return typed; });
const state = new EtherState([action], new JsonRpcProvider());
const done: Promise<void> = state.update(TriggerType.TIME);
void done;
// @ts-expect-error The callback must accept bigint.
createERC20BalanceAction({type: TriggerType.BLOCK}, '0x00', '0x00', (value: string) => value);
// @ts-expect-error Time triggers require an interval.
const invalid: Action['trigger'] = {type: TriggerType.TIME};
void invalid;
`
for (const extension of ['mts', 'cts']) await writeFile(path.join(directory, `consumer.${extension}`), types)
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--noEmit', '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--module', 'Node16', '--moduleResolution', 'Node16', '--target', 'ES2022', 'consumer.mts', 'consumer.cts'], { cwd: directory, stdio: 'inherit' })
await writeFile(path.join(directory, 'browser.mjs'), "import * as api from 'ether-state'; import * as ethers from 'ethers'; import { smoke } from './runtime-smoke.mjs'; smoke(api, ethers).then(result => { document.body.textContent = result; }).catch(error => { document.body.textContent = String(error); throw error; });\n")
await build({ entryPoints: [path.join(directory, 'browser.mjs')], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', outfile: path.join(directory, 'bundle.js') })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><title>ether-state package test</title><body>running<script type="module" src="/bundle.js"></script></body>')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
console.log(`Verified packed ${pkg.name}@${pkg.version}: ESM, CommonJS, declarations, browser bundle`)
