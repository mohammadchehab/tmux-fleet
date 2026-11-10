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

import type { Profile, PeerProfile, ProfileProvider, JudgeProfile } from '../config/profile.ts'

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
 * The env a model on `provider` needs beyond a process: the endpoint, the key,
 * and the model pinned to the id it was given.
 *
 * Keyed by provider and model rather than by a peer because §5.3's Judge call is
 * not a peer's session — and that is exactly the hole this closes. The Judge's
 * one-shot call used to be built with no env, so the allowlist fell back to
 * fleetd's own identity: on a machine with no Claude login it answered
 * `subtype: success` with no structured output, and on one that had a login it
 * silently ran as that login (§14.1's env drift). Nothing about the call needs a
 * peer, so nothing about the fragment should have required one.
 *
 * A provider whose auth is the machine's own (`claude`, `cursor`) gets an empty
 * fragment: there is no credential to hand over, and pretending otherwise would
 * be a token that does not exist. `deepinfra` is the one provider whose session
 * — and therefore whose Judge call — needs anything more than a process.
 */
export const providerEnvFor =
  (options: DeepInfraEnvOptions) =>
  async (provider: ProfileProvider, model: string): Promise<Readonly<Record<string, string>>> => {
    if (provider !== DEEP_INFRA) return {}
    const block = options.profile.providers?.deepinfra
    const token = await readDeepInfraToken(options)
    return deepInfraEnv(token, {
      model,
      ...(block?.baseUrl === undefined ? {} : { baseUrl: block.baseUrl }),
    })
  }

/** The fragment a peer's session gets: the peer's own provider and model. */
export const createProviderEnv = (options: DeepInfraEnvOptions) => {
  const envFor = providerEnvFor(options)
  return async (peer: PeerProfile): Promise<Readonly<Record<string, string>>> =>
    envFor(peer.provider, peer.model)
}

/**
 * The `env` §5.3's Judge transport is built with.
 *
 * A profile with no `judge:` block gets an empty fragment, which is the old
 * behaviour kept on purpose: that machine answers on its own login. A profile
 * that names one gets exactly what a peer on that provider would get, including
 * the refusal when the key is missing — so a `judge:` block is never silently
 * ignored, which was the whole failure this block exists to end.
 */
export const judgeEnvFor =
  (options: DeepInfraEnvOptions) =>
  async (judge: JudgeProfile | undefined): Promise<Readonly<Record<string, string>>> =>
    judge === undefined ? {} : providerEnvFor(options)(judge.provider, judge.model)
