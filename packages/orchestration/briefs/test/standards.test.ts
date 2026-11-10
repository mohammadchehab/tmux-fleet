/** The standards text (§12.1): what it contains, in what order, what it costs, and when it counts as changed. */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  MAX_SOURCE_CHARS,
  MAX_TOTAL_CHARS,
  buildStandards,
  standardsLine,
  type StandardsSource,
} from '../src/standards.ts'

const sources: readonly StandardsSource[] = [
  { name: 'Non-negotiables (docs/non-negotiables.md)', text: 'Never push to main.', mode: 'refuse' },
  { name: 'skill:test-driven-development', text: 'Write the failing test first.', mode: 'refuse' },
  { name: 'AGENTS.md', text: 'Run pnpm test before you call it done.', mode: 'truncate', ref: 'a'.repeat(40) },
  { name: 'CLAUDE.md', text: 'Use codegraph first.', mode: 'truncate', ref: 'a'.repeat(40) },
]

describe('buildStandards', () => {
  it('puts every source in its own document, in the order given — order is precedence', () => {
    const { text } = buildStandards({ sources })

    const at = (needle: string): number => text.indexOf(needle)
    assert.ok(at('<document name="Non-negotiables') < at('<document name="skill:'))
    assert.ok(at('<document name="skill:') < at('<document name="AGENTS.md">'))
    assert.ok(at('<document name="AGENTS.md">') < at('<document name="CLAUDE.md">'))
    assert.equal(text.split('</document>').length - 1, 4, 'each source is closed, so a heading inside one stays inside it')
    for (const source of sources) assert.ok(text.includes(source.text))
    assert.doesNotMatch(text, /Skill tool/, 'a skill is a document handed over, not a name the peer is told to look up')
  })

  it('is deterministic, and any change to any document changes the digest', () => {
    const first = buildStandards({ sources })
    assert.deepEqual(buildStandards({ sources }), first)
    assert.match(first.digest, /^[0-9a-f]{64}$/)

    const edited = sources.map((source) => (source.name === 'AGENTS.md' ? { ...source, text: 'Run pnpm test.' } : source))
    assert.notEqual(buildStandards({ sources: edited }).digest, first.digest)
    assert.notEqual(buildStandards({ sources: sources.slice(1) }).digest, first.digest)
  })

  it('reports each document’s size, whether it was cut and the commit it came from, for the event', () => {
    const { sources: info } = buildStandards({ sources })
    assert.deepEqual(info[0], { name: 'Non-negotiables (docs/non-negotiables.md)', chars: 19, truncated: false })
    assert.deepEqual(info[2], { name: 'AGENTS.md', chars: 38, truncated: false, ref: 'a'.repeat(40) })
  })

  it('has no text when there is nothing to say, and the digest of nothing, so no standards line is written', () => {
    for (const input of [[], [{ name: 'AGENTS.md', text: '  \n', mode: 'truncate' as const }]]) {
      const standards = buildStandards({ sources: input })
      assert.deepEqual(standards, { text: '', digest: createHash('sha256').update('').digest('hex'), sources: [] })
      assert.equal(standardsLine(standards), '')
    }
  })

  it('cuts a repo’s document at the cap and says so, naming the file and both sizes', () => {
    const standards = buildStandards({
      sources: [{ name: 'AGENTS.md', text: 'x'.repeat(MAX_SOURCE_CHARS + 500), mode: 'truncate' }],
    })
    assert.match(standards.text, /\[truncated: AGENTS\.md is 16500 characters and only the first 16000 are here\./)
    assert.deepEqual(standards.sources, [{ name: 'AGENTS.md', chars: MAX_SOURCE_CHARS + 500, truncated: true }])
  })

  it('refuses a profile’s document over the cap instead of cutting its last rules, and says how to fix it', () => {
    for (const name of ['Non-negotiables (docs/n.md)', 'skill:big']) {
      assert.throws(
        () => buildStandards({ sources: [{ name, text: 'x'.repeat(MAX_SOURCE_CHARS + 1), mode: 'refuse' }] }),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, 'config_mismatch')
          assert.ok(error.message.includes(name))
          assert.match(error.message, /never cut.*shorten it/s)
          return true
        },
      )
    }
  })

  it('refuses the whole when it is over the total, naming the parts, rather than trimming it', () => {
    const big = (name: string): StandardsSource => ({ name, text: 'x'.repeat(MAX_SOURCE_CHARS), mode: 'truncate' })
    assert.throws(
      () => buildStandards({ sources: [big('A.md'), big('B.md'), big('C.md')] }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'config_mismatch')
        assert.match(error.message, new RegExp(`over the ${String(MAX_TOTAL_CHARS)}`))
        assert.match(error.message, /A\.md 16000, B\.md 16000, C\.md 16000/)
        return true
      },
    )
  })

  it('standardsLine carries the short digest, so a changed standard is a changed brief text', () => {
    const one = buildStandards({ sources })
    const two = buildStandards({ sources: [{ name: 'AGENTS.md', text: 'other', mode: 'truncate' }] })
    assert.match(standardsLine(one), new RegExp(`digest ${one.digest.slice(0, 12)}\\)`))
    assert.notEqual(standardsLine(one), standardsLine(two))
  })
})
