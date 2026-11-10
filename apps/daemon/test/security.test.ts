/**
 * The daemon's side of §6.2: the `security-scan` routine as the scheduler sees it.
 *
 * The planner (`@fleet/security-findings`) and the adapters
 * (`@fleet/security-scanners`) are proven by their own tests. What can still be
 * wrong here is the marriage, and it is three questions the daemon answers and
 * nothing else does: *which checkout* a target is scanned in, *what counts as
 * already known*, and *what the routine reports when it could not scan at all*.
 * So this test drives the body through `RoutineContext` over the real store,
 * with a fake `ToolIo` that never spawns anything.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Clock, Repo, Sha, WorktreeId } from '@fleet/foundation-core'
import { appendIssues, type AppendEvent, type BranchHead, type FleetEvent } from '@fleet/foundation-contracts'
import { openSqliteStore, type EventStore } from '@fleet/foundation-store'
import type { RoutineContext } from '@fleet/orchestration-routines'
import type { ScanRequest } from '@fleet/security-findings'
import type { ScannerId, ToolIo } from '@fleet/security-scanners'
import { createSecurityScanFactory, prTargetsOf, scanTargets, securityScanned } from '../src/security.ts'

const repo = 'acme/fleet' as Repo
const sha = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0' as Sha
const checkout = '/tmp/fleet/acme-fleet'
const reportPath = (name: string): string => `/tmp/fleet-reports/${name}`

const at = '2026-11-10T09:00:00.000Z'
const clock: Clock = { now: () => at, millis: () => Date.parse(at) }

const open = async (): Promise<EventStore> =>
  openSqliteStore({ path: join(mkdtempSync(join(tmpdir(), 'fleet-daemon-security-')), 'store.sqlite'), clock })

const prOpened: AppendEvent = {
  type: 'pr.opened',
  ts: at,
  subject: `${repo}#42`,
  actor: 'pm',
  data: { pr: { repo, number: 42 }, base: 'main', head: 'topic/scan', headSha: sha },
}

const worktreeCreated: AppendEvent = {
  type: 'worktree.created',
  ts: at,
  subject: repo,
  actor: 'pm',
  data: {
    worktreeId: 'wtr_5e6f708192a3b4c5' as WorktreeId,
    repo,
    branch: 'topic/scan',
    path: checkout,
    class: 'active',
  },
}

const context = (event?: FleetEvent): RoutineContext => ({
  routineId: 'security-scan',
  kind: 'security-scan',
  trigger: event === undefined ? 'schedule' : 'event',
  at,
  clock,
  ...(event === undefined ? {} : { event }),
})

/** A `ToolIo` that answers `which` from a list and replays canned reports — no process, ever. */
interface Call {
  readonly binary: string
  readonly args: readonly string[]
  readonly cwd?: string
}

const fakeIo = (options: {
  readonly installed?: readonly string[]
  readonly stdout?: Readonly<Record<string, string>>
  readonly files?: Readonly<Record<string, string>>
  /** Binaries whose execution fails, as a spawn failure would. */
  readonly broken?: readonly string[]
  readonly calls?: Call[]
}): ToolIo => {
  const installed = options.installed ?? ['semgrep', 'gitleaks', 'osv-scanner']
  const broken = options.broken ?? []
  // A tool that ran and found nothing still prints a report; a test that wants
  // findings overrides one entry, and the other two stay quiet rather than
  // failing as "printed no report".
  const stdout: Readonly<Record<string, string>> = {
    semgrep: '{"results":[]}',
    'osv-scanner': '{"results":[]}',
    ...options.stdout,
  }
  const files: Readonly<Record<string, string>> = { [reportPath('gitleaks.json')]: '[]', ...options.files }

  return {
    has: async (binary) => installed.includes(binary),
    exec: async (binary, args, execOptions) => {
      options.calls?.push({ binary, args, ...(execOptions?.cwd === undefined ? {} : { cwd: execOptions.cwd }) })
      if (broken.includes(binary)) throw new Error(`${binary}: spawn ENOENT`)
      return { code: 0, stdout: stdout[binary] ?? '', stderr: '' }
    },
    readFile: async (path) => {
      const content = files[path]
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return content
    },
  }
}

