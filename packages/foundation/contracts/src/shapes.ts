/**
 * Shapes shared by more than one event or projection. Kept in one place so a
 * PR reference or a severity has exactly one spelling across the fleet.
 */

import { number, object, objectAs, oneOf, positiveInt, refine, string, text, type Schema } from '@fleet/foundation-core'
import { repo, type Repo } from '@fleet/foundation-core'

/** A PR as everything refers to it: the repo and the number. */
export interface PullRequestRef {
  readonly repo: Repo
  readonly number: number
}

export const pullRequestRef = (): Schema<PullRequestRef> =>
  objectAs<PullRequestRef>()({ repo: repo(), number: positiveInt() })

/** An external tracker key (Jira, Backlog.md); a sink and a source, not the state (§3). */
export interface ExternalRef {
  readonly system: string
  readonly key: string
}

export const externalRef = (): Schema<ExternalRef> =>
  objectAs<ExternalRef>()({ system: string({ minLength: 1, maxLength: 40 }), key: string({ minLength: 1, maxLength: 80 }) })

/** A findings severity. `critical` is profile-defined; this is the scanner's own rating (§6.2). */
export const severities = ['info', 'low', 'medium', 'high', 'critical'] as const
export type Severity = (typeof severities)[number]
export const severity = (): Schema<Severity> => oneOf(severities)

/** The merge gate treats `medium` and up as work, `high` as now (§6.2). */
export const isActionable = (value: Severity): boolean =>
  value === 'medium' || value === 'high' || value === 'critical'

/** A file path inside a repository, POSIX-separated. */
export const filePath = (): Schema<string> =>
  refine(string({ minLength: 1, maxLength: 500 }), (v) => !v.startsWith('/'), 'a repository-relative path')

/** A branch name. */
export const branchName = (): Schema<string> =>
  refine(string({ minLength: 1, maxLength: 250 }), (v) => !v.startsWith('-'), 'a branch name')

/** A content hash, hex; what makes a Contract version real (§12). */
export const contentHash = (): Schema<string> =>
  refine(string({ pattern: /^[0-9a-f]{64}$/ }), () => true, 'a sha-256 hex digest')

/** A short human line: a title, a reason, a check name. */
export const line = (maxLength = 300): Schema<string> => text(maxLength)

/** Line numbers are 1-based; a scanner may not know one. */
export const lineNumber = (): Schema<number> => number({ int: true, min: 1 })
