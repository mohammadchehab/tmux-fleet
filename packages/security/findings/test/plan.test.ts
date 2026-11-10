/**
 * The planner's rules (§6.2), one at a time.
 *
 * Every test drives `planScan` with raw scanner outcomes — no adapter, no
 * process, no store — because the planner's job is to decide *what happened*
 * from what the tools said, and that decision is what a replay has to
 * reproduce. Each batch is also run through `appendIssues`, so a test that
 * shows a good decision also shows it is a legal append (§3).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { appendIssues, type AppendEvent } from '@fleet/foundation-contracts'
import type { Repo, Sha } from '@fleet/foundation-core'
import { findingIdOf, fingerprintOf, normalizeSnippet, planScan, toolNameOf } from '../src/index.ts'
import type { RawFinding, ScanOutcome, ScanResult, Scanner } from '../src/index.ts'

const repo = 'acme/fleet' as Repo
const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' as Sha
const at = '2026-11-10T09:00:00.000Z'

/** A scanner that answers one canned outcome; the planner never calls it, so this is enough. */
const scanner = (id: string, outcome: ScanOutcome, tool?: string): ScanResult => ({
  scanner: {
    id,
    ...(tool === undefined ? {} : { tool }),
    scopes: ['diff', 'full'],
    scan: async () => outcome,
  } satisfies Scanner,
  outcome,
})

const ok = (findings: readonly RawFinding[]): ScanOutcome => ({ status: 'ok', findings })
const skipped = (reason: string): ScanOutcome => ({ status: 'skipped', reason })
const failed = (error: string): ScanOutcome => ({ status: 'failed', error })

const finding = (over: Partial<RawFinding> = {}): RawFinding => ({
  ruleId: 'js.lang.security.audit.unsafe-eval',
  severity: 'high',
  path: 'src/eval.ts',
  line: 12,
  message: 'eval() on a value from the environment',
  snippet: 'const code = eval(process.env.CODE)',
  ...over,
})

const noIssues = (events: readonly AppendEvent[]): void => {
  for (const event of events) assert.deepEqual(appendIssues(event), [], `${event.type} should be appendable`)
}

const typesOf = (events: readonly AppendEvent[]): readonly string[] => events.map((event) => event.type)

const plan = (results: readonly ScanResult[], known?: readonly { fingerprint: string; findingId: ReturnType<typeof findingIdOf> }[]) =>
  planScan({ target: { repo, sha }, scope: 'diff', results, now: at, ...(known === undefined ? {} : { known }) })

// --------------------------------------------------------------------- raised

test('a fresh finding is raised under an id derived from its fingerprint', () => {
  const result = plan([scanner('semgrep', ok([finding()]))])

  assert.deepEqual(typesOf(result.events), ['finding.raised'])
  assert.equal(result.raised, 1)
  const [event] = result.events
  assert.equal(event?.subject, findingIdOf(fingerprintOf(finding())))
  assert.deepEqual(event?.data, {
    findingId: findingIdOf(fingerprintOf(finding())),
    fingerprint: fingerprintOf(finding()),
    tool: 'semgrep',
    ruleId: 'js.lang.security.audit.unsafe-eval',
    severity: 'high',
    path: 'src/eval.ts',
    line: 12,
    message: 'eval() on a value from the environment',
    sha,
  })
  noIssues(result.events)
})

test('a line shift is the same finding: the fingerprint reads the snippet, not the line', () => {
  const before = plan([scanner('semgrep', ok([finding({ line: 12 })]))])
  const after = plan([scanner('semgrep', ok([finding({ line: 44 })]))])

  assert.equal(fingerprintOf(finding({ line: 44 })), fingerprintOf(finding({ line: 12 })))
  assert.equal(after.events[0]?.subject, before.events[0]?.subject)
  assert.equal(after.inputsHash, before.inputsHash, 'the same finding in the same place is the same input')
})

test('re-indenting the snippet does not launder a known finding', () => {
  const reindented = finding({ snippet: '\n    const code =   eval(process.env.CODE)\n  ' })
  assert.equal(normalizeSnippet(reindented.snippet ?? ''), normalizeSnippet(finding().snippet ?? ''))
  assert.equal(fingerprintOf(reindented), fingerprintOf(finding()))
})

test('the same rule in a different file is a different finding', () => {
  const one = finding()
  const two = finding({ path: 'src/other.ts' })
  assert.notEqual(fingerprintOf(one), fingerprintOf(two))

  const result = plan([scanner('semgrep', ok([one, two]))])
  assert.equal(result.raised, 2)
  assert.notEqual(result.events[0]?.subject, result.events[1]?.subject)
})

test('a finding with no snippet falls back to its message, so two messages stay two findings', () => {
  const a = finding({ snippet: undefined, message: 'eval on request body' })
  const b = finding({ snippet: undefined, message: 'eval on query string' })

  assert.notEqual(fingerprintOf(a), fingerprintOf(b))
  assert.equal(plan([scanner('semgrep', ok([a, b]))]).raised, 2)
})

test('a critical finding is written before an informational one, whatever order the scanners finish in', () => {
  const result = plan([
    scanner('semgrep', ok([finding({ ruleId: 'a.note', severity: 'info' })])),
    scanner('trivy', ok([finding({ ruleId: 'b.cve', severity: 'critical', path: 'Dockerfile' })])),
  ])

  const severities = result.events.map((event) => (event.data as { severity?: string }).severity)
  assert.deepEqual(severities, ['critical', 'info'])
})

