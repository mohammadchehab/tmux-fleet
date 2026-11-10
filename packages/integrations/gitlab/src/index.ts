/**
 * `@fleet/integrations-gitlab` (§10): the `PullRequests` port over `glab`, and
 * the pure mapping from GitLab's REST JSON to the contract's shapes.
 *
 * The rule that an observation may only be recorded against the head it graded
 * is `matchHeadSha` in `@fleet/integrations-github` and is deliberately not
 * re-exported here: this package *reports* the sha (checks carries it, and a
 * refused merge is re-read to see whether the head moved), and the caller owns
 * the decision, exactly as it does for GitHub.
 */

export * from './glab.ts'
export * from './observe.ts'
export * from './pull-requests.ts'
