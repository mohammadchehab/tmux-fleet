/**
 * The judge suite's cases are data, and data drifts (§17).
 *
 * A case file is `{id, suite, input, expected, source}` at
 * `tests/evals/cases/<suite>/<id>.json`. `input` is a `JudgeInput` and
 * `expected` holds only the answer's **typed** fields — no `why`, no rubric —
 * because §17 scores this suite by exact match on typed fields. A case that
 * does not parse is not a failing case; it is a broken file, and it would go
 * unnoticed as a permanent "model disagreed" in the pass rate.
 *
 * So every committed case is validated here against the same contract schemas
 * the Judge itself validates answers with. The run itself needs a provider and
 * `fleet evals run` (§17); this test needs neither, which is why it can gate
 * every PR.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { decodeStrict } from '../../packages/foundation/core/src/index.ts'
import {
  judgeAnswer,
  judgeInput,
  questionKinds,
  type JudgeAnswer,
  type JudgeInput,
} from '../../packages/foundation/contracts/src/index.ts'

/**
 * The suite this test covers, and where its cases live. `evals` is a leaf
 * consumer (§1.1), so the path is resolved from this file rather than from a
 * package root.
 */
const SUITE = 'judge'
const CASES = join(import.meta.dirname, 'cases', SUITE)

/** The five keys a case file may carry; anything else is a typo passing as data. */
const CASE_KEYS = ['expected', 'id', 'input', 'source', 'suite'] as const

/** The one free-text field every answer has; the suite scores typed fields only (§17). */
const FREE_TEXT = 'why'

interface Case {
  readonly id: string
  readonly suite: string
  readonly input: JudgeInput
  readonly expected: JudgeAnswer
  readonly source: string
}

const readCases = (): readonly { readonly file: string; readonly raw: unknown }[] =>
  readdirSync(CASES)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((file) => ({ file, raw: JSON.parse(readFileSync(join(CASES, file), 'utf8')) as unknown }))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validate one case. `expected` is decoded against the real answer schema, so a
 * wrong type or a missing required field fails here — with one exception: the
 * schema requires `why`, which this suite deliberately does not carry. A
 * placeholder is supplied for it, after asserting the file does not hold one,
 * because the point of the check is the typed fields.
 */
const parseCase = (file: string, raw: unknown): Case => {
  const where = `${SUITE}/${file}`
  assert.ok(isRecord(raw), `${where}: a case is an object`)

  assert.deepEqual(
    Object.keys(raw).sort(),
    [...CASE_KEYS],
    `${where}: a case carries exactly ${CASE_KEYS.join(', ')}`,
  )

  const { id, suite, input, expected, source } = raw as Record<string, unknown>

  assert.equal(typeof id, 'string', `${where}: id is a string`)
  assert.equal(id, file.replace(/\.json$/, ''), `${where}: id is the filename stem`)
  assert.equal(suite, SUITE, `${where}: suite is the directory name`)
  assert.equal(typeof source, 'string', `${where}: source is a string`)
  assert.ok((source as string).length > 0, `${where}: source names the incident the case came from`)

  assert.ok(isRecord(input), `${where}: input is an object`)
  const decodedInput = decodeStrict(judgeInput(), input)
  assert.ok(decodedInput.ok, `${where}: input is a JudgeInput — ${JSON.stringify(decodedInput)}`)

  assert.ok(isRecord(expected), `${where}: expected is an object`)
  assert.ok(!(FREE_TEXT in expected), `${where}: expected holds typed fields only, not ${FREE_TEXT}`)

  const decodedExpected = decodeStrict(judgeAnswer(), { ...expected, [FREE_TEXT]: 'not scored' })
  assert.ok(decodedExpected.ok, `${where}: expected is a JudgeAnswer — ${JSON.stringify(decodedExpected)}`)

  assert.equal(
    decodedExpected.value.kind,
    decodedInput.value.kind,
    `${where}: expected answers the kind the input asks`,
  )

  return {
    id: id as string,
    suite: suite as string,
    input: decodedInput.value,
    expected: decodedExpected.value,
    source: source as string,
  }
}

const cases = readCases().map(({ file, raw }) => parseCase(file, raw))

test('§17: every judge case parses against the contract schemas', () => {
  // The parse above is the assertion; this test exists so a broken file is a
  // named failure even when the directory is empty.
  assert.ok(cases.length > 0, `${SUITE}: no cases found at ${CASES}`)
})

test('§17: the first slice is about ten cases over the three kinds it names', () => {
  // Ten is the slice §17 asks for, not a scoring threshold — the scoring rule
  // that matters is "no percentage under 20 cases", which belongs to the report.
  assert.ok(cases.length >= 10, `${SUITE}: ${cases.length} cases, §17's first slice is about ten`)

  for (const kind of ['same_feature', 'route_question', 'escalate']) {
    const mine = cases.filter((one) => one.input.kind === kind)
    assert.ok(mine.length >= 2, `${SUITE}: ${kind} has ${mine.length} cases, at least two keep a kind from over-fitting`)
  }

  for (const kind of cases.map((one) => one.input.kind)) {
    assert.ok((questionKinds as readonly string[]).includes(kind), `${SUITE}: ${kind} is a registered kind`)
  }
})

test('§17: case ids are unique, so a run can be reported case by case', () => {
  assert.equal(new Set(cases.map((one) => one.id)).size, cases.length, `${SUITE}: duplicate case id`)
})
