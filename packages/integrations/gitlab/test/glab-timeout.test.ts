/**
 * A hung `glab` (a credential prompt, a dead network) is killed at the runner's
 * timeout and reported as a failed call, so the routine that asked is not stalled.
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { execFileGlab } from '../src/glab.ts'

test('a glab that never exits is killed at the timeout and answers code 124', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-glab-'))
  writeFileSync(join(dir, 'glab'), '#!/bin/sh\nexec sleep 30\n')
  chmodSync(join(dir, 'glab'), 0o755)
  const saved = process.env['PATH']
  process.env['PATH'] = `${dir}:${saved}`
  try {
    const started = Date.now()
    const result = await execFileGlab(undefined, 200)(['mr', 'list'])
    assert.equal(result.code, 124)
    assert.match(result.stderr, /timed out after 200ms/)
    assert.ok(Date.now() - started < 5000, 'returned long before the fake would have exited')
  } finally {
    process.env['PATH'] = saved
  }
})