const semgrepReport = (): string =>
  JSON.stringify({
    version: '1.184.0',
    results: [
      {
        check_id: 'typescript.lang.security.audit.shell-injection',
        path: `${checkout}/src/run.ts`,
        start: { line: 12 },
        extra: { severity: 'error', lines: '  exec(userInput)' },
      },
    ],
  })

const events = async (store: EventStore): Promise<readonly FleetEvent[]> => store.read(0, 500)

/** A `FleetEvent` as the append that produced it: the store's `seq` is not the caller's to pass. */
const withoutSeq = (event: FleetEvent): AppendEvent => {
  const { seq, ...appendable } = event
  return appendable as AppendEvent
}

/** A `BranchHead` that answers from a map of checkout path to sha — no git, no remote, no network. */
const headOf = (heads: Readonly<Record<string, string>>): BranchHead => ({
  head: async (cwd) => heads[cwd] as Sha | undefined,
})

const findingsOf = async (store: EventStore) => (await store.reader()).findings.all()

/** The event the scheduler hands the body when a `pr.opened` wakes it; `seq` is the store's, not the body's business. */
const opened = { seq: 2, ...prOpened } as FleetEvent

const scan = (store: EventStore, io: ToolIo, options?: { readonly scanners?: readonly ScannerId[] }) =>
  securityScanned(
    {
      store: { append: (batch) => store.append(batch) },
      io,
      scanners: options?.scanners ?? ['semgrep', 'gitleaks', 'osv-scanner'],
      reportPath,
      read: store.reader(),
    },
    context(opened),
  )

