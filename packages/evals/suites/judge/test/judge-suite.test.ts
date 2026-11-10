/**
 * The `judge` suite's own units, tested without a model.
 *
 * What is checked here is everything between the case files and the promptfoo
 * config: a case is read strictly, the scored decision is exactly the deciding
 * fields, a provider/model pair that would measure the wrong thing is refused
 * before any call, and the generated tests carry the expectation the assertion
 * compares against. A real run (§17) is not part of CI and is not tested here.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { JudgeAnswer } from '@fleet/foundation-contracts'
import { parse as parseRaw } from '@fleet/foundation-core'
import {
  DECISION_FIELD,
  EXACT_DECISION_ASSERTION,
  type JudgeCase,
  caseProblem,
  caseSchema,
  decisionOf,
  loadCases,
  promptfooTests,
  providerFromEnv,
  readCase,
  refuseTarget,
  renderDecision,
} from '../src/index.ts'

/** A route case, spelled the way the case files are. */
const routeCase = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'route-in-repo-ambiguity',
  suite: 'judge',
  input: {
    kind: 'route_question',
    question: 'who owns the pr-babysit retarget?',
    candidates: [
      { peerId: 'engineer-1', role: 'contracts' },
      { peerId: 'engineer-3', role: 'pr-babysit' },
    ],
  },
  expected: { kind: 'route_question', peerId: 'engineer-3' },
  source: '#61, the retarget loop stopped on a base that had not moved',
  ...over,
})

const parse = (over: Record<string, unknown> = {}): JudgeCase => readCase(JSON.stringify(routeCase(over)), 'route.json')

/**
 * A case as the *file* has it, without `readCase`'s checks — for the tests that
 * check those checks. `parse` refuses a bad case before `caseProblem` can see it,
 * which is the behaviour those tests are about.
 */
const loose = (over: Record<string, unknown> = {}): JudgeCase => parseRaw(caseSchema, routeCase(over))

test('a case file reads as a case', () => {
  const c = parse()
  assert.equal(c.id, 'route-in-repo-ambiguity')
  assert.equal(c.suite, 'judge')
  assert.equal(c.input.kind, 'route_question')
})

test('every kind has exactly one deciding field, and the table is complete', () => {
  assert.deepEqual(Object.keys(DECISION_FIELD).sort(), [
    'escalate',
    'review_verdict',
    'route_question',
    'same_feature',
    'thin_card',
  ])
  assert.equal(new Set(Object.values(DECISION_FIELD)).size, 5, 'no two kinds share a field')
})

test('a case whose expected kind is not its input kind is refused', () => {
  const c = loose({ expected: { kind: 'escalate', escalate: true } })
  const problem = caseProblem(c)
  assert.match(problem ?? '', /expected\.kind is escalate but input\.kind is route_question/)
})

test('a case that asserts a field its kind does not decide is refused', () => {
  // The mistake this catches: a `route_question` case copied from a `same_feature`
  // one and left with `same`, which would assert a field the answer never carries.
  const c = loose({ expected: { kind: 'route_question', peerId: 'engineer-3', same: true } })
  assert.match(
    caseProblem(c) ?? '',
    /a route_question case asserts exactly kind and peerId/,
  )
})

test('a case that omits its deciding field is refused, where the kind has no default', () => {
  const c = loose({
    input: {
      kind: 'same_feature',
      a: { title: 'a', body: 'a', files: [] },
      b: { title: 'b', body: 'b', files: [] },
    },
    expected: { kind: 'same_feature' },
  })
  assert.match(caseProblem(c) ?? '', /a same_feature case asserts exactly kind and same/)
})

test('a null peerId is a decision, not a missing field', () => {
  // "No peer knows this" is the answer that makes the PM escalate (§5.3), so a case
  // has to be able to assert it.
  const c = loose({ expected: { kind: 'route_question', peerId: null } })
  assert.equal(caseProblem(c), undefined)
})

test('a route case may leave peerId out, and it means "nobody fits"', () => {
  // The routing answer's fallback (§5.3) is the answer with no peer, so a case that
  // asserts it can be written the way engineer-3 wrote `route-no-candidate-fits`:
  // no field, rather than an explicit null.
  const c = loose({ expected: { kind: 'route_question' } })
  assert.equal(caseProblem(c), undefined)
  assert.equal(renderDecision(c.expected), '{"kind":"route_question","peerId":null}')
})

test('an absent field on any other kind is still refused: it has no default', () => {
  for (const expected of [
    { kind: 'same_feature' },
    { kind: 'thin_card' },
    { kind: 'review_verdict' },
    { kind: 'escalate' },
  ]) {
    const c = loose({ expected })
    assert.notEqual(caseProblem(c), undefined, `${expected.kind} without its field must be refused`)
  }
})

test('readCase names the file and the field it could not read', () => {
  assert.throws(
    () => readCase(JSON.stringify(routeCase({ suite: 'briefs' })), 'tests/evals/cases/judge/x.json'),
    /tests\/evals\/cases\/judge\/x\.json: not a judge case at suite/,
  )
})

test('readCase names the file when the file is not JSON', () => {
  assert.throws(() => readCase('{ not json', 'x.json'), /x\.json: not JSON/)
})

test('decisionOf keeps the deciding fields and drops the prose', () => {
  const answer: JudgeAnswer = {
    kind: 'review_verdict',
    verdict: 'approve',
    why: 'the finding is a nit',
  }
  assert.deepEqual(decisionOf(answer), { kind: 'review_verdict', verdict: 'approve' })
})

