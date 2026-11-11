/**
 * §5.1 — a peer's `blocked` note becomes a question for the person who can answer it.
 *
 * Three of the four note phases (`plan`, `implement`, `mr`) are progress: they are mirrored to the
 * board and nothing in the fleet acts on them. `blocked` is the one with a consequence, and this
 * rule is that consequence. A peer that says it is stuck and gets no answer is the failure mode
 * §5.2's `unblock` row exists to prevent, and the peer has no way to reach the user itself.
 *
 * It reads `ctx.event`, not a projection, and that is deliberate rather than lazy: `work.noted` is
 * recorded-only (store/src/projections.ts), so the note is visible to the fleet only on the tick
 * that carries it. A later tick — the heartbeat — has the Work but not the note. That is why
 * `work.noted` is in `dispatch`'s event list in routines/src/config.ts: without it this rule never
 * runs, and the note would be mirrored to the board and answered by nobody.
 *
 * The inbox row is keyed by the Work's blocker episode, and episode 0 is the id `unblock` uses, so a
 * Work has one blocker question at a time, however it arrived: a second blocked note while the first
 * question is still open does not open a second row, and a `work.blocked` transition racing this one
 * does not either. Once the user has answered, a further blocked note is a new blocker and asks again.
 * A note is recognised by its own log seq, so replaying the same note never asks twice.
 */

import type { DecisionId } from '@fleet/foundation-core'
import type { Decision } from '@fleet/foundation-contracts'
import { shortHash } from '../digest.ts'
import { draft, type Rule } from './context.ts'
import { episodeDecisionId } from './unblock.ts'

export const raiseBlockedNotes: Rule = (ctx) => {
  if (ctx.event?.type !== 'work.noted') return []
  const note = ctx.event.data
  if (note.phase !== 'blocked') return []

  const work = ctx.state.work.find((row) => row.workId === note.workId)
  // A note about a Work the fleet does not have is a message from a session that is out of step
  // with the log. There is nothing to ask about and nothing to guess: the note stays in `events`.
  if (work === undefined) return []

  // Replaying this note's seq finds the row it raised; an open row is a question still waiting on the user.
  const inputsHash = shortHash({ kind: 'blocked', workId: work.workId, seq: String(ctx.event.seq) })
  let episode = 0
  let latest: Decision | undefined
  for (let row = ctx.index.decision(episodeDecisionId(work, episode)); row !== undefined; ) {
    if (row.inputsHash === inputsHash) return []
    latest = row
    episode += 1
    row = ctx.index.decision(episodeDecisionId(work, episode))
  }
  if (latest?.state === 'open') return []

  const decisionId: DecisionId = episodeDecisionId(work, episode)

  // The claim is `unblock`'s, on purpose. A peer that reported blocked and a Work the fleet marked
  // blocked are the same question about the same Work, and `decide` keeps the first claim — so two
  // rules cannot put two asks about one blocker in front of the user in one tick.
  return [draft(`unblock:${String(work.workId)}`, {
    kind: 'request_decision',
    causedBy: ctx.causedBy,
    decisionId,
    decisionKind: 'blocked',
    question:
      `${String(note.peerId)} says it is blocked on Work ${String(work.workId)}: ${work.title}. ` +
      `Its note: "${note.body}". Decide how it should go on, or cancel the Work.`,
    options: [],
    workId: work.workId,
    inputsHash,
  })]
}
