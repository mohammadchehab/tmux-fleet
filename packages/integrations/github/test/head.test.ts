/**
 * `matchHeadSha` (§10): whether an observation describes the PR in front of you.
 * Two `gh` calls, a push in between, and a green verdict graded at an older
 * commit is how a red PR merges; this is the rule that forbids recording it.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Sha } from '@fleet/foundation-core'
import { headMismatch, matchHeadSha } from '../src/head.ts'

const at = (value: string): { readonly headSha: Sha } => ({ headSha: value as Sha })

describe('matchHeadSha', () => {
  it('matches only the sha it was graded at', () => {
    assert.equal(matchHeadSha(at('abc1234'), at('abc1234')), true)
    assert.equal(matchHeadSha(at('abc1234'), at('def5678')), false)
  })

  it('reads a graded checks observation and a PR the same way, because both carry headSha', () => {
    const graded = { state: 'passing' as const, failing: [], headSha: 'abc1234' as Sha }
    const pr = { repo: 'o/r', number: 7, headSha: 'abc1234' as Sha }
    assert.equal(matchHeadSha(graded, pr), true)
  })
})

describe('headMismatch', () => {
  it('says nothing when the observation stands', () => {
    assert.equal(headMismatch(at('abc1234'), { ...at('abc1234'), repo: 'o/r', number: 7 }), undefined)
  })

  it('names both commits and the PR, so the refusal is actionable', () => {
    const why = headMismatch(at('abc1234'), { ...at('0123456789'), repo: 'o/r', number: 7 })
    assert.match(why ?? '', /graded at abc1234/)
    assert.match(why ?? '', /o\/r#7 is at 0123456789/)
    assert.match(why ?? '', /§10/)
  })

  it('falls back to a name for the PR when the caller did not say which one', () => {
    assert.match(headMismatch(at('abc1234'), at('def5678')) ?? '', /the pull request is at def5678/)
  })
})
