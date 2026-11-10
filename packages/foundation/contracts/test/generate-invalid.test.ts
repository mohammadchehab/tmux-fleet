/**
 * The invalid-event corpus is generated, so it can go stale in two ways: the
 * generator stops being deterministic, or the tree stops matching it. This
 * holds both.
 *
 * The drift that prompted this test: the generator chose a field by rotating
 * over the registry index, so inserting an unrelated event type rewrote other
 * types' fixtures — and a PR that inserted one and did not regenerate left the
 * corpus on disk disagreeing with what the generator produces.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { buildInvalidCorpus } from '../generate-invalid.ts'

const packageDir = new URL('../', import.meta.url)

const onDisk = (dir: string): string[] =>
  readdirSync(new URL(`./${dir}/`, packageDir))
    .filter((name) => name.endsWith('.json'))
    .map((name) => `${dir}/${name}`)
    .sort()

test('generating twice produces the same bytes', () => {
  assert.deepEqual(
    buildInvalidCorpus().map(({ path, contents }) => ({ path, contents })),
    buildInvalidCorpus().map(({ path, contents }) => ({ path, contents })),
    'the corpus is a function of the golden fixtures, not of a loop counter',
  )
})

test('the committed corpus is what the generator produces', () => {
  const corpus = buildInvalidCorpus()
  assert.deepEqual(
    corpus.map(({ path }) => path).sort(),
    [...onDisk('test/fixtures/events-invalid'), ...onDisk('test/fixtures/provider-events-invalid')].sort(),
    'a file per registered type and per provider event, and no file for one that is gone',
  )
  for (const { path, contents } of corpus) {
    assert.equal(
      readFileSync(new URL(`./${path}`, packageDir), 'utf8'),
      contents,
      `${path} is stale — run node --experimental-strip-types generate-invalid.ts`,
    )
  }
})
