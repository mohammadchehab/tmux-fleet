/**
 * `tracker-sync` (architecture §3, §6): the board as a source and a sink.
 *
 * One body, two halves, decided by what woke it — never by a second routine:
 *
 * - **A heartbeat is a pull.** The profile's query asks the tracker what is
 *   open; every key the fleet has never seen becomes a `work.proposed` carrying
 *   `external`, and every other key is left alone. The card's body is read with
 *   `get`, so the Work is created from the ticket as it is *now* rather than as
 *   the list summarised it — a board is edited between polls, and a brief built
 *   from a stale summary is the failure this exists to avoid.
 * - **A work event is a sink.** `work.started`, `work.review_requested` and
 *   `work.merged` each name a `WorkState`; the profile's map turns it into the
 *   tracker's own status, and the ticket is moved. `review_requested` also links
 *   the PR, which is the one thing a board cannot infer. `work.noted` moves no
 *   state — a note is not a column — so it is a comment on the ticket instead,
 *   rendered by `renderNote`, which is how §5.1's phases reach a person. Only
 *   when the profile sets `comments: true`: a note is a peer's prose and the
 *   board may be a customer's, so an absent setting mirrors nothing.
 *
 * Dedupe is by `(system, key)` against the Works already in the log, not by a
 * remembered cursor: the sync may run against a fresh store, a replayed log or a
 * board that lost its own history, and the Work rows are the only thing that
 * knows what the fleet has already taken on.
 *
 * A failure to *read* the board throws, and the scheduler records
 * `routine.failed`: a pull that did not happen must not read as a pull that
 * found nothing (§6). A failure to *write* to one ticket is counted in
 * `tracker.synced` and in `actionsFailed` instead — one card the board will not
 * move does not make the other nine lies.
 */

import type { ForgeRef } from '@fleet/foundation-core'
import { deriveId, digestOf, pullRequestUrl, redactSecrets, toFleetError } from '@fleet/foundation-core'
import type {
  AppendEvent,
  EventSink,
  ExternalItem,
  FleetEvent,
  PeerId,
  ReadModel,
  Tracker,
  Work,
  WorkId,
  WorkNotePhase,
  WorkState,
} from '@fleet/foundation-contracts'
import type { RoutineContext, RoutineOutcome } from '../routine.ts'

export interface TrackerSyncDeps {
  readonly read: ReadModel
  readonly tracker: Tracker
  /**
   * Where the run's events go. `work.proposed` is appended through the *waking*
   * sink: `dispatch` is what turns a proposed Work into an assigned one, and a
   * proposal nobody was told about would wait for its heartbeat. The types this
   * body appends are not the ones its own trigger names (§6), so the wake cannot
   * re-enter it.
   */
  readonly store: EventSink
  /** The adapter's name, as `Work.external.system` spells it. */
  readonly system: string
  /** The profile's query, handed to `Tracker.pull` unchanged and recorded with the run. */
  readonly query: string
  /** The role a proposed Work asks for, when the profile names one (§5.2's `assign`). */
  readonly role?: string
  /**
   * Whether a note may be mirrored to the board as a comment. Absent is **off**
   * (`TrackerProfileBase.comments`): the board this profile maps is not
   * necessarily the fleet's own, and a peer's note is prose the fleet did not
   * write and may not be free to publish. A `blocked` note still raises its
   * Decision without this — that path never leaves the machine.
   */
  readonly comments?: boolean
  /** Which forge the PR link points at (profile `forge`). Absent is GitHub. */
  readonly forge?: ForgeRef
}

/**
 * What a sink event means: the Work it is about, and the state a board will
 * hear. `undefined` for every event that is not one of these — a heartbeat, a
 * start, a note (`noteOf`), or a work type this build does not echo back.
 */
const sinkOf = (
  event: FleetEvent | undefined,
): { readonly workId: WorkId; readonly state: WorkState } | undefined => {
  switch (event?.type) {
    case 'work.started':
      return { workId: event.data.workId, state: 'in_progress' }
    case 'work.review_requested':
      return { workId: event.data.workId, state: 'in_review' }
    case 'work.merged':
      return { workId: event.data.workId, state: 'merged' }
    default:
      return undefined
  }
}

/**
 * The Work a note is about, and the note itself. `work.noted` is a sink event
 * with no state to move: the ticket hears it as a comment.
 */