test('a tool name is the adapter’s `tool` when it has one, else its id', () => {
  assert.equal(toolNameOf(scanner('osv-scanner', ok([])).scanner), 'osv-scanner')
  assert.equal(toolNameOf(scanner('osv', ok([]), 'osv-scanner@1.7').scanner), 'osv-scanner@1.7')
  assert.equal((plan([scanner('osv', ok([finding()]), 'osv-scanner@1.7')]).events[0]?.data as { tool: string }).tool, 'osv-scanner@1.7')
})

// ----------------------------------------------------------------------- seen

test('a fingerprint already on file is a re-sight, filed under the id the projection already gave it', () => {
  const known = { fingerprint: fingerprintOf(finding()), findingId: findingIdOf(fingerprintOf(finding())) }
  const result = plan([scanner('semgrep', ok([finding({ line: 90 })]))], [known])

  assert.deepEqual(typesOf(result.events), ['finding.seen'])
  assert.equal(result.raised, 0)
  assert.equal(result.seen, 1)
  assert.deepEqual(result.events[0]?.data, { findingId: known.findingId, fingerprint: known.fingerprint, sha })
  assert.equal(result.events[0]?.subject, known.findingId)
  noIssues(result.events)
})

test('two scanners citing the same new finding raise it once, and cite it once when it is known', () => {
  const fresh = plan([scanner('semgrep', ok([finding()])), scanner('trivy', ok([finding({ line: 99 })]))])
  assert.equal(fresh.raised, 1)
  assert.deepEqual(typesOf(fresh.events), ['finding.raised'])

  const known = [{ fingerprint: fingerprintOf(finding()), findingId: findingIdOf(fingerprintOf(finding())) }]
  const again = plan([scanner('semgrep', ok([finding()])), scanner('trivy', ok([finding()]))], known)
  assert.equal(again.seen, 1)
  assert.deepEqual(typesOf(again.events), ['finding.seen'])
})

// ------------------------------------------------------------- skipped, failed

test('a tool that did not run leaves a skip behind, naming why', () => {
  const result = plan([scanner('gitleaks', skipped('not installed'))])

  assert.deepEqual(typesOf(result.events), ['scan.skipped'])
  assert.equal(result.skipped, 1)
  assert.equal(result.failed, 0)
  assert.deepEqual(result.events[0]?.data, { repo, sha, tool: 'gitleaks', reason: 'not installed' })
  assert.equal(result.events[0]?.subject, repo)
  noIssues(result.events)
})

test('a broken tool is an absence, recorded and counted, never a clean run', () => {
  const result = plan([scanner('trivy', failed('exit 2: cache locked'))])

  assert.deepEqual(typesOf(result.events), ['scan.skipped'])
  assert.equal(result.skipped, 1)
  assert.equal(result.failed, 1, 'the routine reports this as a failed action, not as coverage')
  assert.equal((result.events[0]?.data as { reason: string }).reason, 'failed: exit 2: cache locked')
  noIssues(result.events)
})

test('a scanner that found nothing says so with its name recorded and no event', () => {
  const result = plan([scanner('semgrep', ok([]))])

  assert.deepEqual(result.events, [])
  assert.deepEqual([result.raised, result.seen, result.skipped, result.failed], [0, 0, 0, 0])
})

test('a failure that runs long is trimmed to what the event schema holds', () => {
  const result = plan([scanner('trivy', failed('boom '.repeat(500)))])

  const reason = (result.events[0]?.data as { reason: string }).reason
  assert.equal(reason.length, 500)
  assert.ok(reason.startsWith('failed: boom'))
  noIssues(result.events)
})

// ------------------------------------------------------------------- the batch

test('the batch does not depend on the order the scanners finished in', () => {
  const known = [{ fingerprint: fingerprintOf(finding()), findingId: findingIdOf(fingerprintOf(finding())) }]
  const results = [
    scanner('semgrep', ok([finding({ ruleId: 'm.one', severity: 'medium' })])),
    scanner('trivy', ok([finding({ ruleId: 'z.two', severity: 'high', path: 'Dockerfile' })])),
    scanner('gitleaks', skipped('no history')),
  ]

  const forward = plan(results, known)
  const backward = plan([...results].reverse(), known)

  assert.deepEqual(backward.events, forward.events)
  assert.equal(backward.inputsHash, forward.inputsHash, 'a replay of the same scan hashes alike (§5.4)')
  noIssues(forward.events)
})

test('a replay of the same scan yields the same batch and the same id', () => {
  const first = plan([scanner('semgrep', ok([finding()]))])
  const second = plan([scanner('semgrep', ok([finding()]))])

  assert.deepEqual(second.events, first.events)
  assert.equal(second.inputsHash, first.inputsHash)
})

test('a different commit is a different input, even for the same findings', () => {
  const here = plan([scanner('semgrep', ok([finding()]))])
  const there = planScan({
    target: { repo, sha: 'ffffffffffffffffffffffffffffffffffffffff' as Sha },
    scope: 'diff',
    results: [scanner('semgrep', ok([finding()]))],
    now: at,
  })

  assert.notEqual(there.inputsHash, here.inputsHash)
  assert.equal(there.events[0]?.subject, here.events[0]?.subject, 'the finding is the same finding')
})

test('the inputs hash is a hash, not the input', () => {
  const result = plan([scanner('semgrep', ok([finding()]))])
  assert.match(result.inputsHash, /^[0-9a-f]{16}$/)
})