test('decisionOf renders a route answer with no peer as null', () => {
  const answer: JudgeAnswer = { kind: 'route_question', why: 'nobody owns this' }
  assert.equal(renderDecision(decisionOf(answer)), '{"kind":"route_question","peerId":null}')
})

test('a route decision with no peer renders the same however it was written', () => {
  const answer: JudgeAnswer = { kind: 'route_question', why: 'nobody fits' }
  const authored = renderDecision({ kind: 'route_question' })
  assert.equal(renderDecision(decisionOf(answer)), authored)
  assert.equal(authored, renderDecision({ kind: 'route_question', peerId: null }))
})

test('a decision renders canonically, so equal decisions are equal strings', () => {
  const a = renderDecision({ kind: 'route_question', peerId: 'engineer-3' })
  const b = renderDecision({ peerId: 'engineer-3', kind: 'route_question' })
  assert.equal(a, b, 'key order cannot change the answer')
  assert.equal(a, '{"kind":"route_question","peerId":"engineer-3"}')
})

test('a deepinfra run of a Claude id is refused before any call (#80)', () => {
  const refused = refuseTarget({ provider: 'deepinfra', model: 'claude-haiku-4-5', token: 'k', cwd: '.' })
  assert.equal(refused?.code, 'config_mismatch')
  assert.match(refused?.message ?? '', /not a DeepInfra model the fleet has measured/)
})

test('a claude run of a DeepSeek id is refused: it is the wrong vendor', () => {
  const refused = refuseTarget({
    provider: 'claude',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    cwd: '.',
  })
  assert.equal(refused?.code, 'config_mismatch')
  assert.match(refused?.message ?? '', /not a Claude model/)
})

test('a deepinfra run without a key is refused, and the message carries no credential', () => {
  const refused = refuseTarget({
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    cwd: '.',
  })
  assert.equal(refused?.code, 'config_mismatch')
  assert.match(refused?.message ?? '', /needs DEEPINFRA_API_KEY/)
})

test('a measured DeepSeek id with a key is accepted', () => {
  assert.equal(
    refuseTarget({
      provider: 'deepinfra',
      model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      token: 'k',
      cwd: '.',
    }),
    undefined,
  )
})

test('a Claude id on the claude provider is accepted', () => {
  assert.equal(refuseTarget({ provider: 'claude', model: 'claude-haiku-4-5', cwd: '.' }), undefined)
})

test('providerFromEnv requires a model and refuses a pair that measures the wrong thing', () => {
  assert.throws(
    () => providerFromEnv({ FLEET_EVAL_PROVIDER: 'claude' }),
    /FLEET_EVAL_MODEL names the model an eval run measures/,
  )
  assert.throws(
    () => providerFromEnv({ FLEET_EVAL_PROVIDER: 'gemini', FLEET_EVAL_MODEL: 'x' }),
    /FLEET_EVAL_PROVIDER is gemini/,
  )
  assert.throws(
    () =>
      providerFromEnv({
        FLEET_EVAL_PROVIDER: 'deepinfra',
        FLEET_EVAL_MODEL: 'claude-haiku-4-5',
        DEEPINFRA_API_KEY: 'k',
      }),
    /a DeepInfra eval runs a DeepSeek id only/,
  )
})

test('providerFromEnv names the target it will measure', () => {
  const provider = providerFromEnv({ FLEET_EVAL_PROVIDER: 'claude', FLEET_EVAL_MODEL: 'claude-haiku-4-5' })
  assert.equal(provider.id(), 'fleet-judge:claude:claude-haiku-4-5')
})

test('promptfooTests gives each case one test carrying its expectation', () => {
  const c = parse()
  const [generated] = promptfooTests([c])
  assert.ok(generated !== undefined)
  assert.equal(generated.vars.caseId, c.id)
  assert.deepEqual(generated.vars.case, c)
  assert.equal(generated.vars.expectedText, '{"kind":"route_question","peerId":"engineer-3"}')
  assert.deepEqual(generated.assert, [{ type: 'javascript', value: EXACT_DECISION_ASSERTION }])
  assert.match(generated.description, /^route-in-repo-ambiguity — #61/)
})

test('loadCases reads the directory, sorted by id, and refuses an empty one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'judge-cases-'))
  try {
    await assert.rejects(() => loadCases(dir), /no cases/, 'an empty directory is a suite that would score nothing')
    await writeFile(join(dir, 'b-route.json'), JSON.stringify(routeCase({ id: 'b-route' })))
    await writeFile(join(dir, 'a-route.json'), JSON.stringify(routeCase({ id: 'a-route' })))
    // A stray non-JSON file is not a case and must not be read as one.
    await writeFile(join(dir, 'README.md'), 'the cases\n')
    const cases = await loadCases(dir)
    assert.deepEqual(
      cases.map((c) => c.id),
      ['a-route', 'b-route'],
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadCases refuses a file whose name is not its case id', async () => {
  // The id keys the report and the baseline; a case renamed in one place and not the
  // other would score under an id no expectation matches.
  const dir = await mkdtemp(join(tmpdir(), 'judge-cases-'))
  try {
    await writeFile(join(dir, 'wrong-name.json'), JSON.stringify(routeCase({ id: 'right-name' })))
    await assert.rejects(() => loadCases(dir), /wrong-name.*right-name/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
