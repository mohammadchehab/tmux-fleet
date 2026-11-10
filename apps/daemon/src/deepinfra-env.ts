/**
 * A DeepInfra peer's per-session env (§4, §13), and the one place the key is read.
 *
 * The token is not provider config — `DeepInfraProviderConfig` has no field for
 * it on purpose, and the adapter refuses a spec that names no endpoint or no
 * token. It belongs to **one session**, handed over in that session's
 * `SessionSpec.env`, because `Options.env` replaces the child's whole
 * environment: nothing is inherited, so a key cannot arrive at a peer that did
 * not ask for it (§4's "env drift", §14.1).
 *
 * Two sources, in the order v1 used, so an existing machine keeps working:
 *
 * 1. `tokenEnv` (default `DEEPINFRA_API_KEY`) in **fleetd's own** environment;
 * 2. `tokenFile` (default `$XDG_CONFIG_HOME/deepinfra/key`) — the first line.
 *
 * Read at every start, not once at boot: a rotated key takes effect on the next
 * session without restarting the daemon.
 *
 * What never happens: the token in a message, an event, an error detail or a
 * process argument. The Agent SDK takes the endpoint and the key as `env`, so
 * unlike v1's `tmux -L deepinfra ... -e ANTHROPIC_AUTH_TOKEN=…` there is no argv
 * to leak it into, and the errors below name the variable and the file rather
 * than quoting either one.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { fleetError } from '@fleet/foundation-core'
import { deepInfraEnv } from '@fleet/runtime-provider-deepinfra'

import type { Profile, PeerProfile } from './profile.ts'

/** The variable `tokenEnv` means when a profile does not name one. */
export const DEFAULT_DEEPINFRA_TOKEN_ENV = 'DEEPINFRA_API_KEY'

/** Where the key is looked for when a profile names no `tokenFile`. */
export const defaultDeepInfraTokenFile = (configHome: string): string => join(configHome, 'deepinfra', 'key')

/**
 * The name a profile uses for this provider. Both the profile reader and the
 * supervisor's key-identity check agree on it; it is written once, here.
 */
const DEEP_INFRA = 'deepinfra'

export interface DeepInfraEnvOptions {
  readonly profile: Pick<Profile, 'providers'>
  /** fleetd's own environment, so `tokenEnv` is a variable a test can set. */
  readonly environ: Readonly<Record<string, string | undefined>>
  /** The root the default `tokenFile` sits under: the profile's `configHome`. */
  readonly configHome: string
  /**
   * How the key file is read. Defaults to the real filesystem; a test passes a
   * reader so it never has to write a secret to disk to prove a refusal.
   */
  readonly readText?: (path: string) => Promise<string>
}

/**
 * The token for one session.
 *
 * @throws FleetError('config_mismatch') when neither source yields one. The
 * message names the variable and the path — a missing credential is a
 * configuration fault, and the two things the operator can act on are exactly
 * those two names. It never names the value, and never quotes the file.
 */
export const readDeepInfraToken = async (options: DeepInfraEnvOptions): Promise<string> => {
  const block = options.profile.providers?.deepinfra
  const name = block?.tokenEnv ?? DEFAULT_DEEPINFRA_TOKEN_ENV
  const fromEnv = options.environ[name]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()

  const file = block?.tokenFile ?? defaultDeepInfraTokenFile(options.configHome)
  const readText = options.readText ?? ((path: string) => readFile(path, 'utf8'))
  let source: string
  try {
    source = await readText(file)
  } catch (cause) {
    throw fleetError(
      'config_mismatch',
      `no DeepInfra token for this peer: ${name} is not set in fleetd's environment and ${file} could not be read`,
      { details: { env: name, file }, cause },
    )
  }
  // The first line only, as v1 read it: a key file that has grown a comment or a
  // second entry on later lines still yields the key it starts with.
  const [firstLine] = source.split('\n')
  const token = (firstLine ?? '').trim()
  if (token === '') {
    throw fleetError('config_mismatch', `no DeepInfra token: ${file} is empty and ${name} is not set`, {
      details: { env: name, file },
    })
  }
  return token
}

/**
 * The env a peer needs beyond its identity: the endpoint, the key, and every
 * model key pinned to the model the profile gave it.
 *
 * Returns an empty fragment for a peer on another provider — this is the only
 * provider whose session needs more than a process to run.
 */
export const createProviderEnv =
  (options: DeepInfraEnvOptions) =>
  async (peer: PeerProfile): Promise<Readonly<Record<string, string>>> => {
    if (peer.provider !== DEEP_INFRA) return {}
    const block = options.profile.providers?.deepinfra
    const token = await readDeepInfraToken(options)
    return deepInfraEnv(token, {
      model: peer.model,
      ...(block?.baseUrl === undefined ? {} : { baseUrl: block.baseUrl }),
    })
  }
