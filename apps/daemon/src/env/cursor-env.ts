/**
 * A cursor peer's key (§4, §13), for a machine that is not logged in (TASK-24).
 *
 * On a logged-in machine cursor authenticates the CLI itself and this file does
 * nothing: the route is **opt-in**, switched on only when the profile's `cursor`
 * block names a `tokenEnv` or a `tokenFile`. A profile never holds the key — only
 * where to find it — and the ambient `CURSOR_API_KEY` of fleetd is not routed
 * unless the profile asks, so a key cannot reach a peer that was not meant to
 * have it.
 *
 * Same two sources and the same rules as `deepinfra-env.ts`: the variable in
 * **fleetd's own** environment, then the first line of the named file, read at
 * every start so a rotated key needs no restart. It is handed over in that one
 * session's `SessionSpec.env` (the cursor adapter spawns with an allowlisted env
 * plus the spec's, never `process.env`) and so appears in no argv, no event, no
 * error detail: the errors here name the variable and the path, never a value.
 */

import { readFile } from 'node:fs/promises'

import { fleetError } from '@fleet/foundation-core'

import { cursorForwardableEnv, type Profile } from '../config/profile.ts'
import type { DeepInfraEnvOptions } from './deepinfra-env.ts'

/** The variable cursor-agent reads, and the variable `tokenEnv` means when a profile names only a file. */
export const CURSOR_API_KEY_ENV = 'CURSOR_API_KEY'

/** Whether the profile asked for the key to be routed at all. */
export const cursorKeyRouted = (profile: Pick<Profile, 'providers'>): boolean => {
  const block = profile.providers?.cursor
  return block?.tokenEnv !== undefined || block?.tokenFile !== undefined
}

/**
 * The key for one session.
 *
 * @throws FleetError('config_mismatch') when neither source yields one; the
 * message names the variable and the file, never the value.
 */
export const readCursorToken = async (options: DeepInfraEnvOptions): Promise<string> => {
  const block = options.profile.providers?.cursor
  const name = block?.tokenEnv ?? CURSOR_API_KEY_ENV
  const fromEnv = options.environ[name]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()

  const file = block?.tokenFile
  if (file === undefined) {
    throw fleetError('config_mismatch', `no cursor key for this peer: ${name} is not set in fleetd's environment`, {
      details: { env: name },
    })
  }
  const readText = options.readText ?? ((path: string) => readFile(path, 'utf8'))
  let source: string
  try {
    source = await readText(file)
  } catch {
    // No `cause`: an fs error can quote a path, and a reader's error could quote anything.
    throw fleetError(
      'config_mismatch',
      `no cursor key for this peer: ${name} is not set in fleetd's environment and ${file} could not be read`,
      { details: { env: name, file } },
    )
  }
  const [firstLine] = source.split('\n')
  const token = (firstLine ?? '').trim()
  if (token === '') {
    throw fleetError('config_mismatch', `no cursor key: ${file} is empty and ${name} is not set`, {
      details: { env: name, file },
    })
  }
  return token
}

/** The fragment a cursor session needs beyond a process: the one variable. */
export const cursorEnv = (token: string): Readonly<Record<string, string>> => ({ [CURSOR_API_KEY_ENV]: token })

/**
 * The git/ssh credentials a cursor peer was explicitly given (TASK-80): the
 * variables the profile's `cursor.forwardEnv` names, copied from **fleetd's own**
 * environment.
 *
 * The sdk allowlist drops `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK` and `GIT_*`
 * by design, so without this a cursor peer cannot push. The route is opt-in and
 * by name — never "everything that looks like git" — and only names that match
 * `cursorForwardableEnv` are accepted (re-checked here, so a profile built
 * without the decoder cannot smuggle `CURSOR_API_KEY` or `AWS_*` through it; the
 * key has its own route above). A variable fleetd does not hold is skipped, not an
 * error: `SSH_AUTH_SOCK` is legitimately absent on a headless box. Values appear in
 * no message; nothing is read from files.
 */
export const readCursorForwardedEnv = (
  options: Pick<DeepInfraEnvOptions, 'profile' | 'environ'>,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {}
  for (const name of options.profile.providers?.cursor?.forwardEnv ?? []) {
    if (!cursorForwardableEnv.test(name)) {
      throw fleetError('config_mismatch', `cursor.forwardEnv names ${name}, which is not a git/ssh credential variable`, {
        details: { env: name },
      })
    }
    const value = options.environ[name]
    if (value !== undefined && value !== '') out[name] = value
  }
  return out
}
