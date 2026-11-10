/**
 * The adapters (§6.2): the argv each tool is run with, and the findings its
 * report becomes.
 *
 * No test spawns a tool. Each one injects an `exec` that records argv and
 * replies with a fixture, so what is asserted is exactly the two things an
 * adapter owns — the invocation and the parse — and the suite runs on a machine
 * with no scanner installed.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Repo, Sha } from '@fleet/foundation-core'
import { fingerprintOf, type ScanOutcome } from '@fleet/security-findings'
import {
  createGitleaksScanner,
  createOsvScanner,
  createScanners,
  createSemgrepScanner,
  createTrivyScanner,
  defaultScannerIds,
  parseGitleaks,
  parseOsv,
  parseSemgrep,
  parseTrivy,
  type ExecOptions,
  type ExecResult,
  type ToolIo,
} from '../src/index.ts'

const cwd = '/work/checkout'
const reportPath = '/tmp/fleet-test-gitleaks.json'

interface Call {
  readonly file: string
  readonly args: readonly string[]
  readonly options?: ExecOptions
}

interface FakeOptions {
  /** Programs `which` reports as installed. Anything else is a skip. */
  readonly installed?: readonly string[]
  /** What the tool answers. Defaults to a clean exit with the report below on stdout. */
  readonly reply?: (file: string, args: readonly string[]) => ExecResult | Error
  /** Files a tool writes and the adapter reads back. */
  readonly files?: Readonly<Record<string, string>>
}

const fakeIo = (options: FakeOptions = {}) => {
  const calls: Call[] = []
  const installed = options.installed ?? ['semgrep', 'gitleaks', 'osv-scanner', 'trivy']
  const reply =
    options.reply ??
    ((): ExecResult => ({ code: 0, stdout: '{}', stderr: '' }))

  const io: ToolIo = {
    exec: async (file, args, execOptions) => {
      calls.push({ file, args, ...(execOptions === undefined ? {} : { options: execOptions }) })
      const answer = reply(file, args)
      if (answer instanceof Error) throw answer
      return answer
    },
    has: async (binary) => installed.includes(binary),
    readFile: async (path) => {
      const content = options.files?.[path]
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return content
    },
  }

  return { io, calls, ran: (binary: string): Call | undefined => calls.find((call) => call.file === binary) }
}

const ok = (outcome: ScanOutcome): Extract<ScanOutcome, { status: 'ok' }> => {
  assert.equal(outcome.status, 'ok', `expected ok, got ${outcome.status}`)
  return outcome as Extract<ScanOutcome, { status: 'ok' }>
}

