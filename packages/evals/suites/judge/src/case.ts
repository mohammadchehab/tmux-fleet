/**
 * A case file (§17): `tests/evals/cases/judge/<id>.json` = `{id, suite, input, expected, source}`.
 *
 * Cases are **data**, written by the peer that owns the incidents they come from (engineer-3), never by this
 * package: the suite's job is to say what a well-formed case is and to refuse anything else, so a typo in a case is
 * a load failure and not a test that silently always passes. The four source kinds §17 names — a v1 incident, a
 * recorded event log cut at the decision point, labelled scanner output, an override capture — differ only in what
 * `source` says.
 *
 * `input` is exactly what the Judge receives: the typed `JudgeInput` of a `QuestionKind`, validated by the same
 * schema the Judge validates against, so a case cannot ask a question production could not ask. `expected` is the
 * decision the case asserts — the typed fields only (see `decision.ts`), never the model's `why`.
 */

import { boolean, decode, literal, nullable, object, oneOf, optional, peerId, text, type Infer, type Schema } from '@fleet/foundation-core'
import {
  evalCaseId,
  judgeInput,
  reviewVerdicts,
  type JudgeInput,
  type QuestionKind,
} from '@fleet/foundation-contracts'

/** The one deciding field each kind's expected answer carries, next to `kind` itself. */
export const DECISION_FIELD = {
  same_feature: 'same',
  route_question: 'peerId',
  thin_card: 'thin',
  review_verdict: 'verdict',
  escalate: 'escalate',
} as const satisfies Readonly<Record<QuestionKind, string>>

/**
 * The decision a case asserts (§17: exact match on the typed fields — verdict, route target, kind).
 *
 * `peerId: null` is the route answer "no peer knows this", which is a decision and not a missing value: the Judge
 * says it by leaving `peerId` out, and a case has to be able to assert it.
 */
export const decision = () =>
  object({
    kind: oneOf(['same_feature', 'route_question', 'thin_card', 'review_verdict', 'escalate'] as const),
    same: optional(boolean()),
    peerId: optional(nullable(peerId())),
    thin: optional(boolean()),
    verdict: optional(oneOf(reviewVerdicts)),
    escalate: optional(boolean()),
  })

export type ExpectedDecision = Infer<ReturnType<typeof decision>>

export const caseFile = () =>
  object({
    // The event's own id, so a case that loads is a case a run can report — not one the
    // append refuses at the end of the run (#92).
    id: evalCaseId(),
    /** Only `judge` for now; a case filed under the wrong suite is a case the wrong config would run. */
    suite: literal('judge'),
    input: judgeInput(),
    expected: decision(),
    source: text(500),
  })

export type JudgeCase = Infer<ReturnType<typeof caseFile>>

export const caseSchema: Schema<JudgeCase> = caseFile()

/** Why a case may not run, if it may not. The rule the schema cannot express is that `expected` names its kind's field. */
export function caseProblem(c: JudgeCase): string | undefined {
  if (c.expected.kind !== c.input.kind) {
    return `expected.kind is ${c.expected.kind} but input.kind is ${c.input.kind}`
  }
  const field = DECISION_FIELD[c.expected.kind]
  const keys = Object.keys(c.expected).sort()
  /**
   * A `route_question` may leave `peerId` out: absent means "no candidate is placed to answer", the routing
   * answer's documented fallback (§5.3), and `renderDecision` gives it that meaning on both sides of the
   * comparison. The other four kinds have no such default — an absent `same` is as likely a forgotten field
   * as a deliberate `false` — so for them the field is required.
   */
  if (c.expected.kind === 'route_question' && keys.join(',') === 'kind') return undefined
  const want = ['kind', field].sort()
  if (keys.join(',') !== want.join(',')) {
    return `expected carries ${keys.join(', ')}; a ${c.expected.kind} case asserts exactly kind and ${field}`
  }
  return undefined
}

/**
 * Parse one case file's text. The file name is the case id — a case copied to a new file and not renamed would
 * otherwise score under the old id, and two ids in one run are what a report is keyed by.
 */
export function readCase(text: string, file: string): JudgeCase {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (thrown) {
    throw new Error(`${file}: not JSON — ${(thrown as Error).message}`)
  }
  const decoded = decode(caseSchema, raw)
  if (!decoded.ok) {
    const first = decoded.error.issues[0]
    throw new Error(
      `${file}: not a judge case${first ? ` at ${first.path}: ${first.message}` : ''}`,
    )
  }
  const problem = caseProblem(decoded.value)
  if (problem !== undefined) throw new Error(`${file}: ${problem}`)
  return decoded.value
}

/** The input a case hands the real Judge path. Typed by its own `kind`, so the call is the same one production makes. */
export const inputOf = (c: JudgeCase): JudgeInput => c.input
