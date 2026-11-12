/**
 * §6.2 through the real daemon: a profile that names scanners gets the
 * `security-scan` routine, and a `pr.opened` is what runs it.
 *
 * The unit tests prove the planner, the adapters and the body. What only this
 * can prove is the wiring — that `profile.security.scanners` reaches the
 * scheduler's factory map, that the trigger the daemon already had configured
 * (`pr.opened`, §6.2's every-PR rule) reaches the body, that the body snapshots the
 * commit from a checkout the fleet made, and that what it finds lands in the store the daemon
 * is using. The tools are injected, so a test run needs none of them installed.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AppendEvent } from '../../../packages/foundation/contracts/src/index.ts'
import type { Repo, Sha, WorktreeId } from '../../../packages/foundation/core/src/index.ts'
import type { ToolIo } from '../../../packages/security/scanners/src/index.ts'
import { createSandbox, until } from '../support/sandbox.ts'

const repo = 'sandbox/tmux-fleet' as Repo
const sha = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0' as Sha
const checkout = '/tmp/fleet-integration/checkout'

const worktreeCreated: AppendEvent = {
  type: 'worktree.created',
  ts: '2026-11-10T09:00:00.000Z',
  subject: repo,
  actor: 'pm',
  data: { worktreeId: 'wtr_5e6f708192a3b4c5' as WorktreeId, repo, branch: 'topic/scan', path: checkout, class: 'active' },
}

const prOpened: AppendEvent = {
  type: 'pr.opened',
  ts: '2026-11-10T09:00:00.000Z',
  subject: `${repo}#7`,
  actor: 'pm',
  data: { pr: { repo, number: 7 }, base: 'main', head: 'topic/scan', headSha: sha },
}

/**
 * semgrep, answering with one finding — and recording nothing else, because
 * nothing else may run. `head` is the commit the fake checkout is at: the body
 * scans only a tree that is at the commit the finding is filed under.
 */
const fakeIo = (head: Sha = sha): ToolIo => ({
  has: async (binary) => binary === 'semgrep',
  exec: async (binary, args, options) => ({
    code: 0,
    stderr: '',
    stdout:
      binary === 'git'
        ? args[0] === 'rev-parse'
          ? `${head}\n`
          : ''
        : binary === 'semgrep'
        ? JSON.stringify({
            results: [
              {
                check_id: 'typescript.lang.security.audit.shell-injection',
                // The body scans a snapshot of the commit, so the tool reports paths under its cwd.
                path: `${options?.cwd ?? checkout}/src/run.ts`,
                start: { line: 12 },
                extra: { severity: 'error', lines: '  exec(userInput)' },
              },
            ],
          })
        : '',
  }),
  readFile: async (path) => {
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  },
})

test('§6.2: a pr.opened is scanned by the tools the profile named, and the finding is in the store', async (t) => {
  const sandbox = await createSandbox({ security: ['semgrep'], securityIo: fakeIo() })
  t.after(() => sandbox.stop())

  await sandbox.call('up')

  // The PM would append these itself; the rule under test is what the fleet does
  // with them, so the test writes what the PM writes and wakes the routine the
  // way an append would (§5.2). The fleet's checkout is the row that tells the
  // body where to scan — no repository exists at that path, and none needs to.
  await sandbox.composed.store.append([worktreeCreated, prOpened])
  const opened = (await sandbox.composed.store.read(0, 10_000)).find((event) => event.type === 'pr.opened')
  assert.ok(opened !== undefined)
  await sandbox.composed.scheduler.wake(opened)

  const raised = await until(
    async () => (await sandbox.events()).find((event) => event.type === 'finding.raised'),
    'the scan to raise its finding',
  )

  assert.equal(raised.data.tool, 'semgrep')
  assert.equal(raised.data.path, 'src/run.ts', 'relative to the checkout, as §6.2 requires')
  assert.equal(raised.data.severity, 'high')
  assert.equal(raised.data.sha, sha)
  assert.equal(raised.subject, raised.data.findingId)

  const findings = await sandbox.composed.store.reader().findings.all()
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.state, 'open')
  assert.equal(findings[0]?.findingId, raised.data.findingId)

  // The run is in the record the daemon serves, not only in the log: a routine
  // that scanned without a row would be the silence §6 forbids.
  interface RoutinesLike {
    readonly routines: readonly { readonly kind: string; readonly runs: number }[]
  }
  const ls = await sandbox.call<RoutinesLike>('ls')
  const scan = ls.routines.find((routine) => routine.kind === 'security-scan')
  assert.ok(scan !== undefined, 'the security-scan routine ran at least once')
  assert.ok(scan.runs >= 1)
})

test('§6.2: the 02:00 schedule scans main at the head the workspace port names', async (t) => {
  const mainSha = 'f00dc0ffee0123456789abcdef0123456789abcd' as Sha
  const sandbox = await createSandbox({
    security: ['semgrep'],
    securityIo: fakeIo(mainSha),
    // The `workspace` port (§9): a fake, so the nightly scan never fetches a remote.
    branchHead: { head: async (cwd) => (cwd === checkout ? mainSha : undefined) },
  })
  t.after(() => sandbox.stop())

  // The checkout is in the store before the daemon starts, because §6's catch-up
  // runs a schedule that has no recorded run on the first start — and that first
  // run is the nightly scan this test is about.
  await sandbox.composed.store.append([worktreeCreated])
  await sandbox.call('up')

  const raised = await until(
    async () => (await sandbox.events()).find((event) => event.type === 'finding.raised'),
    'the nightly scan to raise its finding',
  )

  assert.equal(raised.data.sha, mainSha, 'the nightly scan reports the head it was given, not a guess')
  assert.equal(raised.data.tool, 'semgrep')
})

test('§6.2: a profile with no `security` block installs no scanner, and a pr.opened is not scanned', async (t) => {
  const sandbox = await createSandbox()
  t.after(() => sandbox.stop())

  await sandbox.call('up')

  await sandbox.composed.store.append([worktreeCreated, prOpened])
  const opened = (await sandbox.composed.store.read(0, 10_000)).find((event) => event.type === 'pr.opened')
  assert.ok(opened !== undefined)
  await sandbox.composed.scheduler.wake(opened)

  // Nothing to wait for, so the assertion is the absence after the tick the
  // other test relies on: give the scheduler the same window, then read.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(
    (await sandbox.events()).filter((event) => event.type === 'finding.raised' || event.type === 'scan.skipped'),
    [],
    'a fleet that did not ask to scan must not look like it is scanning',
  )
})
