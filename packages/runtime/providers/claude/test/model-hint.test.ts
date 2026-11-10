// packages/runtime/providers/claude/test/model-hint.test.ts — "asked for model sonnet" says what the real ids are.
//
// The hint exists for one mistake: a model named from memory (`sonnet`, `opus`) rather than by id. It is a
// string on an error, so it is tested as one; the session's launch path that carries it needs a live SDK.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { providerModels } from '@fleet/foundation-contracts'
import { modelHint } from '../src/session.ts'

describe('the model mismatch hint', () => {
  it('lists the ids this repo knows when the one asked for is not among them', () => {
    const hint = modelHint('sonnet')
    for (const model of providerModels.claude) assert.match(hint, new RegExp(model))
    assert.match(hint, /^; the claude ids this repo knows are /)
  })

  it('says nothing when the id is one we know: a mismatch then is a different problem', () => {
    for (const model of providerModels.claude) assert.equal(modelHint(model), '')
  })

  it('still hints for an id it does not know — the list is a hint, not a gate', () => {
    // A proxied endpoint or a model newer than this checkout: the session may
    // well come up on it, and if it does not, the list is still the right hint.
    assert.match(modelHint('claude-sonnet-6-0'), /the claude ids this repo knows are/)
  })
})
