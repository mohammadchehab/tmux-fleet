/**
 * The child's environment, built by allowlist (§4, §13).
 *
 * `Options.env` is the child process's *whole* environment: it replaces the
 * inherited one instead of merging into it (Agent SDK docs, and measured in the
 * §4 spike — `docs/design/spikes/agent-sdk.md`). Both ways of getting that wrong
 * showed up in v1 (§14.1):
 *
 * - too little: no `PATH`/`HOME`/`TMPDIR`, so every tool fails in a way that
 *   looks like a model error;
 * - too much: the fleet's own `ANTHROPIC_*` and `CLAUDE_CODE_*` leak into a peer,
 *   so a session meant for one endpoint silently runs on whatever endpoint the
 *   fleet process happens to use. The spike reproduced exactly that, and nothing
 *   in the stream flags it: only comparing `model()` against the spec catches it.
 *
 * So: a fixed allowlist of *process* variables from the parent, then the spec's
 * `env` verbatim, then nothing else. A spec entry wins over the allowlist.
 */

import { fleetError } from '@fleet/foundation-core'
import type { SessionSpec } from '@fleet/runtime-provider-sdk'

/**
 * Variables the child needs to be a working process, inherited from the parent.
 * Nothing here names a model, an endpoint or a credential: those belong to the
 * spec, which is built per session (§4).
 */
export const INHERITED_FROM_PARENT = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  // Windows, for a fleet that one day runs there; absent elsewhere and therefore ignored.
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
] as const

/**
 * Prefixes that must never cross from the parent into a peer by inheritance.
 * They are not forbidden in `spec.env` — that is how a peer is pointed at a
 * vendor endpoint — they are forbidden to arrive *unasked*.
 */
const NEVER_INHERITED = [/^ANTHROPIC_/, /^CLAUDE_/, /^CLAUDECODE$/, /^DEEPINFRA_/, /^MCP_/]

export const isNeverInherited = (key: string): boolean => NEVER_INHERITED.some((p) => p.test(key))

/** What the child env was built from, so a failure can say why rather than just what. */
export interface BuiltEnv {
  readonly env: Readonly<Record<string, string>>
  /** Parent variables that made it in, sorted; empty entries were absent from the parent. */
  readonly inherited: readonly string[]
  /** Parent variables dropped on purpose — the evidence for a `config_mismatch` report. */
  readonly withheld: readonly string[]
}

/**
 * Build one session's child env. Pure: the parent env is an argument, so the
 * rule is unit-testable and a replay can rebuild the same environment.
 *
 * @throws FleetError('invalid_input') when the result would not be runnable —
 * a child with no `PATH` is a bug in the caller, not a provider failure.
 */
export const buildChildEnv = (
  spec: Pick<SessionSpec, 'env' | 'peerId'>,
  parent: Readonly<Record<string, string | undefined>> = process.env,
): BuiltEnv => {
  const env: Record<string, string> = {}
  const inherited: string[] = []
  const dropped: string[] = []

  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if (isNeverInherited(key)) {
      dropped.push(key)
      continue
    }
    if ((INHERITED_FROM_PARENT as readonly string[]).includes(key)) {
      env[key] = value
      inherited.push(key)
    }
  }

  // The spec is authoritative. A key it sets overwrites an inherited one, and a
  // model/endpoint variable the parent had is *not* available to fill a gap.
  for (const [key, value] of Object.entries(spec.env)) env[key] = value

  // `withheld` is the drift a reviewer asks about: parent config the peer did
  // not ask for and did not get. One the spec sets itself is not withheld.
  const withheld = dropped.filter((key) => !Object.hasOwn(spec.env, key))

  if (!env.PATH) {
    throw fleetError('invalid_input', `peer ${spec.peerId}: the child env has no PATH`, {
      details: { inherited: inherited.sort(), withheld: withheld.sort() },
    })
  }

  return {
    env: Object.freeze(env),
    inherited: Object.freeze(inherited.sort()),
    withheld: Object.freeze(withheld.sort()),
  }
}

/**
 * The endpoint a child was pointed at, when the spec recorded one. `model()`
 * reports it so an operator can tell two sessions of the same vendor apart
 * (§4, §13); it is never inferred from the parent process.
 */
export const recordedEndpoint = (env: Readonly<Record<string, string>>): string | undefined =>
  env.ANTHROPIC_BASE_URL ?? env.ANTHROPIC_API_URL

/**
 * The model identity a spec's env pins, if any. The SDK's `options.model` is
 * the supported way to choose one; a spec that sets `ANTHROPIC_MODEL` instead
 * is honoured too, and this is what the start check compares against.
 */
export const recordedModel = (env: Readonly<Record<string, string>>): string | undefined => env.ANTHROPIC_MODEL
