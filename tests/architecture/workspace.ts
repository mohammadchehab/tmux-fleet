// tests/architecture/workspace.ts — read the workspace off disk: its packages, and every import that crosses a
// package boundary. Used only by dependency-rules.test.ts; the rules themselves live in rules.ts.
//
// Two things this has to catch, because both are ways to get around a package-name check:
//   1. a relative path that climbs out of its own package (`../../runtime/providers/sdk/src/index.ts`);
//   2. a deep import into another package (`@fleet/foundation-store/src/sqlite.ts`) instead of its entry point.

import { readFile, readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { locate, type ImportEdge, type PackageManifest, type PackageRef, type Violation } from './rules.ts'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

const SKIP_DIRS = new Set(['node_modules', '.git', 'docs', '.claude', 'dist'])

/** Every directory that holds a package.json under packages/ and apps/. */
async function packageDirs(root: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(join(root, dir), { withFileTypes: true })
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) found.push(dir)
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
      await walk(posix.join(dir, entry.name))
    }
  }
  for (const top of ['packages', 'apps']) {
    try {
      await walk(top)
    } catch {
      // a phase that has not created this top-level folder yet
    }
  }
  return found.sort()
}

/** All .ts files under a package, as POSIX paths from the repo root. */
async function tsFiles(root: string, dir: string): Promise<string[]> {
  const files: string[] = []
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(join(root, rel), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const child = posix.join(rel, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(child)
    }
  }
  await walk(dir)
  return files
}

export async function readPackages(root = REPO_ROOT): Promise<PackageRef[]> {
  const packages: PackageRef[] = []
  for (const dir of await packageDirs(root)) {
    const raw = await readFile(join(root, dir, 'package.json'), 'utf8')
    const { name } = JSON.parse(raw) as { name?: string }
    if (!name) continue
    // A directory outside the §1.1 layout still comes back, with a group the shape check rejects, so a package
    // dropped in the wrong place fails the build instead of disappearing from the scan.
    const parts = dir.split('/')
    const where = locate(dir) ?? {
      group: parts[1] ?? '',
      key: parts.slice(2).join('/'),
    }
    packages.push({ name, dir, group: where.group, key: where.key })
  }
  return packages
}

/** Each package with the dependency lists its package.json declares; the §17 tooling rule reads those. */
export async function readManifests(
  root = REPO_ROOT,
): Promise<{ readonly pkg: PackageRef; readonly manifest: PackageManifest }[]> {
  const byDir = new Map((await readPackages(root)).map((pkg) => [pkg.dir, pkg]))
  const out: { pkg: PackageRef; manifest: PackageManifest }[] = []
  for (const [dir, pkg] of byDir) {
    const { dependencies, devDependencies } = JSON.parse(await readFile(join(root, dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    out.push({
      pkg,
      manifest: {
        ...(dependencies === undefined ? {} : { dependencies }),
        ...(devDependencies === undefined ? {} : { devDependencies }),
      },
    })
  }
  return out.sort((a, b) => (a.pkg.dir < b.pkg.dir ? -1 : a.pkg.dir > b.pkg.dir ? 1 : 0))
}

// `from 'x'` on a line, `import 'x'`, and `import('x')`. Good enough for a dependency guard because every edge in
// this codebase is a static top-level import; a `from`/`import` inside a string literal would not be one.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"`]+)['"]/g

/** The import specifiers of one source file, with their line numbers. */
export function specifiersOf(source: string): { specifier: string; line: number }[] {
  const out: { specifier: string; line: number }[] = []
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trimStart()
    // a commented-out import is not an import
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    for (const match of line.matchAll(SPECIFIER)) {
      if (match[1]) out.push({ specifier: match[1], line: index + 1 })
    }
  }
  return out
}

/**
 * Every import of `pkg`'s files that resolves to another workspace package, plus the relative paths that try to
 * climb out of `pkg` (which no package-name rule would otherwise see).
 */
export async function readEdges(
  root: string,
  pkg: PackageRef,
  byName: ReadonlyMap<string, PackageRef>,
): Promise<{ edges: ImportEdge[]; escapes: Violation[] }> {
  const edges: ImportEdge[] = []
  const escapes: Violation[] = []
  for (const file of await tsFiles(root, pkg.dir)) {
    const source = await readFile(join(root, file), 'utf8')
    for (const { specifier, line } of specifiersOf(source)) {
      if (specifier.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(file), specifier))
        if (!target.startsWith(`${pkg.dir}/`)) {
          escapes.push({
            file,
            line,
            package: pkg.name,
            message: `relative import '${specifier}' climbs out of its own package; import a workspace package by name instead`,
          })
        }
        continue
      }
      const match = /^(@fleet\/[^/]+)((?:\/.*)?)$/.exec(specifier)
      if (!match) continue // a node: builtin or a third-party dependency
      const [, name, subpath = ''] = match
      const target = byName.get(name as string)
      if (target) {
        if (subpath) {
          escapes.push({
            file,
            line,
            package: pkg.name,
            message: `deep import '${specifier}'; import ${name} by its package name, which is what its exports map serves`,
          })
          continue
        }
        edges.push({ from: pkg.name, to: target.name, file, line, specifier })
      } else {
        escapes.push({
          file,
          line,
          package: pkg.name,
          message: `'${specifier}' names no package of this workspace (a typo, or a package.json is missing)`,
        })
      }
    }
  }
  return { edges, escapes }
}
