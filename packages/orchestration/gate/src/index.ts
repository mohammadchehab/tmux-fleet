/**
 * `@fleet/orchestration-gate`: §10's merge rules, and the only executor that
 * merges a PR. It is an `ActionExecutor` over `merge` and `retarget`; the
 * daemon composes it with the others, and injects `integrations/github` as its
 * `PullRequests` port, so there is no `gh` or git in here and a test is a fake
 * port away.
 */

export * from './preconditions.ts'
export * from './gate.ts'
