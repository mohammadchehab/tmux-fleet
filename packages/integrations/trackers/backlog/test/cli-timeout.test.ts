/** A hung `backlog` is killed at the runner's timeout and reported as a failed call. */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { backlogRunner } from '../src/cli.ts'

test('a backlog that never exits is killed at the timeout and answers code 124', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-backlog-'))
  writeFileSync(join(dir, 'backlog'), '#!/bin/sh\nexec sleep 30\n')
  chmodSync(join(dir, 'backlog'), 0o755)
  const saved = process.env['PATH']
  process.env['PATH'] = `${dir}:${saved}`
  try {
    const started = Date.now()
    const result = await backlogRunner(200)(['task', 'list'], { cwd: dir })
    assert.equal(result.code, 124)
    assert.match(result.stderr, /timed out after 200ms/)
    assert.ok(Date.now() - started < 5000)
  } finally {
    process.env['PATH'] = saved
  }
})
