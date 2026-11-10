/**
 * A fake `PullRequests` port (§10). The gate must be testable without `gh` and
 * without git — that is the whole reason the port exists (§1.1) — so this fake
 * is a small in-memory repo: PRs by number, dependents by parent, and a log of
 * every call in the order the gate made it.
 *
 * The call log is the point. Three of §10's rules are about *order and
 * arguments*, not about the result: dependents are retargeted before the merge,
 * the merge is pinned to a sha, and `deleteBranch` is false while a dependent
 * exists. A fake that only returned values could not see any of them.
 */

import { parse } from '@fleet/foundation-core'
import { repo as repoShape, sha as shaShape, type Repo, type Sha } from '@fleet/foundation-core'
import type { PullRequest, PullRequests } from '@fleet/foundation-contracts'

export type GateCall =
  | { readonly kind: 'get'; readonly number: number }
  | { readonly kind: 'dependents'; readonly number: number }
  | { readonly kind: 'retarget'; readonly number: number; readonly base: string }
  | {
      readonly kind: 'merge'
      readonly number: number
      readonly method: 'merge' | 'squash' | 'rebase'
      readonly deleteBranch: boolean
      /** The sha the merge was pinned to. §10's pin reaches the forge as an argument, so the fake sees it. */
      readonly headSha: Sha
    }

export interface FakeGithub extends PullRequests {
  /** Every call the gate made, in order. */
  readonly calls: readonly GateCall[]
  /** Put a PR into the fake repo, replacing one with the same number. */
  put(pr: PullRequest): void
  /** Say that `parent` has these PRs stacked on it. */
  stack(parent: number, dependents: readonly number[]): void
  /** Make the next call of this kind throw, so a test can watch the failure path. */
  failNext(kind: GateCall['kind'], error: Error): void
  /** Run after a successful retarget: how a test moves a head while the gate is mid-merge. */
  onRetarget(hook: (number: number) => void): void
}

export const repo = (name = 'backbase/me-services-fleet'): Repo => parse(repoShape(), name)
export const sha = (hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'): Sha => parse(shaShape(), hex)

/** A PR that may merge: green, approved, unstacked. Override the one field a test is about. */
export const pullRequest = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  repo: repo(),
  number: 42,
  base: 'main',
  head: 'fleet/gate',
  headSha: sha(),
  checks: 'passing',
  failingChecks: [],
  review: 'approved',
  merged: false,
  createdAt: '2026-11-10T08:00:00.000Z',
  updatedAt: '2026-11-10T09:00:00.000Z',
  ...overrides,
})

export const fakeGithub = (initial: readonly PullRequest[] = []): FakeGithub => {
  const prs = new Map<number, PullRequest>()
  const stacks = new Map<number, number[]>()
  const calls: GateCall[] = []
  const failures = new Map<GateCall['kind'], Error>()
  let afterRetarget: ((number: number) => void) | undefined

  for (const pr of initial) prs.set(pr.number, pr)

  const take = (kind: GateCall['kind']): void => {
    const error = failures.get(kind)
    if (error === undefined) return
    failures.delete(kind)
    throw error
  }

  const unsupported = (method: string): Promise<never> =>
    Promise.reject(new Error(`the gate never calls ${method}, so the fake does not model it`))

  return {
    calls,
    put(pr) {
      prs.set(pr.number, pr)
    },
    stack(parent, dependents) {
      stacks.set(parent, [...dependents])
    },
    failNext(kind, error) {
      failures.set(kind, error)
    },
    onRetarget(hook) {
      afterRetarget = hook
    },

    async get(_repo: Repo, number: number): Promise<PullRequest | undefined> {
      calls.push({ kind: 'get', number })
      take('get')
      return prs.get(number)
    },

    async dependents(_repo: Repo, number: number): Promise<readonly { repo: Repo; number: number }[]> {
      calls.push({ kind: 'dependents', number })
      take('dependents')
      return (stacks.get(number) ?? []).map((dependent) => ({ repo: repo(), number: dependent }))
    },

    async retarget(_repo: Repo, number: number, base: string): Promise<void> {
      calls.push({ kind: 'retarget', number, base })
      take('retarget')
      const pr = prs.get(number)
      if (pr === undefined) throw new Error(`no PR ${String(number)}`)
      prs.set(number, { ...pr, base })
      afterRetarget?.(number)
    },

    async merge(
      _repo: Repo,
      number: number,
      options: { readonly method: 'merge' | 'squash' | 'rebase'; readonly deleteBranch: boolean; readonly headSha: Sha },
    ): Promise<{ readonly mergeSha?: Sha }> {
      calls.push({
        kind: 'merge',
        number,
        method: options.method,
        deleteBranch: options.deleteBranch,
        headSha: options.headSha,
      })
      take('merge')
      const pr = prs.get(number)
      if (pr === undefined) throw new Error(`no PR ${String(number)}`)
      prs.set(number, { ...pr, merged: true })
      return { mergeSha: sha('d36a8b0c1d2e3f405162738495a6b7c8d9e0f102') }
    },

    list: () => unsupported('list'),
    searchIntent: () => unsupported('searchIntent'),
    create: () => unsupported('create'),
    checks: () => unsupported('checks'),
    review: () => unsupported('review'),
    branches: () => unsupported('branches'),
    defaultBranch: () => unsupported('defaultBranch'),
    deleteBranch: () => unsupported('deleteBranch'),
  }
}
