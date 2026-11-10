/**
 * A forge that answers in memory, for the §15 exit test that has to end in a merge.
 *
 * `PullRequests` is a port (§1.1), so the daemon never learns whether the other
 * side is `gh` or this. That is what makes "three Work items reach `merged`"
 * testable in CI at all: the real port shells out to `gh`, which is not installed
 * on a runner and would be talking to a real repository if it were.
 *
 * What it deliberately does *not* do is pretend to be a merge: `merge()` records
 * that it was asked and flips the row, exactly as a forge that accepted the
 * request would. The gate still has to have decided it, and the test asserts on
 * the `pr.merged` the gate writes, not on this object's memory.
 */

import type { Repo, Sha } from '../../../packages/foundation/core/src/index.ts'
import type {
  ChecksState,
  PullRequest,
  PullRequests,
  ReviewState,
} from '../../../packages/foundation/contracts/src/index.ts'

/**
 * A row is the §3 projection itself, not a near-twin: the port's `list`/`get` are
 * declared to return `PullRequest`, and a private shape that happened to line up
 * would stop lining up the first time the projection gained a field.
 */
export type ForgePr = PullRequest

export interface ForgeMerge {
  readonly repo: Repo
  readonly number: number
  readonly method: 'merge' | 'squash' | 'rebase'
  readonly deleteBranch: boolean
}

export interface FakeForge extends PullRequests {
  /** A PR exists at `number`, authored against the Work. Its checks start out pending. */
  open(input: { readonly repo: Repo; readonly number: number; readonly workId?: string; readonly head?: string; readonly base?: string }): ForgePr
  /** The checks finished; the head sha does not move, so `pr.checks_changed` describes the same PR. */
  finish(repo: Repo, number: number, state: ChecksState, failing?: readonly string[]): void
  decide(repo: Repo, number: number, state: ReviewState): void
  /** A push: the head moves, which is what makes a recorded green stale (§10). */
  push(repo: Repo, number: number): void
  /** Every `merge()` the gate asked for, in order. */
  readonly merges: readonly ForgeMerge[]
  /** How many times the port was read, so a test can say a poller stopped polling. */
  readonly reads: number
  /** Every branch `deleteBranch()` removed, in order, with the sha it was pinned to. */
  readonly deleted: readonly { readonly repo: Repo; readonly branch: string; readonly sha: Sha }[]
}

/** When the forge says the row was written. The daemon's own clock decides event times. */
const NOW = '2026-11-10T00:00:00.000Z'

/**
 * §10 pins a merge to a forty-hex-character commit, and the store validates the
 * shape on append, so a readable fake like `sha-1` would be refused before it
 * reached anything. The seed is spelled into the tail and the rest is zeroes.
 */
const sha = (seed: number): Sha => `${'0'.repeat(37 - String(seed).length)}${String(seed)}${'0'.repeat(3)}` as Sha

export const createFakeForge = (): FakeForge => {
  const rows = new Map<string, ForgePr>()
  const merges: ForgeMerge[] = []
  const deleted: { repo: Repo; branch: string; sha: Sha }[] = []
  let reads = 0
  let pushed = 0

  const key = (repo: Repo, number: number): string => `${String(repo)}#${String(number)}`
  const row = (repo: Repo, number: number): ForgePr => {
    const found = rows.get(key(repo, number))
    if (found === undefined) throw new Error(`the forge has no ${String(repo)}#${String(number)}`)
    return found
  }
  const put = (next: ForgePr): void => {
    rows.set(key(next.repo, next.number), { ...next, updatedAt: NOW })
  }

  return {
    merges,
    deleted,
    get reads() {
      return reads
    },

    async list(scope: Repo, options?: { readonly state?: 'open' | 'closed' | 'all' }) {
      reads += 1
      const state = options?.state ?? 'open'
      return [...rows.values()]
        .filter((pr) => pr.repo === scope)
        .filter((pr) => (state === 'all' ? true : state === 'open' ? !pr.merged : pr.merged))
    },

    async get(repo: Repo, number: number) {
      reads += 1
      return rows.get(key(repo, number))
    },

    async searchIntent(repo: Repo, text: string) {
      reads += 1
      return [...rows.values()].filter((pr) => pr.repo === repo && !pr.merged && pr.head.includes(text))
    },

    async create(input: { readonly repo: Repo; readonly base: string; readonly head: string; readonly title: string }) {
      const number = rows.size + 1
      put({
        repo: input.repo,
        number,
        base: input.base,
        head: input.head,
        headSha: sha(number),
        checks: 'pending',
        failingChecks: [],
        review: 'pending',
        merged: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
      return { repo: input.repo, number }
    },

    async checks(repo: Repo, number: number) {
      reads += 1
      const pr = row(repo, number)
      return { state: pr.checks, failing: pr.failingChecks }
    },

    async review(repo: Repo, number: number) {
      reads += 1
      return { state: row(repo, number).review }
    },

    async retarget(repo: Repo, number: number, base: string) {
      put({ ...row(repo, number), base })
    },

    async dependents(_repo: Repo, _number: number) {
      // No stacks in the exit test: a dependent would forbid `deleteBranch`, and
      // the point of this test is three independent Works reaching `merged`.
      return []
    },

    async merge(repo: Repo, number: number, options: { readonly method: 'merge' | 'squash' | 'rebase'; readonly deleteBranch: boolean }) {
      const pr = row(repo, number)
      merges.push({ repo, number, method: options.method, deleteBranch: options.deleteBranch })
      put({ ...pr, merged: true })
      return { mergeSha: sha(900 + number) }
    },

    open(input) {
      const pr: ForgePr = {
        repo: input.repo,
        number: input.number,
        base: input.base ?? 'main',
        head: input.head ?? `work/${String(input.workId ?? input.number)}`,
        headSha: sha(input.number),
        checks: 'pending',
        failingChecks: [],
        review: 'pending',
        ...(input.workId === undefined ? {} : { workId: input.workId }),
        merged: false,
        createdAt: NOW,
        updatedAt: NOW,
      }
      put(pr)
      return pr
    },

    finish(repo, number, state, failing = []) {
      put({ ...row(repo, number), checks: state, failingChecks: failing })
    },

    decide(repo, number, state) {
      put({ ...row(repo, number), review: state })
    },

    push(repo, number) {
      pushed += 1
      // The new head is a different sha, which is the whole point: a merge recorded
      // against the old one would be a merge §10 does not allow.
      put({ ...row(repo, number), headSha: sha(500 + pushed) })
    },

    /** The branches the fake's PRs sit on. §6's `branch-cleanup` sweeps these. */
    async branches(scope: Repo) {
      return [...rows.values()]
        .filter((pr) => pr.repo === scope)
        .map((pr) => ({ name: pr.head, sha: pr.headSha }))
    },

    /** §10's pinned delete: the branch must still be at the sha the caller decided on. */
    async deleteBranch(scope: Repo, branch: string, expectedSha: Sha) {
      const found = [...rows.values()].find((pr) => pr.repo === scope && pr.head === branch)
      if (found === undefined) throw new Error(`${String(scope)} has no branch ${branch}`)
      if (found.headSha !== expectedSha) throw new Error(`${branch} moved off ${String(expectedSha)}`)
      deleted.push({ repo: scope, branch, sha: expectedSha })
      rows.delete(key(scope, found.number))
    },
  }
}
