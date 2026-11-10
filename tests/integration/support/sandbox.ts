/**
 * A whole fleet in a temp directory, for the §15 integration tests.
 *
 * Nothing here is a stand-in except the agent: `compose()` is the production
 * composition root, the store is the real SQLite store, the supervisor and the
 * scheduler are the real ones, and the client talks to the daemon over the real
 * Unix socket with the real `rpcCall`. The only injected thing is the provider,
 * because a CI run has no Claude subscription and no DeepInfra key.
 *
 * Two roots, as in production (§2's "On disk"): a temp `$HOME` holding
 * `~/.fleet/<profile>/`, and a temp `$XDG_CONFIG_HOME` holding the profile YAML.
 * Neither is a real repository, and the temp dir is removed on teardown — the
 * CI check that `git status` is unchanged after `pnpm test` depends on that.
 *
 * Every routine is disabled: §6's routines are real behaviour tested elsewhere,
 * and a timer firing mid-assertion would make these tests flaky in a way that
 * says nothing about the lifecycle.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BranchHead, DaemonMethod, DaemonResponse } from '../../../packages/foundation/contracts/src/index.ts'
import { profilePaths, type ProfilePaths } from '../../../packages/foundation/core/src/index.ts'
import { compose, type Composed } from '../../../apps/daemon/src/compose.ts'
import { stateFilePathOf } from '../../../apps/daemon/src/sessions.ts'
import { rpcCall } from '../../../apps/daemon/src/server.ts'
import type { Notifier } from '../../../packages/notify/core/src/index.ts'
import type { ToolIo } from '../../../packages/security/scanners/src/index.ts'
import { createScriptedProvider, type ScriptedOptions, type ScriptedProvider } from './scripted-provider.ts'

/** §6's routines, all off; a lifecycle test asserts about turns, not timers. */
const allRoutinesOff = {
  routines: {
    dispatch: { enabled: false },
    'keep-busy': { enabled: false },
    'pr-babysit': { enabled: false },
    standup: { enabled: false },
    'worktree-gc': { enabled: false },
    reconcile: { enabled: false },
    'security-scan': { enabled: false },
    notify: { enabled: false },
  },
} as const

export interface SandboxPeer {
  readonly id: string
  readonly role: string
  /** Defaults to `claude`, which is the scripted provider in every test that uses this. */
  readonly provider?: string
  readonly model?: string
}

/** §15: one architect and two engineers, unless a test says otherwise. */
export const squadPeers: readonly SandboxPeer[] = [
  { id: 'architect', role: 'architect', model: 'test-large' },
  { id: 'engineer-1', role: 'engineer', model: 'test-small' },
  { id: 'engineer-2', role: 'engineer', model: 'test-small' },
]

export interface SandboxOptions {
  readonly peers?: readonly SandboxPeer[]
  readonly repos?: readonly string[]
  readonly scripted?: ScriptedOptions
  /** §6.1's `notify.channel`, when a test wants the `notify` routine switched on at all. */
  readonly notify?: 'macos' | 'none'
  /** The channel to deliver through, so a test never puts a banner on a real screen. */
  readonly notifier?: Notifier
  /** §6.2's `security.scanners`; absent means no `security-scan` routine is installed. */
  readonly security?: readonly string[]
  /** How the scanners reach their tools, so a test never needs semgrep installed. */
  readonly securityIo?: ToolIo
  /** How the nightly scan names `main`'s head, so a test never fetches a remote (§9). */
  readonly branchHead?: BranchHead
}

/** An event as these tests read it: only the three fields any assertion here needs. */
export interface SandboxEvent {
  readonly type: string
  readonly subject?: string
  readonly data: Record<string, unknown>
}

export interface Sandbox {
  readonly kind: 'sandbox'
  readonly home: string
  readonly profileName: string
  readonly paths: ProfilePaths
  readonly composed: Composed
  readonly scripted: ScriptedProvider
  /** The peer's §8 state file, where the purge asks the peer to write it. */
  stateFile(peerId: string): string
  /** Everything the store has, oldest first — the record a test asserts against. */
  events(): Promise<readonly SandboxEvent[]>
  /** One socket round trip, unwrapped: the response as the CLI's client sees it. */
  raw(method: DaemonMethod, params?: unknown): Promise<DaemonResponse>
  /** One socket round trip, or a thrown `FleetError` carrying the daemon's code and message. */
  call<T>(method: DaemonMethod, params?: unknown): Promise<T>
  /** Stop the loops, close the socket and the store, then delete the temp directory. */
  stop(): Promise<void>
}

