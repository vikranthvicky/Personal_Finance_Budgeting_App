import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const cacheDirectory = join(resolve('.'), 'node_modules', '.cache')
await mkdir(cacheDirectory, { recursive: true })
const outputDirectory = await mkdtemp(join(cacheDirectory, 'pocketplan-tests-'))
try {
  await build({
    entryPoints: ['test/calculations.test.ts', 'test/server.integration.test.ts'],
    outdir: outputDirectory,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    packages: 'external',
    outExtension: { '.js': '.mjs' },
  })
  await cp('test/tsx-userinfo-shim.cjs', join(outputDirectory, 'tsx-userinfo-shim.cjs'))
  const files = ['calculations.test.mjs', 'server.integration.test.mjs'].map(file => join(outputDirectory, file))
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: resolve('.'), stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally {
  await rm(outputDirectory, { recursive: true, force: true })
}
