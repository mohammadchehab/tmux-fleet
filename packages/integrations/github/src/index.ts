/**
 * `@fleet/integrations-github` (§10): the `PullRequests` port over `gh`, the
 * pure mapping from `gh --json` to the contract's shapes, and `matchHeadSha` —
 * the rule that an observation may only be recorded against the head it graded.
 */

export * from './gh.ts'
export * from './head.ts'
export * from './observe.ts'
export * from './pull-requests.ts'
export * from './team.ts'
