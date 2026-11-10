/**
 * The one place a Jira token is read (§3).
 *
 * `JiraTrackerProfile` names where the token lives and never holds it: a profile
 * is a file in the repo's reach, and a token in it would be a token in
 * `git status`. The adapter takes a **resolved** credential, so the translation
 * from "where it lives" to "what to send" happens here, once — the same split
 * `deepinfra-env.ts` makes between a profile's `tokenEnv`/`tokenFile` and the
 * `env` a peer is started with.
 *
 * Two sources, `tokenEnv` first:
 *
 * 1. the variable `tokenEnv` names, defaulting per kind — `JIRA_API_TOKEN` for
 *    Cloud, `JIRA_PAT` for Server / Data Center, because the two kinds are
 *    issued by different systems and one machine may hold both;
 * 2. the file `tokenFile` names, defaulting to `$XDG_CONFIG_HOME/jira/token` —
 *    its **first line**, so a file that grew a comment still yields its key.
 *
 * Read once at compose rather than per call: a tracker is built once and lives
 * for the daemon's lifetime, so a rotated token takes effect on the next start.
 *
 * What never happens: the token in a message, an error detail, an event or a
 * process argument. The errors below name the variable and the file — the two
 * things an operator can act on — and quote neither.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { fleetError } from '@fleet/foundation-core'
import type { JiraAuth } from '@fleet/integrations-trackers-jira'

import type { JiraAuthProfile } from '../config/profile.ts'

/** The variable each kind means when a profile does not name one. */
export const DEFAULT_JIRA_TOKEN_ENV: Readonly<Record<JiraAuthProfile['kind'], string>> = {
  cloud: 'JIRA_API_TOKEN',
  pat: 'JIRA_PAT',
}

/** Where the token is looked for when a profile names no `tokenFile`. */
export const defaultJiraTokenFile = (configHome: string): string => join(configHome, 'jira', 'token')

export interface JiraEnvOptions {
  readonly auth: JiraAuthProfile
  /** fleetd's own environment, so `tokenEnv` is a variable a test can set. */
  readonly environ: Readonly<Record<string, string | undefined>>
  /** The root the default `tokenFile` sits under: the profile's `configHome`. */
  readonly configHome: string
  /**
   * How the token file is read. Defaults to the real filesystem; a test passes a
   * reader so it never has to write a secret to disk to prove a refusal.
   */
  readonly readText?: (path: string) => Promise<string>
}

/** The two sources a token can come from, without any one profile's identity. */
export type JiraCredentialSources = Omit<JiraEnvOptions, 'auth'>

/** The first non-empty line of the named variable, else of the named file. */
const readToken = async (name: string, file: string, options: JiraEnvOptions): Promise<string> => {
  const fromEnv = options.environ[name]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()

  const readText = options.readText ?? ((path: string) => readFile(path, 'utf8'))
  let source: string
  try {
    source = await readText(file)
  } catch (cause) {
    throw fleetError(
      'config_mismatch',
      `no Jira token for this site: ${name} is not set in fleetd's environment and ${file} could not be read`,
      { details: { env: name, file }, cause },
    )
  }
  const [firstLine] = source.split('\n')
  const token = (firstLine ?? '').trim()
  if (token === '') {
    throw fleetError('config_mismatch', `no Jira token: ${file} is empty and ${name} is not set`, {
      details: { env: name, file },
    })
  }
  return token
}

/**
 * The credential the adapter is built with: the profile's identity, plus the
 * token resolved from whichever source yields one.
 *
 * @throws FleetError('config_mismatch') when neither source yields one — a
 * missing credential is a configuration fault, not a site that refuses to
 * answer, and the sync would otherwise report `external_failed` forever.
 */
export const readJiraAuth = async (options: JiraEnvOptions): Promise<JiraAuth> => {
  const { auth } = options
  const name = auth.tokenEnv ?? DEFAULT_JIRA_TOKEN_ENV[auth.kind]
  const token = await readToken(name, auth.tokenFile ?? defaultJiraTokenFile(options.configHome), options)
  return auth.kind === 'cloud' ? { kind: 'cloud', email: auth.email, token } : { kind: 'pat', token }
}
