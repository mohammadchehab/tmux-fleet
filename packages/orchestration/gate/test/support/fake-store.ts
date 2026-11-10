/**
 * A store that records appends, and refuses an event the registry would refuse.
 *
 * The second half matters more than the first: the gate's output is two events
 * (§3), and a test that only counted them would pass on an event the real store
 * would refuse. `appendIssues` is the same strict decode `append` runs, so an
 * unknown key or a misspelt field fails here the way it fails in production.
 */

import { appendIssues } from '@fleet/foundation-contracts'
import type { AppendEvent, EventSink } from '@fleet/foundation-contracts'
import type { Seq } from '@fleet/foundation-core'

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
      if (issues.length > 0) throw new Error(`the gate wrote an event the store would refuse: ${issues.join('; ')}`)
      return batch.map((event) => {
        seq += 1
        events.push(event)
        return seq as Seq
      })
    },
  }
}
