/**
 * `fleet editor install` / `fleet editor uninstall` (§8): the Fleet extension,
 * put into every editor host on this machine.
 *
 * The reason this is a CLI command and not a pair of instructions is the one the
 * spike measured: an editor's extension runs *where the code is*, so on a fleet
 * host reached over Remote-SSH the extension must be installed into that host's
 * editor *server*, not into the laptop's editor. A local `code
 * --install-extension` never carries a file-installed package across, so the
 * command has to run on the host that has the daemon — which is where a person
 * running the fleet already is.
 *
 * Two host kinds, found differently:
 *
 * - **`code` and `cursor` on `PATH`**, for the person editing the fleet locally;
 * - **editor servers under `~/.vscode-server` and `~/.cursor-server`**, which
 *   appear the first time an editor connects, and whose own CLIs are the only
 *   thing that can install into them.
 *
 * "Is it installed?" is answered by looking for the extension's directory rather
 * than by running `--list-extensions`: this runs on every `fleet up` (§8's one
 * line), and four editor CLIs are four slow processes to answer a question a
 * `readdir` answers exactly as well. Installing and uninstalling do run the CLI,
 * because those are the actions only it can perform.
 */

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** The extension's id, as `vsce` packaged it: `<publisher>.<name>` from the manifest. */
export const EXTENSION_ID = 'tmux-fleet.fleet-editor'

/** How a command ran, as far as this file cares. */
export interface EditorRun {
  readonly ok: boolean
  readonly output: string
}

export interface EditorDeps {
  /** The home the servers live under — the *remote* home under Remote-SSH, because that is where this runs. */
  readonly home: string
  readonly exists: (path: string) => boolean
  readonly readdir: (path: string) => Promise<readonly string[]>
  readonly run: (argv: readonly string[]) => Promise<EditorRun>
  /** Where the packaged `.vsix` is. Defaults to the checkout's build output. */
  readonly vsixDir?: string
  /** `process.env.PATH`, split by this file. */
  readonly pathValue: string
  readonly platform?: NodeJS.Platform
}

export interface EditorHost {
  /** For the report: `code`, `cursor`, `vscode-server`, `cursor-server`. */
  readonly name: string
  readonly kind: 'local' | 'server'
  /** The program to run: `code`, or an absolute path to a server's CLI. */
  readonly cli: string
  /** Where that editor keeps its extensions, so "is it installed?" is one `readdir`. */
  readonly extensionsDir: string
}

/** The editors `PATH` can offer, and where each keeps what it was given. */
const LOCAL_EDITORS: readonly { readonly name: string; readonly binary: string; readonly extensions: string }[] = [
  { name: 'code', binary: 'code', extensions: '.vscode/extensions' },
  { name: 'cursor', binary: 'cursor', extensions: '.cursor/extensions' },
]

/** The two roots an editor server can live under, and what its server CLI is called. */
const SERVER_ROOTS: readonly { readonly root: string; readonly name: string; readonly binary: string }[] = [
  { root: '.vscode-server', name: 'vscode-server', binary: 'code-server' },
  { root: '.cursor-server', name: 'cursor-server', binary: 'cursor-server' },
]

/** `which`, without a subprocess: the first executable match on `PATH`. */
export const whichBin = (
  bin: string,
  pathValue: string,
  exists: (path: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  const separator = platform === 'win32' ? ';' : ':'
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of pathValue.split(separator)) {
    if (dir === '') continue
    for (const suffix of suffixes) {
      const candidate = join(dir, `${bin}${suffix}`)
      if (exists(candidate)) return candidate
    }
  }
  return undefined
}

const list = async (deps: EditorDeps, path: string): Promise<readonly string[]> => {
  try {
    return await deps.readdir(path)
  } catch {
    return []
  }
}

/**
 * Every server CLI under one root. The two layouts are both real: `cli/servers/
 * Stable-<commit>/server/bin` is what a current editor writes, and `bin/<commit>/
 * bin` is what older ones left behind on a host.
 */
const serversUnder = async (deps: EditorDeps, root: string, binary: string, name: string): Promise<EditorHost[]> => {
  const base = join(deps.home, root)
  const found: EditorHost[] = []

  for (const commit of await list(deps, join(base, 'cli', 'servers'))) {
    const cli = join(base, 'cli', 'servers', commit, 'server', 'bin', binary)
    if (deps.exists(cli)) found.push({ name, kind: 'server', cli, extensionsDir: join(base, 'extensions') })
  }

  // Older layouts: `bin/<commit>/bin/<binary>`, and cursor's `bin/<platform>/<commit>/bin/<binary>`.
  for (const entry of await list(deps, join(base, 'bin'))) {
    for (const candidate of [
      join(base, 'bin', entry, 'bin', binary),
      ...(await list(deps, join(base, 'bin', entry))).map((nested) => join(base, 'bin', entry, nested, 'bin', binary)),
    ]) {
      if (deps.exists(candidate)) found.push({ name, kind: 'server', cli: candidate, extensionsDir: join(base, 'extensions') })
    }
  }

  return found
}