describe('the security-scan routine the daemon registers (§6.2)', () => {
  it('is registered under the kind the scheduler asks for', () => {
    const factory = createSecurityScanFactory({
      store: { append: async () => [] },
      io: fakeIo({}),
      scanners: ['semgrep'],
      reportPath,
    })
    const body = factory({
      pm: {} as never,
      executor: {} as never,
      read: {} as never,
    })
    assert.equal(body.kind, 'security-scan')
  })

  it('scans the checkout the fleet made for that repository, not the daemon’s cwd', async () => {
    const store = await open()
    await store.append([worktreeCreated, prOpened])
    const calls: Call[] = []

    const outcome = await scan(store, fakeIo({ stdout: { semgrep: semgrepReport() }, calls }))
    assert.equal(outcome.actionsFailed, 0)
    assert.ok(calls.length > 0)
    for (const call of calls) assert.equal(call.cwd, checkout, `${call.binary} runs in the fleet's worktree`)

    await store.close()
  })

  it('appends one finding.raised per new finding, and counts it as an action', async () => {
    const store = await open()
    await store.append([worktreeCreated, prOpened])

    const outcome = await scan(store, fakeIo({ stdout: { semgrep: semgrepReport() } }))
    const raised = (await events(store)).filter((event) => event.type === 'finding.raised')

    assert.equal(raised.length, 1)
    assert.equal(outcome.actions, 1)
    assert.equal(outcome.actionsFailed, 0)

    const [finding] = await findingsOf(store)
    assert.equal(finding?.path, 'src/run.ts', 'the path is relative to the checkout')
    assert.equal(finding?.severity, 'high', "semgrep's error is high")
    assert.equal(finding?.sha, sha)
    assert.equal(raised[0]?.subject, finding?.findingId, 'the event is about the row it became')

    await store.close()
  })

  it('records a re-sighted fingerprint as finding.seen, keeping the id it was raised under', async () => {
    const store = await open()
    await store.append([worktreeCreated, prOpened])
    await scan(store, fakeIo({ stdout: { semgrep: semgrepReport() } }))
    const [first] = await findingsOf(store)

    const outcome = await scan(store, fakeIo({ stdout: { semgrep: semgrepReport() } }))
    const seen = (await events(store)).filter((event) => event.type === 'finding.seen')

    assert.equal(seen.length, 1)
    assert.equal(outcome.actions, 1)
    assert.equal(seen[0]?.subject, first?.findingId)
    assert.equal((await findingsOf(store)).length, 1, 'a re-sight is not a second row')

    await store.close()
  })

  it('records a missing checkout as one skip and reports it as an action that failed', async () => {
    const store = await open()
    await store.append([prOpened])

    const outcome = await scan(store, fakeIo({ stdout: { semgrep: semgrepReport() } }))
    const [skipped] = (await events(store)).filter((event) => event.type === 'scan.skipped')

    assert.equal(outcome.actions, 1)
    assert.equal(outcome.actionsFailed, 1)
    assert.equal(skipped?.subject, repo)
    assert.equal(skipped?.data.tool, 'security-scan', 'the routine declined, before any tool was asked')
    assert.match(String(skipped?.data.reason), /no checkout for acme\/fleet at a1b2c3d/)
    assert.deepEqual(await findingsOf(store), [], 'a skip raises nothing')

    await store.close()
  })

  it('a broken tool fails its own scan and does not stop the others', async () => {
    const store = await open()
    await store.append([worktreeCreated, prOpened])

    const io = fakeIo({
      broken: ['semgrep'],
      files: {
        [reportPath('gitleaks.json')]: JSON.stringify([
          { RuleID: 'generic-api-key', Description: 'Generic API Key', File: 'src/config.ts', StartLine: 7 },
        ]),
      },
    })
    const outcome = await scan(store, io)

    const findings = await findingsOf(store)
    assert.deepEqual(
      findings.map((finding) => finding.tool),
      ['gitleaks'],
      'the tool that ran still reported',
    )
    assert.equal(outcome.actionsFailed, 1, 'the broken semgrep is one failed action')
    assert.equal(outcome.actions, 2, 'one finding, one skip')

    const skipped = (await events(store)).filter((event) => event.type === 'scan.skipped')
    assert.equal(skipped.length, 1)
    assert.equal(skipped[0]?.data.tool, 'semgrep')
    assert.match(String(skipped[0]?.data.reason), /^failed: semgrep:/)

    await store.close()
  })

  it('a tool that is not installed is a recorded skip, not a failure', async () => {
    const store = await open()
    await store.append([worktreeCreated, prOpened])

    const outcome = await scan(store, fakeIo({ installed: [], stdout: {} }))
    const skipped = (await events(store)).filter((event) => event.type === 'scan.skipped')

    assert.deepEqual(
      skipped.map((event) => event.data.tool).sort(),
      ['gitleaks', 'osv-scanner', 'semgrep'],
    )
    assert.equal(outcome.actions, 3)
    assert.equal(outcome.actionsFailed, 0, 'an absent tool is a skip, not a broken run')

    await store.close()
  })

  it('a scheduled tick with no nightly wiring scans nothing rather than guessing a target', async () => {
    const store = await open()
    await store.append([worktreeCreated])

    // A profile that never wired checkouts to scan gets no nightly target. The
    // schedule must not be read as "scan whatever checkout happens to exist" —
    // that is the guess this test forbids.
    const outcome = await securityScanned(
      {
        store: { append: (batch) => store.append(batch) },
        io: fakeIo({ stdout: { semgrep: semgrepReport() } }),
        scanners: ['semgrep'],
        reportPath,
        read: store.reader(),
      },
      context(),
    )

    assert.equal(outcome.actions, 0)
    assert.equal(outcome.actionsFailed, 0)
    assert.deepEqual(
      (await events(store)).filter((event) => event.type.startsWith('finding.') || event.type === 'scan.skipped'),
      [],
    )

    await store.close()
  })

  it('a nightly tick scans main at the head the checkout names, full scope', async () => {
    const store = await open()
    await store.append([worktreeCreated])

    const outcome = await securityScanned(
      {
        store: { append: (batch) => store.append(batch) },
        io: fakeIo({ stdout: { semgrep: semgrepReport() } }),
        scanners: ['semgrep'],
        reportPath,
        read: store.reader(),
        nightly: { repos: [repo], branch: 'main', head: headOf({ [checkout]: sha }) },
      },
      context(),
    )

    const raised = (await events(store)).filter((event) => event.type === 'finding.raised')
    assert.equal(raised.length, 1)
    assert.equal(outcome.actions, 1)
    assert.equal(outcome.actionsFailed, 0)
    // Nightly scans the whole tree, unlike a PR's diff: the point is everything
    // that is on main tonight, not only what tonight's PR touched.
    assert.equal(raised[0]?.data.sha, sha)
    await store.close()
  })

  it('a nightly repo with no resolvable head is a recorded skip with no sha, and a failed action', async () => {
    const store = await open()
    await store.append([worktreeCreated])

    const outcome = await securityScanned(
      {
        store: { append: (batch) => store.append(batch) },
        io: fakeIo({ stdout: { semgrep: semgrepReport() } }),
        scanners: ['semgrep'],
        reportPath,
        read: store.reader(),
        // The checkout exists, but git cannot name a head for it.
        nightly: { repos: [repo], branch: 'main', head: headOf({}) },
      },
      context(),
    )

    const skips = (await events(store)).filter((event) => event.type === 'scan.skipped')
    assert.equal(skips.length, 1)
    assert.equal(skips[0]?.data.sha, undefined, 'a repo-level skip names no commit')
    assert.equal(skips[0]?.data.tool, 'security-scan')
    assert.match(String(skips[0]?.data.reason), /no main head/)
    assert.equal(outcome.actions, 1)
    assert.equal(outcome.actionsFailed, 1, 'an unscanned repo is visible, not idle')
    assert.deepEqual(appendIssues(withoutSeq(skips[0]!)), [], 'the shardless skip is a valid append')

    await store.close()
  })

  it('a nightly repo the fleet has no checkout for is not a target, and not a failure', async () => {
    const store = await open()

    // No `worktree.created`: the fleet has no copy of the repo, so there is
    // nothing to scan. Recording a failure every night for a repo we are not
    // working in is how `actionsFailed` stops meaning anything.
    const outcome = await securityScanned(
      {
        store: { append: (batch) => store.append(batch) },
        io: fakeIo({ stdout: { semgrep: semgrepReport() } }),
        scanners: ['semgrep'],
        reportPath,
        read: store.reader(),
        nightly: { repos: [repo], branch: 'main', head: headOf({}) },
      },
      context(),
    )

    assert.equal(outcome.actions, 0)
    assert.equal(outcome.actionsFailed, 0)
    assert.deepEqual(
      (await events(store)).filter((event) => event.type === 'scan.skipped' || event.type === 'finding.raised'),
      [],
    )

    await store.close()
  })

  it('a heartbeat has no nightly target even when the wiring is present', async () => {
    const plan = await scanTargets(
      { read: {} as never, nightly: { repos: [repo], branch: 'main', head: headOf({}) } },
      { ...context(), trigger: 'heartbeat' },
    )
    assert.deepEqual(plan, { targets: [], unresolved: [] })
  })

  it('only a pr.opened event is a PR target, and it is scanned at its head SHA', () => {
    const scanned = prTargetsOf({
      seq: 1,
      ...prOpened,
    } as FleetEvent)

    assert.equal(scanned.length, 1)
    assert.deepEqual(scanned[0]?.request, {
      target: { repo, sha, pr: { repo, number: 42 } },
      scope: 'diff',
    } satisfies ScanRequest)

    assert.deepEqual(prTargetsOf(undefined), [], 'a heartbeat has no target')
  })

  it('validates every batch it appends against the contract', async () => {
    const store = await open()
    await store.append([worktreeCreated, prOpened])

    await scan(store, fakeIo({ stdout: { semgrep: semgrepReport() } }))
    await scan(store, fakeIo({ installed: [] }))

    for (const event of (await events(store)).slice(2)) {
      const { seq, ...appendable } = event
      assert.deepEqual(appendIssues(appendable), [], `${event.type} is a valid append (${String(seq)})`)
    }

    await store.close()
  })
})
