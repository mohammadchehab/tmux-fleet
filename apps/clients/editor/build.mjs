/**
 * The bundle `vsce` packages (§8).
 *
 * Two things happen here and nothing else:
 *
 * 1. `src/extension.ts` — and only it — is what gets bundled; `vscode` stays
 *    external because the editor provides it at runtime.
 * 2. `dist/` becomes an extension directory `vsce` understands: its own
 *    `package.json` (the manifest plus the version from this package, so there
 *    is one place to bump), the licence, the readme and the icon.
 *
 * The design wrote down a rule that this file keeps: the packaged manifest must
 * not need `--allow-missing-repository` or `--skip-license` to get through
 * `vsce`, because those flags hide the two things a marketplace listing needs.
 * `repository` is injected below from the git remote so it cannot drift.
 *
 * Run with `pnpm --filter @fleet/app-editor build`, then:
 *
 *     cd apps/clients/editor && node build.mjs
 *     cd dist && npx vsce package --out ../../../dist/fleet-editor-0.0.0.vsix
 */

import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, 'dist')

const packageJson = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(here, 'manifest.json'), 'utf8'))

/** The remote the repository was cloned from, so the packaged manifest points somewhere real. */
const remote = (() => {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: here, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
})()

const repositoryUrl = remote === '' ? 'https://github.com/mohammadchehab/tmux-fleet.git' : remote

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

await build({
  entryPoints: [join(here, 'src', 'extension.ts')],
  outfile: join(dist, 'extension.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  // The workspace packages are bundled in; the editor is not, because the
  // extension host supplies it.
  external: ['vscode'],
  target: 'node20',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
})

await writeFile(
  join(dist, 'package.json'),
  `${JSON.stringify(
    {
      ...manifest,
      version: packageJson.version,
      repository: { type: 'git', url: repositoryUrl },
      bugs: { url: `${repositoryUrl.replace(/\.git$/, '')}/issues` },
      homepage: `${repositoryUrl.replace(/\.git$/, '')}#readme`,
    },
    null,
    2,
  )}\n`,
)

for (const file of ['LICENSE', 'README.md']) {
  await cp(join(here, file), join(dist, file))
}
await mkdir(join(dist, 'media'), { recursive: true })
await cp(join(here, 'media', 'icon.svg'), join(dist, 'media', 'icon.svg'))

// Everything in `dist` is meant to ship; the list makes a stray sourcemap or a
// build artefact visible in the .vsix listing instead of silently included.
await writeFile(join(dist, '.vscodeignore'), ['*.map', '**/*.ts', 'node_modules/**', '.vscodeignore'].join('\n') + '\n')

console.log(`built ${join(dist, 'extension.cjs')}`)
