/**
 * Turning cases into promptfoo tests (§17).
 *
 * One promptfoo test per case, carrying the whole case as a var so the provider can run the real Judge path on the
 * very object the file holds, and `expectedText` — the case's expected decision rendered canonically, which the
 * config's one assertion compares the provider's output to with `===`. The comparison is an exact match on the typed
 * fields, not a similarity score: §17's first slice has no grader, because a graded score would hide a wrong verdict
 * behind a plausible `why`.
 *
 * The repeats are the config's `defaultTest.options.repeat` (N=3, §17): the model is not deterministic, so one run of
 * a case says nothing about it. Repeats multiply a test rather than the case list, so the report's case count stays
 * the number of files.
 */

import type { JudgeCase } from './case.ts'
import { renderDecision } from './decision.ts'

/** The subset of promptfoo's test shape this suite sets. */
export interface PromptfooTest {
  readonly description: string
  readonly vars: {
    readonly case: JudgeCase
    /** The expected decision as canonical JSON; the assertion is `output === context.vars.expectedText`. */
    readonly expectedText: string
    readonly caseId: string
  }
  readonly assert: readonly { readonly type: 'javascript'; readonly value: string }[]
}

/** The assertion every test carries. The logic is one line because `expectedText` was rendered by `renderDecision`. */
export const EXACT_DECISION_ASSERTION = 'output === context.vars.expectedText'

export const promptfooTests = (cases: readonly JudgeCase[]): readonly PromptfooTest[] =>
  cases.map((c) => ({
    description: `${c.id} — ${c.source}`,
    vars: { case: c, expectedText: renderDecision(c.expected), caseId: c.id },
    assert: [{ type: 'javascript', value: EXACT_DECISION_ASSERTION }],
  }))