const profileYaml = (
  name: string,
  peers: readonly SandboxPeer[],
  repos: readonly string[],
  notify?: 'macos' | 'none',
  security?: readonly string[],
): string => {
  const lines = [`profile: ${name}`, 'repos:', ...repos.map((repo) => `  - ${repo}`), 'peers:']
  for (const peer of peers) {
    lines.push(`  - id: ${peer.id}`, `    role: ${peer.role}`, `    provider: ${peer.provider ?? 'claude'}`, `    model: ${peer.model ?? 'test-small'}`)
  }
  if (notify !== undefined) lines.push('notify:', `  channel: ${notify}`)
  if (security !== undefined) lines.push('security:', '  scanners:', ...security.map((scanner) => `    - ${scanner}`))
  lines.push('tickIntervalMs: 50', 'routines:', '  routines:')
  for (const [kind, settings] of Object.entries(allRoutinesOff.routines)) {
    // `notify` and `security-scan` are the two routines a test may want switched
    // on; without their profile block the daemon installs no body for them, so
    // they stay off with the rest.
    if (kind === 'notify' && notify === 'macos') continue
    if (kind === 'security-scan' && security !== undefined) continue
    lines.push(`    ${kind}: { enabled: ${String(settings.enabled)} }`)
  }
  return `${lines.join('\n')}\n`
}

const PROFILE_NAME = 'exit-test'

export const createSandbox = async (options: SandboxOptions = {}): Promise<Sandbox> => {
  const home = await mkdtemp(join(tmpdir(), 'fleet-it-'))
  const configHome = join(home, '.config')
  const peers = options.peers ?? squadPeers
  const repos = options.repos ?? ['sandbox/tmux-fleet']
  const paths = profilePaths(PROFILE_NAME, { home, configHome })

  await mkdir(join(configHome, 'fleet', 'profiles'), { recursive: true })
  await writeFile(paths.profileFile, profileYaml(PROFILE_NAME, peers, repos, options.notify, options.security), 'utf8')

  const scripted = createScriptedProvider({
    ...options.scripted,
    stateFile: (peerId) => stateFilePathOf(paths, peerId),
  })

  const composed = await compose({
    profileName: PROFILE_NAME,
    roots: { home, configHome },
    providers: new Map([['claude', scripted.provider]]),
    ...(options.notifier === undefined ? {} : { notifier: options.notifier }),
    ...(options.securityIo === undefined ? {} : { securityIo: options.securityIo }),
    ...(options.branchHead === undefined ? {} : { branchHead: options.branchHead }),
  })

  const raw = (method: DaemonMethod, params?: unknown): Promise<DaemonResponse> =>
    rpcCall(paths.socketPath, { id: `${method}-${String(Math.random()).slice(2, 8)}`, method, ...(params === undefined ? {} : { params }) })

  let stopped = false
  return {
    kind: 'sandbox',
    home,
    profileName: PROFILE_NAME,
    paths,
    composed,
    scripted,
    stateFile: (peerId) => stateFilePathOf(paths, peerId as never),
    async events(): Promise<readonly SandboxEvent[]> {
      // The window is the whole store: these tests are short and small, and a
      // test that reads "everything so far" never races the tail.
      const all = await composed.store.read(0, 10_000)
      return all as unknown as readonly SandboxEvent[]
    },
    raw,
    async call<T>(method: DaemonMethod, params?: unknown): Promise<T> {
      const response = await raw(method, params)
      if (!response.ok) {
        const error = new Error(`${method}: ${response.error.code}: ${response.error.message}`) as Error & { code: string }
        error.code = response.error.code
        throw error
      }
      return response.result as T
    },
    async stop() {
      if (stopped) return
      stopped = true
      // A test may already have called `down`, which closes the socket and the
      // store on its own tick; stopping twice is not an error worth failing on.
      for (const close of [() => composed.daemon.down(), () => composed.server.close(), () => composed.store.close()]) {
        try {
          await close()
        } catch {
          // Already closed, by `down` or by the previous line.
        }
      }
      await rm(home, { recursive: true, force: true })
    },
  }
}

/**
 * Poll until `condition` holds. The daemon's turns complete on its own clock —
 * a turn's events land on the next tick of the store, not on the caller's — so
 * a test waits for the observable state rather than sleeping a fixed time.
 */
export const until = async <T>(
  condition: () => Promise<T | undefined | false> | T | undefined | false,
  what: string,
  ms = 4_000,
): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await condition()
    if (value !== undefined && value !== false) return value as T
    if (Date.now() > deadline) throw new Error(`timed out after ${String(ms)}ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
