/**
 * The two events a typed Judge question produces (architecture §5.3, §5.4).
 *
 * A rule that cannot decide emits `judge.requested` as an *action*; `pm` never
 * calls a model. Something outside the rules — `fleet-judge` itself, or a peer
 * that owns the call — appends `judge.answered` with the model it used. A
 * replay reads both from the log and never asks again, so the same inputs
 * always produce the same decision (§5.4).
 *
 * `kind` appears both in the envelope and inside `input`/`answer`; the schema
 * refuses a pair that disagrees. That redundancy is deliberate: the projection
 * indexes by `kind` without decoding the payload, and the payload is still
 * self-describing when it is read on its own.
 */

import { count, event, object, optional, refine, string } from '@fleet/foundation-core'
import { peerId, questionId, workId } from '@fleet/foundation-core'
import { judgeAnswer, judgeInput, questionKind } from '../judge.ts'

/** The PM needs an answer it cannot derive from a rule. */
export const judgeRequested = event(
  'judge.requested',
  refine(
    object({
      questionId: questionId(),
      kind: questionKind(),
      input: judgeInput(),
      /** The hash of the inputs the question was formed from, for replay (§5.4). */
      inputsHash: string({ minLength: 8, maxLength: 200 }),
      workId: optional(workId()),
      /** The peer whose work raised it, when one did. */
      askedFor: optional(peerId()),
    }),
    (value) => value.input.kind === value.kind,
    'a judge question whose input matches its kind',
  ),
)

/**
 * The answer, with the model that produced it and how long it took. A malformed
 * answer that survives one retry becomes `escalate` to the user (§5.3) — it is
 * never recorded as a guess.
 */
export const judgeAnswered = event(
  'judge.answered',
  refine(
    object({
      questionId: questionId(),
      kind: questionKind(),
      answer: judgeAnswer(),
      /** The model id; the event's actor is `judge:<model>` (§3). */
      model: string({ minLength: 1, maxLength: 80 }),
      durationMs: count(),
      /** How many times the reply failed to validate before this one (§5.3). */
      retries: count(),
    }),
    (value) => value.answer.kind === value.kind,
    'a judge answer whose kind matches the question',
  ),
)
