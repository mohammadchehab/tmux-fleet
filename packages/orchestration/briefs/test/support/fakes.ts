/**
 * Fakes for the briefs executor: a store that refuses what the registry would
 * refuse (so a misspelt event field fails here as it would in production), a
 * read model over two maps, and a Mailbox that records what it was sent.
 */

import { appendIssues } from '@fleet/foundation-contracts'
import type { AppendEvent, EventSink, Mailbox, Message, Peer, Work } from '@fleet/foundation-contracts'
import { decode, err, fleetError, ok, type PeerId, type Seq, type WorkId } from '@fleet/foundation-core'
import { peer, work } from '@fleet/foundation-contracts'

export interface FakeStore extends EventSink {
  readonly events: readonly AppendEvent[]
  failNext(error: Error): void
}

export const fakeStore = (): FakeStore => {
  const events: AppendEvent[] = []
  let seq = 0
  let nextFailure: Error | undefined
  return {
    events,
    failNext(error) {
      nextFailure = error
    },
    async append(batch) {
      if (nextFailure !== undefined) {
        const error = nextFailure
        nextFailure = undefined
        throw error
      }
      const issues = batch.flatMap((event, i) => appendIssues(event).map((x) => `[${String(i)}] ${event.type} ${x.path}: ${x.message}`))
      if (issues.length > 0) throw new Error(`the briefs executor wrote an event the store would refuse: ${issues.join('; ')}`)
      return batch.map((event) => {
        seq += 1
        events.push(event)
        return seq as Seq
      })
    },
  }
}

export const aWork = (patch: Record<string, unknown> = {}): Work => {
  const decoded = decode(work(), {
    workId: 'wrk_7f3a91c2d84b0e56',
    title: 'Add the thing',
    state: 'ready',
    dependsOn: [],
    prs: [],
    createdAt: '2026-11-10T09:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
    ...patch,
  })
  if (!decoded.ok) throw new Error(`bad Work fixture: ${JSON.stringify(decoded.error)}`)
  return decoded.value
}

export const aPeer = (patch: Record<string, unknown> = {}): Peer => {
  const decoded = decode(peer(), {
    peerId: 'engineer-1',
    role: 'engineer',
    providerId: 'claude-code',
    model: 'claude-sonnet-5-5',
    permissionMode: 'default',
    briefVersion: 0,
    state: 'idle',
    registeredAt: '2026-11-10T09:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
    ...patch,
  })
  if (!decoded.ok) throw new Error(`bad Peer fixture: ${JSON.stringify(decoded.error)}`)
  return decoded.value
}

export const fakeReads = (works: readonly Work[], peers: readonly Peer[]) => ({
  work: { get: async (id: WorkId) => works.find((w) => w.workId === id) },
  peers: { get: async (id: PeerId) => peers.find((p) => p.peerId === id) },
})

export interface FakeMailbox extends Pick<Mailbox, 'send' | 'history'> {
  readonly sent: readonly Parameters<Mailbox['send']>[0][]
  refuseNext(message: string): void
}

export const fakeMailbox = (already: readonly Message[] = []): FakeMailbox => {
  const sent: Parameters<Mailbox['send']>[0][] = []
  let refusal: string | undefined
  return {
    sent,
    refuseNext(message) {
      refusal = message
    },
    async send(message) {
      if (refusal !== undefined) {
        const m = refusal
        refusal = undefined
        return err(fleetError('provider_failed', m))
      }
      sent.push(message)
      return ok('msg_0123456789abcdef' as never)
    },
    async history() {
      return [...already]
    },
  }
}