const target = { repo: 'acme/fleet' as Repo, sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' as Sha }
const diff = { target, scope: 'diff' } as const
const full = { target, scope: 'full' } as const

// -------------------------------------------------------------------- semgrep

const semgrepReport = JSON.stringify({
  results: [
    {
      check_id: 'javascript.lang.security.audit.eval',
      path: 'src/eval.ts',
      start: { line: 12, col: 3 },
      extra: { message: 'eval() of untrusted input', severity: 'ERROR', lines: 'const x = eval(input)' },
    },
    {
      check_id: 'typescript.cors.permissive',
      path: '/work/checkout/src/cors.ts',
      start: { line: 4 },
      extra: { message: 'permissive CORS', severity: 'WARNING' },
    },
  ],
  errors: [],
})

test('semgrep runs the CI rule sets over the checkout, metrics off', async () => {
  const { io, ran } = fakeIo({ reply: () => ({ code: 0, stdout: semgrepReport, stderr: '' }) })
  const scanner = createSemgrepScanner(io, { cwd })

  const outcome = await scanner.scan(full)

  assert.equal(scanner.id, 'semgrep')
  assert.deepEqual(scanner.scopes, ['diff', 'full'])
  assert.deepEqual(ran('semgrep')?.args, [
    'scan',
    '--json',
    '--disable-version-check',
    '--exclude',
    'node_modules',
    '--config',
    'p/typescript',
    '--config',
    'p/javascript',
    '.',
  ])
  assert.deepEqual(ran('semgrep')?.options?.env, { SEMGREP_SEND_METRICS: 'off' })
  assert.equal(ran('semgrep')?.options?.cwd, cwd)
  assert.equal(ok(outcome).findings.length, 2)
})

test('a diff scan asks semgrep for the baseline commit, a full scan does not', async () => {
  const { io, ran } = fakeIo({ reply: () => ({ code: 0, stdout: semgrepReport, stderr: '' }) })
  const scanner = createSemgrepScanner(io, { cwd, baseline: 'origin/release' })

  await scanner.scan(diff)

  const args = ran('semgrep')?.args ?? []
  assert.deepEqual(args.slice(-3), ['--baseline-commit', 'origin/release', '.'])
})

test('semgrep’s three severities map onto the fleet’s five, and paths come back relative', async () => {
  const findings = parseSemgrep(semgrepReport, cwd)

  assert.deepEqual(
    findings.map((finding) => [finding.path, finding.severity, finding.line, finding.snippet]),
    [
      ['src/eval.ts', 'high', 12, 'const x = eval(input)'],
      ['src/cors.ts', 'medium', 4, undefined],
    ],
  )
})

test('a semgrep report missing a path or a rule is dropped, not thrown', async () => {
  const findings = parseSemgrep(
    JSON.stringify({ results: [{ extra: { message: 'no path' } }, { path: 'a.ts', check_id: 'x', extra: {} }] }),
  )

  assert.deepEqual(findings.map((finding) => finding.ruleId), ['x'])
  assert.equal(findings[0]?.severity, 'medium', 'an unlabelled finding is reported, at the middle')
})

// ------------------------------------------------------------------- gitleaks

const gitleaksReport = JSON.stringify([
  {
    RuleID: 'generic-api-key',
    Description: 'Identified a generic API key',
    File: 'src/config.ts',
    StartLine: 7,
    Match: 'API_KEY=REDACTED',
    Secret: 'AKIAIOSFODNN7EXAMPLE',
  },
])

const gitleaksScanner = (io: ToolIo, baseline?: string) =>
  createGitleaksScanner(io, { cwd, reportPath: () => reportPath, ...(baseline === undefined ? {} : { baseline }) })

test('gitleaks writes its report to the caller’s path and reads it back', async () => {
  const { io, ran } = fakeIo({ reply: () => ({ code: 0, stdout: '', stderr: '' }), files: { [reportPath]: gitleaksReport } })

  const outcome = await gitleaksScanner(io).scan(diff)

  assert.deepEqual(ran('gitleaks')?.args, [
    'detect',
    '--source',
    '.',
    '--redact',
    '--no-banner',
    '--exit-code',
    '0',
    '--report-format',
    'json',
    '--report-path',
    reportPath,
    '--log-opts',
    'origin/main..HEAD',
  ])
  assert.deepEqual(ok(outcome).findings, [
    { ruleId: 'generic-api-key', severity: 'high', path: 'src/config.ts', line: 7, message: 'Identified a generic API key', snippet: ':7' },
  ])
})

test('a full gitleaks scan walks the whole history, because an old secret is still leaked', async () => {
  const { io, ran } = fakeIo({ files: { [reportPath]: '[]' } })

  await gitleaksScanner(io).scan(full)

  const args = ran('gitleaks')?.args ?? []
  assert.deepEqual(args.slice(-2), ['--log-opts', 'HEAD'])
})

test('no report file is no leaks: gitleaks does not always write one', async () => {
  const { io } = fakeIo({ reply: () => ({ code: 0, stdout: '', stderr: '' }) })

  assert.deepEqual(ok(await gitleaksScanner(io).scan(full)).findings, [])
})

test('the secret itself never becomes a finding', () => {
  const [finding] = parseGitleaks(gitleaksReport, cwd)
  const rendered = JSON.stringify(finding)

  assert.ok(finding !== undefined)
  assert.ok(!rendered.includes('AKIAIOSFODNN7EXAMPLE'), 'the secret must not ride into the event log')
  assert.ok(!rendered.includes('REDACTED'), 'nor the redacted match, which is noise in a finding')
  assert.equal(finding.message, 'Identified a generic API key')
})

test('two different secrets of one rule in one file are two findings, not one', () => {
  const leak = (line: number, commit: string) => ({
    RuleID: 'generic-api-key',
    Description: 'Identified a generic API key',
    File: 'src/config.ts',
    StartLine: line,
    Commit: commit,
    Fingerprint: `${commit}:src/config.ts:generic-api-key:${String(line)}`,
    Secret: 'REDACTED',
  })
  const found = parseGitleaks(JSON.stringify([leak(7, 'aaa111'), leak(20, 'aaa111'), leak(7, 'bbb222')]), cwd)
  const fingerprints = found.map((finding) => fingerprintOf(finding))

  assert.equal(new Set(fingerprints).size, 3, 'a later, different secret must not be deduped into the first')
  assert.deepEqual(fingerprints, found.map((finding) => fingerprintOf(finding)), 'the same report fingerprints the same way')
})

// ------------------------------------------------------------------------ osv

const osvReport = JSON.stringify({
  results: [
    {
      source: { path: '/work/checkout/pnpm-lock.yaml', type: 'lockfile' },
      packages: [
        {
          package: { name: 'lodash', version: '4.17.20', ecosystem: 'npm' },
          vulnerabilities: [
            {
              id: 'GHSA-35jh-r3h4-6jhm',
              summary: 'Command injection in lodash',
              database_specific: { severity: 'MODERATE' },
            },
          ],
        },
        {
          package: { name: 'minimist', version: '1.2.5' },
          vulnerabilities: [{ id: 'GHSA-vh95-rmgr-6w4m', details: 'Prototype pollution', database_specific: {} }],
        },
      ],
    },
  ],
})

test('osv-scanner exits 1 when it finds something, and that is a clean scan', async () => {
  const { io, ran } = fakeIo({ reply: () => ({ code: 1, stdout: osvReport, stderr: 'vulnerabilities found' }) })

  const outcome = await createOsvScanner(io, { cwd }).scan(full)

  assert.deepEqual(ran('osv-scanner')?.args, ['scan', '--lockfile', 'pnpm-lock.yaml', '--format', 'json'])
  assert.equal(ok(outcome).findings.length, 2)
})

test('an osv finding names the package, maps MODERATE to medium, and floors an unrated advisory at medium', () => {
  const findings = parseOsv(osvReport, cwd)

  assert.deepEqual(
    findings.map((finding) => [finding.ruleId, finding.severity, finding.path, finding.message]),
    [
      ['GHSA-35jh-r3h4-6jhm', 'medium', 'pnpm-lock.yaml', 'lodash@4.17.20: Command injection in lodash'],
      ['GHSA-vh95-rmgr-6w4m', 'medium', 'pnpm-lock.yaml', 'minimist@1.2.5: Prototype pollution'],
    ],
  )
})

// ---------------------------------------------------------------------- trivy

const trivyReport = JSON.stringify({
  Results: [
    {
      Target: 'pnpm-lock.yaml',
      Vulnerabilities: [
        { VulnerabilityID: 'CVE-2024-0001', PkgName: 'vitest', InstalledVersion: '1.0.0', Severity: 'CRITICAL', Title: 'RCE' },
      ],
    },
    {
      Target: 'Dockerfile',
      Misconfigurations: [
        {
          ID: 'DS002',
          Title: 'Image user should not be root',
          Severity: 'HIGH',
          CauseMetadata: { StartLine: 3 },
        },
        { ID: 'DS026', Title: 'No HEALTHCHECK', Severity: 'UNKNOWN' },
      ],
    },
  ],
})

test('trivy reads both vulnerabilities and misconfigurations out of one run', async () => {
  const { io, ran } = fakeIo({ reply: () => ({ code: 0, stdout: trivyReport, stderr: '' }) })

  const outcome = await createTrivyScanner(io, { cwd }).scan(full)

  assert.deepEqual(ran('trivy')?.args, ['fs', '--format', 'json', '--quiet', '--scanners', 'vuln,misconfig', '.'])
  assert.deepEqual(
    ok(outcome).findings.map((finding) => [finding.ruleId, finding.severity, finding.path, finding.line]),
    [
      ['CVE-2024-0001', 'critical', 'pnpm-lock.yaml', undefined],
      ['DS002', 'high', 'Dockerfile', 3],
      ['DS026', 'info', 'Dockerfile', undefined],
    ],
  )
})

// ----------------------------------------------------------------- the answers

test('a tool that is not installed is a skip that names it, and nothing is run', async () => {
  const { io, calls } = fakeIo({ installed: [] })

  const outcome = await createSemgrepScanner(io, { cwd }).scan(full)

  assert.deepEqual(outcome, { status: 'skipped', reason: 'semgrep is not installed' })
  assert.deepEqual(calls, [], 'a skip costs no process')
})

test('a failing `which` is a failure, not a skip: we cannot claim the tool is absent', async () => {
  const io: ToolIo = {
    exec: async () => {
      throw new Error('EACCES')
    },
    has: async () => {
      throw new Error('EACCES')
    },
    readFile: async () => '',
  }

  assert.deepEqual(await createSemgrepScanner(io, { cwd }).scan(full), {
    status: 'failed',
    error: 'could not probe for semgrep',
  })
})

test('a tool that exits badly fails the scan with what it said', async () => {
  const { io } = fakeIo({ reply: () => ({ code: 2, stdout: '', stderr: 'rule parse error: line 3' }) })

  assert.deepEqual(await createSemgrepScanner(io, { cwd }).scan(full), {
    status: 'failed',
    error: 'semgrep exited 2: rule parse error: line 3',
  })
})

test('an empty report is a failure, never an empty scan', async () => {
  const { io } = fakeIo({ reply: () => ({ code: 0, stdout: '   ', stderr: '' }) })

  const outcome = await createSemgrepScanner(io, { cwd }).scan(full)

  assert.equal(outcome.status, 'failed', '"nothing found" must not be guessed from silence')
})

test('a report that is not JSON fails with the tool named', async () => {
  const { io } = fakeIo({ reply: () => ({ code: 0, stdout: '<html>502</html>', stderr: '' }) })

  const outcome = await createSemgrepScanner(io, { cwd }).scan(full)

  assert.equal(outcome.status, 'failed')
  assert.match(outcome.status === 'failed' ? outcome.error : '', /semgrep did not print JSON/)
})

// ------------------------------------------------------------------- the set

test('the default set is §6.2’s every-PR tools; trivy joins only when the repo has something for it', () => {
  const { io } = fakeIo()
  const options = { cwd, reportPath: () => reportPath }

  assert.deepEqual(
    createScanners(io, options).map((scanner) => scanner.id),
    [...defaultScannerIds],
  )
  assert.deepEqual(
    createScanners(io, { ...options, scanners: ['trivy', 'semgrep'] }).map((scanner) => scanner.id),
    ['trivy', 'semgrep'],
  )
})