export const editorHosts = async (deps: EditorDeps): Promise<readonly EditorHost[]> => {
  const hosts: EditorHost[] = []

  for (const { name, binary, extensions } of LOCAL_EDITORS) {
    const cli = whichBin(binary, deps.pathValue, deps.exists, deps.platform)
    if (cli !== undefined) {
      hosts.push({ name, kind: 'local', cli, extensionsDir: join(deps.home, extensions) })
    }
  }

  for (const { root, name, binary } of SERVER_ROOTS) {
    hosts.push(...(await serversUnder(deps, root, binary, name)))
  }

  return hosts
}

/** Installed means: an extensions directory entry for this extension, whatever version it is. */
export const installedIn = async (deps: EditorDeps, host: EditorHost): Promise<boolean> => {
  const entries = await list(deps, host.extensionsDir)
  return entries.some((entry) => entry === EXTENSION_ID || entry.startsWith(`${EXTENSION_ID}-`))
}

/** The hosts without the extension, by name — what `fleet up` prints a line about (§8). */
export const editorsMissingExtension = async (deps: EditorDeps): Promise<readonly string[]> => {
  const missing: string[] = []
  for (const host of await editorHosts(deps)) {
    if (!(await installedIn(deps, host))) missing.push(host.name)
  }
  // Several servers of the same editor are one line, not four.
  return [...new Set(missing)]
}

/** The `.vsix` to install: the one named, or the newest the checkout built. */
export const findVsix = async (deps: EditorDeps, explicit: string | undefined): Promise<string | undefined> => {
  if (explicit !== undefined) return deps.exists(explicit) ? explicit : undefined

  const dir = deps.vsixDir ?? join(deps.home, '.fleet', 'editor')
  const candidates = (await list(deps, dir)).filter((entry) => entry.endsWith('.vsix')).sort()
  const newest = candidates.at(-1)
  return newest === undefined ? undefined : join(dir, newest)
}

export interface EditorReport {
  /** One line per host, in the order they were tried. */
  readonly lines: readonly string[]
  /** How many hosts the action succeeded on; zero is a failure worth a non-zero exit. */
  readonly succeeded: number
}

/**
 * Install into every host found. `--force` because a version already there is the
 * common case — a person upgrading the fleet runs this again — and the point of
 * the command is "make the hosts match what I just built", not "install if
 * absent".
 */
export const installEditor = async (deps: EditorDeps, vsix: string): Promise<EditorReport> => {
  const lines: string[] = []
  let succeeded = 0
  for (const host of await editorHosts(deps)) {
    const result = await deps.run([host.cli, '--install-extension', vsix, '--force'])
    lines.push(
      result.ok
        ? `installed in ${host.name} (${host.kind})`
        : `failed in ${host.name} (${host.kind}): ${result.output.trim()}`,
    )
    if (result.ok) succeeded += 1
  }
  return { lines, succeeded }
}

export const uninstallEditor = async (deps: EditorDeps): Promise<EditorReport> => {
  const lines: string[] = []
  let succeeded = 0
  for (const host of await editorHosts(deps)) {
    if (!(await installedIn(deps, host))) {
      lines.push(`not installed in ${host.name} (${host.kind})`)
      continue
    }
    const result = await deps.run([host.cli, '--uninstall-extension', EXTENSION_ID])
    lines.push(
      result.ok
        ? `removed from ${host.name} (${host.kind})`
        : `failed in ${host.name} (${host.kind}): ${result.output.trim()}`,
    )
    if (result.ok) succeeded += 1
  }
  return { lines, succeeded }
}

/** The object `run.ts` and `main.ts` pass around, so the CLI has one editor dependency and no half of one. */
export interface EditorCommands {
  readonly install: (vsix: string | undefined) => Promise<string>
  readonly uninstall: () => Promise<string>
  /** Hosts on this machine without the extension; `fleet up` prints one line when it is non-empty (§8). */
  readonly missing: () => Promise<readonly string[]>
}

export const editorCommands = (deps: EditorDeps): EditorCommands => ({
  install: async (vsix) => {
    const chosen = await findVsix(deps, vsix)
    if (chosen === undefined) {
      const dir = deps.vsixDir ?? join(deps.home, '.fleet', 'editor')
      throw new Error(
        `no .vsix to install: nothing under ${dir}. Build it with \`pnpm --filter @fleet/app-editor package\`, or name one with --vsix <path>`,
      )
    }
    const result = await installEditor(deps, chosen)
    if (result.succeeded === 0) {
      throw new Error([...result.lines, 'no editor was found on this machine to install into'].join('\n'))
    }
    return result.lines.join('\n')
  },
  uninstall: async () => (await uninstallEditor(deps)).lines.join('\n'),
  missing: async () => editorsMissingExtension(deps),
})

/** The real deps, for `main.ts`: real paths, real `PATH`, real subprocesses. */
export const nodeEditorDeps = async (overrides: Partial<EditorDeps> = {}): Promise<EditorDeps> => ({
  home: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
  exists: existsSync,
  readdir: async (path) => readdir(path),
  pathValue: process.env['PATH'] ?? '',
  run: async (argv) => {
    const { execFile } = await import('node:child_process')
    return new Promise((resolve) => {
      const [command, ...args] = argv
      if (command === undefined) {
        resolve({ ok: false, output: 'nothing to run' })
        return
      }
      execFile(command, args, { timeout: 120_000 }, (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`
        resolve({ ok: error === null, output: error === null ? output : `${output}${error.message}` })
      })
    })
  },
  ...overrides,
})
