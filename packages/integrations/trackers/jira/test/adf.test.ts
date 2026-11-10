/**
 * ADF → text (§3): the leaves that carry words, the blocks that end a line, and
 * the node types Atlassian may add later — which must keep their text rather
 * than empty it.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { adfToText } from '../src/adf.ts'

const doc = (...content: readonly unknown[]) => ({ type: 'doc', version: 1, content })
const paragraph = (...content: readonly unknown[]) => ({ type: 'paragraph', content })
const text = (value: string) => ({ type: 'text', text: value })

describe('adfToText', () => {
  it('keeps a paragraph’s words and ends its line', () => {
    assert.equal(adfToText(doc(paragraph(text('Page the list.')))), 'Page the list.')
  })

  it('separates blocks by a line and collapses the blank ones', () => {
    const description = doc(paragraph(text('First.')), paragraph(text('Second.')))
    assert.equal(adfToText(description), 'First.\nSecond.')
  })

  it('prefixes list items, numbering an ordered list from one', () => {
    const bullets = doc({
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraph(text('one'))] },
        { type: 'listItem', content: [paragraph(text('two'))] },
      ],
    })
    assert.equal(adfToText(bullets), '- one\n- two')

    const ordered = doc({
      type: 'orderedList',
      content: [
        { type: 'listItem', content: [paragraph(text('first'))] },
        { type: 'listItem', content: [paragraph(text('second'))] },
      ],
    })
    assert.equal(adfToText(ordered), '1. first\n2. second')
  })

  it('reads mentions, emoji, inline cards and hard breaks', () => {
    const description = doc(
      paragraph(
        text('Ask '),
        { type: 'mention', attrs: { text: '@Ada' } },
        text(' about '),
        { type: 'inlineCard', attrs: { url: 'https://acme.test/doc' } },
        { type: 'hardBreak' },
        text('then ship '),
        { type: 'emoji', attrs: { text: '🚀' } },
      ),
    )
    assert.equal(adfToText(description), 'Ask @Ada about https://acme.test/doc\nthen ship 🚀')
  })

  it('keeps a code block’s text as it was written', () => {
    const description = doc({
      type: 'codeBlock',
      content: [text('const a = 1\nconst b = 2')],
    })
    assert.equal(adfToText(description), 'const a = 1\nconst b = 2')
  })

  it('drops marks but keeps the words they styled', () => {
    const description = doc(
      paragraph({ type: 'text', text: 'bold', marks: [{ type: 'strong' }] }, text(' and plain')),
    )
    assert.equal(adfToText(description), 'bold and plain')
  })

  it('descends into a node type it does not know rather than dropping it', () => {
    const description = doc({
      type: 'SomethingAtlassianAddedLater',
      content: [paragraph(text('still readable'))],
    })
    assert.equal(adfToText(description), 'still readable')
  })

  it('answers undefined for an empty or absent description', () => {
    assert.equal(adfToText(doc()), undefined)
    assert.equal(adfToText(undefined), undefined)
    assert.equal(adfToText(null), undefined)
    assert.equal(adfToText('   '), undefined)
  })

  it('passes a plain string through, tidied', () => {
    assert.equal(adfToText('  Already\n\n\n\ntext  '), 'Already\n\ntext')
  })
})
