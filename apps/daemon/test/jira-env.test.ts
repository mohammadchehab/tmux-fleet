/**
 * §3: the one place a Jira token is read, and what it is never allowed to reach
 * — a message, an error detail, an event.
 *
 * `profile.test.ts` covers the block that says *where* the token lives; what is
 * tested here is the daemon's half: which of the two sources wins, which
 * variable each kind means by default, and what a refusal is allowed to say.
 * The tokens below could not be real, so an accidental echo would be obvious.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_JIRA_TOKEN_ENV,
  defaultJiraTokenFile,
  readJiraAuth,
  type JiraEnvOptions,
} from '../src/env/jira-env.ts'
import type { JiraAuthProfile } from '../src/config/profile.ts'

const CONFIG_HOME = '/home/tester/.config'
const CLOUD: JiraAuthProfile = { kind: 'cloud', email: 'fleet@acme.test' }
const PAT: JiraAuthProfile = { kind: 'pat' }
const TOKEN = 'not-a-real-jira-token-0000'

const optionsWith = (
  auth: JiraAuthProfile,
  overrides: Partial<Omit<JiraEnvOptions, 'auth'>> = {},
): JiraEnvOptions => ({
  auth,
  environ: overrides.environ ?? {},
  configHome: overrides.configHome ?? CONFIG_HOME,
  ...(overrides.readText === undefined ? {} : { readText: overrides.readText }),
})

const code = (thrown: unknown): string | undefined => (thrown as { code?: string }).code

/** Everything an error would print if it were logged: message and details both. */
const rendered = (thrown: unknown): string =>
  JSON.stringify({ message: (thrown as Error).message, ...(thrown as { details?: unknown }) })

/** A reader that records what it was asked for, so a test can prove a file was never opened. */
const readerOf = (content: string): { readonly asked: string[]; readonly readText: (path: string) => Promise<string> } => {
  const asked: string[] = []
  return {
    asked,
    readText: async (path: string) => {
      asked.push(path)
      return content
    },
  }
}

describe('reading a Jira token', () => {
  it('takes fleetd’s environment first, and does not touch the file when it has one', async () => {
    const reader = readerOf('from-the-file\n')
    const auth = await readJiraAuth(
      optionsWith(CLOUD, { environ: { JIRA_API_TOKEN: TOKEN }, readText: reader.readText }),
    )
    assert.deepEqual(auth, { kind: 'cloud', email: 'fleet@acme.test', token: TOKEN })
    assert.deepEqual(reader.asked, [])
  })

  it('falls back to the first line of the token file when the variable is unset or blank', async () => {
    const file = defaultJiraTokenFile(CONFIG_HOME)
    for (const environ of [{}, { JIRA_API_TOKEN: '   ' }]) {
      const auth = await readJiraAuth(
        optionsWith(CLOUD, { environ, readText: async () => `${TOKEN}  \nsecond line is not the token\n` }),
      )
      assert.deepEqual(auth, { kind: 'cloud', email: 'fleet@acme.test', token: TOKEN })
    }
    assert.equal(file, '/home/tester/.config/jira/token')
  })

  it('means a different variable per kind, because the two are issued by different systems', async () => {
    assert.deepEqual(DEFAULT_JIRA_TOKEN_ENV, { cloud: 'JIRA_API_TOKEN', pat: 'JIRA_PAT' })

    // A PAT reads `JIRA_PAT`, and resolves to the token-only shape the adapter takes.
    const auth = await readJiraAuth(optionsWith(PAT, { environ: { JIRA_PAT: TOKEN, JIRA_API_TOKEN: 'ignored' } }))
    assert.deepEqual(auth, { kind: 'pat', token: TOKEN })
  })

  it('lets a profile name its own variable and file', async () => {
    const named: JiraAuthProfile = { kind: 'pat', tokenEnv: 'ACME_PAT', tokenFile: '/run/secrets/jira' }
    assert.deepEqual(
      await readJiraAuth(optionsWith(named, { environ: { ACME_PAT: TOKEN } })),
      { kind: 'pat', token: TOKEN },
    )

    const reader = readerOf(`${TOKEN}\n`)
    const fromFile = await readJiraAuth(optionsWith(named, { readText: reader.readText }))
    assert.deepEqual(fromFile, { kind: 'pat', token: TOKEN })
    assert.deepEqual(reader.asked, ['/run/secrets/jira'])
  })

  it('refuses with the variable and the path, never a value, when neither source yields one', async () => {
    const unreadable = new Error('ENOENT: no such file or directory')
    let thrown: unknown
    try {
      await readJiraAuth(
        optionsWith(CLOUD, {
          readText: async () => {
            throw unreadable
          },
        }),
      )
    } catch (error) {
      thrown = error
    }
    assert.equal(code(thrown), 'config_mismatch')
    assert.match(rendered(thrown), /JIRA_API_TOKEN/)
    assert.match(rendered(thrown), /\/home\/tester\/\.config\/jira\/token/)
  })

  it('refuses a token file that is empty rather than sending an empty credential', async () => {
    let thrown: unknown
    try {
      await readJiraAuth(optionsWith(PAT, { readText: async () => '\n\n' }))
    } catch (error) {
      thrown = error
    }
    assert.equal(code(thrown), 'config_mismatch')
    assert.match((thrown as Error).message, /is empty/)
    assert.match(rendered(thrown), /JIRA_PAT/)
  })
})
