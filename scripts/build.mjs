import { execFileSync } from 'node:child_process'
import { rm } from 'node:fs/promises'

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true })
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' })
const result = await Bun.build({
  entrypoints: ['src/index.ts', 'src/viem.ts', 'src/indexer.ts', 'src/indexer-pglite.ts', 'src/indexer-postgres.ts', 'src/indexer-libsql.ts', 'src/indexer-d1.ts'],
  outdir: 'dist/cjs', naming: '[name].cjs', target: 'node', format: 'cjs', packages: 'external'
})
if (!result.success) throw new AggregateError(result.logs, 'CommonJS build failed')
