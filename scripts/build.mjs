import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true })
for (const config of ['tsconfig.json', 'tsconfig.cjs.json']) {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', config], { stdio: 'inherit' })
}
await mkdir('dist/cjs', { recursive: true })
await writeFile('dist/cjs/package.json', '{"type":"commonjs"}\n')