const noteOf = (
  event: FleetEvent | undefined,
): Extract<FleetEvent, { type: 'work.noted' }>['data'] | undefined =>
  event?.type === 'work.noted' ? event.data : undefined

/**
 * The note as the board will read it. The phase is in the text because a board
 * — Backlog's notes, Jira's ADF paragraphs — only understands prose, and a
 * reader who cannot see which of `plan|implement|mr|blocked` a note belongs to
 * cannot act on it.
 *
 * Deterministic, so the adapters' idempotence-by-body can work: the same event
 * rendered twice is the same string, and a ticket that already says it is not
 * told again.
 */
export const renderNote = (note: {
  readonly peerId: PeerId
  readonly phase: WorkNotePhase
  readonly body: string
}): string => `${String(note.peerId)} (${note.phase}): ${note.body}`

/** A Work's key in a tracker, for dedupe. NUL cannot occur in either half, so the pair is unambiguous. */
const pairKey = (ref: { readonly system: string; readonly key: string }): string =>
  `${ref.system}\u0000${ref.key}`

/**
 * The Work a card becomes. Derived from `(system, key)` so the same ticket asked
 * for twice — a re-run, a store rebuilt from a partial log — names the row it
 * already had instead of minting a second (§5.4).
 */
export const workIdFor = (system: string, key: string): WorkId =>
  deriveId('wrk', { system, key }) as WorkId

/** The card's title, flattened to one line: `work.proposed`'s title is a line, and a board may not agree. */
const titleOf = (item: ExternalItem): string =>
  item.title.replace(/\s+/g, ' ').trim().slice(0, 300) || item.key

/**
 * One proposed Work per unseen card. The card is read with `get` first: the list
 * is a summary, and a brief deserves the ticket itself.
 */
const proposedEvents = async (
  deps: TrackerSyncDeps,
  items: readonly ExternalItem[],
  known: ReadonlySet<string>,
  at: string,
): Promise<{ readonly events: readonly AppendEvent[]; readonly proposed: number; readonly failed: number; readonly error?: string }> => {
  const events: AppendEvent[] = []
  let failed = 0
  let error: string | undefined

  for (const item of items) {
    const key = pairKey({ system: item.system, key: item.key })
    // Two rows for one card in one pull is the board's business to fix, not ours
    // to propose twice.
    if (known.has(key)) continue

    let fresh = item
    try {
      const read = await deps.tracker.get(item.key)
      if (read === undefined) {
        // Deleted between the list and the read: nothing to propose, and nothing wrong.
        failed += 1
        error ??= `${item.key} was listed and is already gone`
        continue
      }
      fresh = read
    } catch (thrown) {
      failed += 1
      error ??= toFleetError(thrown, 'external_failed').message
      continue
    }

    events.push({
      type: 'work.proposed',
      ts: at,
      subject: workIdFor(fresh.system, fresh.key),
      actor: 'scheduler',
      data: {
        workId: workIdFor(fresh.system, fresh.key),
        title: titleOf(fresh),
        ...(deps.role === undefined ? {} : { role: deps.role }),
        ...(fresh.body === undefined ? {} : { body: fresh.body.slice(0, 20_000) }),
        dependsOn: [],
        external: {
          system: fresh.system,
          key: fresh.key,
          ...(fresh.url === undefined ? {} : { url: fresh.url }),
        },
      },
    })
  }

  return { events, proposed: events.length, failed, ...(error === undefined ? {} : { error }) }
}

/**
 * The sink half: move the ticket to the state the event implies, link the PR a
 * review asked for, or say what the peer said. A note and a transition are
 * mutually exclusive — one event is one of them — so the counts never both rise.
 */
