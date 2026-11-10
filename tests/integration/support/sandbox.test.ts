/**
 * The sandbox's profile, which every §15 integration test runs against.
 *
 * A routine a profile does not name is a routine that runs (§6: silence means
 * on), and a routine that runs writes — `routine.started`, `routine.failed` —
 * whenever its tick lands, which may be between two calls of a test that counts
 * the log. That is exactly what happened: `branch-cleanup` was added to §6's
 * table after this sandbox's list was written, so it ran unbidden, called
 * `gh pr list` against a repository that does not exist, and put two events into
 * `roundtrip.test.ts`'s rebuild count now and then.
 *
 * So the profile is generated from `routineKinds`, and this is the test that
 * says so: whatever §6 has, the sandbox switches off, and a test that wants one
 * gets that one and nothing else.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { routineKinds } from '../../../packages/foundation/contracts/src/index.ts'
import { planRoutines } from '../../../packages/orchestration/routines/src/index.ts'
import { sandboxRoutines } from './sandbox.ts'

test('the sandbox profile installs no routine at all', () => {
  assert.deepEqual(sandboxRoutines(), Object.fromEntries(routineKinds.map((kind) => [kind, { enabled: false }])))
  assert.deepEqual(planRoutines(sandboxRoutines()), [], 'every kind §6 has is switched off')
})

test('the one routine a test asks for is the only one that runs', () => {
  assert.deepEqual(
    planRoutines(sandboxRoutines(['dispatch'])).map((routine) => routine.kind),
    ['dispatch'],
  )
})

test('the routines switched on by an option are left for §6 to default', () => {
  // `notify` is on the profile's `notify.channel`, `security-scan` on its
  // `security.scanners`: naming them here with `enabled: false` would be the
  // setting overriding the block that was the reason to switch them on.
  assert.equal(sandboxRoutines([], 'macos', ['semgrep'])['notify'], undefined)
  assert.equal(sandboxRoutines([], 'macos', ['semgrep'])['security-scan'], undefined)
  assert.deepEqual(
    planRoutines(sandboxRoutines([], 'macos', ['semgrep'])).map((routine) => routine.kind),
    ['security-scan', 'notify'],
  )
})
