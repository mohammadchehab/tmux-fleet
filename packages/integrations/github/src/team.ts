/**
 * The `TeamDirectory` port over `gh api` (shared-fleet.md §5.1): an
 * engagement's members are a GitHub team, and each member's public SSH keys are
 * what their copy of the engagement key is wrapped to.
 *
 * Both reads go through the authenticated API. `github.com/<user>.keys` is the
 * anonymous shortcut, and it returns 404 for an enterprise-managed account —
 * which is every account this is for.
 *
 * A read that fails throws. It never answers "nobody": an empty team would
 * rotate every member out of the key, so the only way to get one is for GitHub
 * to say the team is empty.
 */

import { fleetError } from '@fleet/foundation-core'
import type { TeamDirectory } from '@fleet/foundation-contracts'
import { createGh, type Gh, type GhResult } from './gh.ts'

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/

/** One value per line, as `--jq '.[].x'` prints a paginated list. */
const lines = (result: GhResult): string[] =>
  result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

export const createGitHubTeamDirectory = (options: { readonly gh?: Gh } = {}): TeamDirectory => {
  const gh = options.gh ?? createGh()

  const read = async (path: string, field: string): Promise<string[]> => {
    const result = await gh.run(['api', '--paginate', path, '--jq', `.[].${field}`])
    if (result.code !== 0) {
      throw fleetError('external_failed', `gh api ${path} exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
        details: { path, exitCode: result.code },
      })
    }
    return lines(result)
  }

  return {
    async members(team) {
      const [org, slug, ...rest] = team.split('/')
      if (org === undefined || slug === undefined || rest.length > 0 || !SLUG.test(org) || !SLUG.test(slug)) {
        throw fleetError('invalid_input', `a team is <org>/<slug>, got ${JSON.stringify(team)}`)
      }
      const logins = await read(`orgs/${org}/teams/${slug}/members`, 'login')
      const odd = logins.find((login) => !LOGIN.test(login))
      if (odd !== undefined) throw fleetError('external_failed', `gh listed a member that is not a GitHub login: ${JSON.stringify(odd.slice(0, 60))}`)
      return [...new Set(logins)].sort()
    },

    async sshKeys(user) {
      if (!LOGIN.test(user)) throw fleetError('invalid_input', `not a GitHub login: ${JSON.stringify(user)}`)
      return read(`users/${user}/keys`, 'key')
    },
  }
}