const sinkEvents = async (
  deps: TrackerSyncDeps,
  work: Work,
  context: RoutineContext,
): Promise<{
  readonly transitioned: number
  readonly linked: number
  readonly commented: number
  readonly failed: number
  readonly error?: string
}> => {
  const empty = { transitioned: 0, linked: 0, commented: 0, failed: 0 }
  const external = work.external
  if (external === undefined) return empty

  const sink = sinkOf(context.event)
  const note = noteOf(context.event)
  if (sink === undefined && note === undefined) return empty

  let transitioned = 0
  let linked = 0
  let commented = 0
  let failed = 0
  let error: string | undefined

  // A note moves no column, so it is not a transition. `Tracker.comment` is
  // idempotent on the body, which matters here: a resumed run or a replayed log
  // sees this event twice, and a card that collected one copy per sighting would
  // be unreadable.
  //
  // Gated on the profile's `comments`, off when absent: this text is a peer's,
  // and the board on the other side may be a customer's. When the gate is shut
  // nothing is appended for the note at all — `commented` stays 0, and
  // `tracker.synced` says so, rather than the run looking like a mirror that
  // failed. The body is redacted on the way out for the same reason it is
  // redacted on the way into the log: a secret a peer typed is still a secret.
  if (note !== undefined) {
    if (deps.comments !== true) {
      return { transitioned, linked, commented, failed, ...(error === undefined ? {} : { error }) }
    }
    try {
      await deps.tracker.comment(external.key, renderNote({ ...note, body: redactSecrets(note.body) }))
      commented += 1
    } catch (thrown) {
      failed += 1
      error = toFleetError(thrown, 'external_failed').message
    }
    return { transitioned, linked, commented, failed, ...(error === undefined ? {} : { error }) }
  }

  if (sink === undefined) return empty

  const to = sink.state

  try {
    await deps.tracker.transition(external.key, to)
    transitioned += 1
  } catch (thrown) {
    failed += 1
    error = toFleetError(thrown, 'external_failed').message
  }

  // The PR only exists once the peer asked for review, and the event is where it
  // is named (`work.review_requested.pr`, §10).
  const pr = context.event?.type === 'work.review_requested' ? context.event.data.pr : undefined
  if (pr !== undefined) {
    const url = pullRequestUrl(deps.forge, String(pr.repo), pr.number)
    try {
      await deps.tracker.link(external.key, url)
      linked += 1
    } catch (thrown) {
      failed += 1
      error ??= toFleetError(thrown, 'external_failed').message
    }
  }

  return { transitioned, linked, commented, failed, ...(error === undefined ? {} : { error }) }
}

/** What the fleet already has, by `(system, key)`. */
const knownKeys = async (read: ReadModel, system: string): Promise<ReadonlySet<string>> => {
  const works = await read.work.all()
  const known = new Set<string>()
  for (const work of works) {
    if (work.external !== undefined && work.external.system === system) known.add(pairKey(work.external))
  }
  return known
}

export const sync = async (deps: TrackerSyncDeps, context: RoutineContext): Promise<RoutineOutcome> => {
  const at = context.at
  let pulled = 0
  let proposed = 0
  let transitioned = 0
  let linked = 0
  let commented = 0
  let failed = 0
  let error: string | undefined

  // The event that woke this run, when it is one the sink acts on. Its absence is
  // the pull: a heartbeat, a start or an explicit request asks the board what it
  // has. A note names a Work too — it is a sink event with nothing to transition.
  const workId = sinkOf(context.event)?.workId ?? noteOf(context.event)?.workId

  if (workId === undefined) {
    // A heartbeat, a start or a request: ask the board what it has.
    const items = await deps.tracker.pull(deps.query)
    pulled = items.length
    const known = await knownKeys(deps.read, deps.system)
    const batch = await proposedEvents(deps, items, known, at)
    proposed = batch.proposed
    failed += batch.failed
    error ??= batch.error
    if (batch.events.length > 0) await deps.store.append(batch.events)
  } else {
    const work = await deps.read.work.get(workId)
    if (work !== undefined) {
      const sunk = await sinkEvents(deps, work, context)
      transitioned = sunk.transitioned
      linked = sunk.linked
      commented = sunk.commented
      failed += sunk.failed
      error ??= sunk.error
    }
  }

  // The run's own record, appended whichever half ran. The store's `append` is
  // what makes a silent routine impossible (§6), so a run that did nothing still
  // says so, and a run that was refused says what was refused.
  await deps.store.append([
    {
      type: 'tracker.synced',
      ts: at,
      subject: 'tracker-sync',
      actor: 'scheduler',
      data: {
        system: deps.system,
        query: deps.query,
        pulled,
        proposed,
        transitioned,
        linked,
        commented,
        failed,
        ...(error === undefined ? {} : { error: error.slice(0, 1000) }),
      },
    },
  ])

  return {
    actions: proposed + transitioned + linked + commented,
    actionsFailed: failed,
    // What the run read, not what it wrote: the same board in the same state
    // hashes alike, so a replay can tell a decision that changed from a board
    // that did (§5.4).
    inputsHash: digestOf({
      system: deps.system,
      query: deps.query,
      pulled,
      proposed,
      transitioned,
      linked,
      commented,
      failed,
      workId: workId ?? null,
    }),
  }
}
