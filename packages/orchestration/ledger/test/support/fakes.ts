/**
 * A store that records appends and refuses an event the registry would refuse,
 * and a `BuildReader` that folds what it recorded into the `builds` rows the
 * ledger dedupes against.
 *
 * The strict half matters as much as in `gate`'s fake: the ledger's output is
 * two `build.*` events (§11), and a test that only counted them would pass on an
 * event the real store refuses. Folding the recorded events into rows also means
 * the ledger's dedupe is exercised against the same events a restart would
 * replay, rather than against a hand-written row that could agree with a bug.
 */

import { parse, repo as repoShape, sha as shaShape } from '@fleet/foundation-core'
import type { Repo, Seq, Sha } from '@fleet/foundation-core'
import { appendIssues } from '@fleet/foundation-contracts'
import type { AppendEvent, Build, BuildReader, EventSink } from '@fleet/foundation-contracts'

export const repo = (name = 'backbase/me-services-fleet'): Repo => parse(repoShape(), name)
export const sha = (hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'): Sha => parse(shaShape(), hex)

export interface FakeStore extends EventSink {
  readonly events: readonly AppendEvent[]
  ofType<T extends AppendEvent['type']>(type: T): readonly Extract<AppendEvent, { type: T }>[]
  failNext(error: Error): void
}

export const fakeStore = (): FakeStore => {
  const events: AppendEvent[] = []
  let seq = 0
  let nextFailure: Error | undefined

  return {
    events,
    ofType: <T extends AppendEvent['type']>(type: T) =>
      events.filter((event): event is Extract<AppendEvent, { type: T }> => event.type === type),
    failNext(error) {
      nextFailure = error
    },
    async append(batch: readonly AppendEvent[]): Promise<readonly Seq[]> {
      if (nextFailure !== undefined) {
        const error = nextFailure
        nextFailure = undefined
        throw error
      }
      const issues = batch.flatMap((event, index) =>
        appendIssues(event).map((issue) => `[${String(index)}] ${String(event.type)} ${issue.path}: ${issue.message}`),
      )
      if (issues.length > 0) throw new Error(`the ledger wrote an event the store would refuse: ${issues.join('; ')}`)
      return batch.map((event) => {
        seq += 1
        events.push(event)
        return seq as Seq
      })
    },
  }
}

/** The `builds` projection, rebuilt from the store's events on every read. */
export const fakeBuilds = (store: FakeStore): BuildReader => {
  const fold = (): readonly Build[] => {
    const rows = new Map<string, Build>()
    for (const event of store.events) {
      if (event.type === 'build.requested') {
        const data = event.data
        rows.set(data.buildId, {
          buildId: data.buildId,
          repo: data.repo,
          sha: data.sha,
          task: data.task,
          host: data.host,
          status: 'running',
          startedAt: event.ts,
        })
      } else if (event.type === 'build.finished') {
        const data = event.data
        const row = rows.get(data.buildId)
        if (row === undefined) continue
        rows.set(data.buildId, {
          ...row,
          status: data.status,
          ...(data.logPath === undefined ? {} : { logPath: data.logPath }),
          durationMs: data.durationMs,
          finishedAt: event.ts,
        })
      }
    }
    return [...rows.values()]
  }

  return {
    find: async (repoName, shaValue, task) =>
      fold().find((row) => row.repo === repoName && row.sha === shaValue && row.task === task),
    get: async (id) => fold().find((row) => row.buildId === id),
  }
}
