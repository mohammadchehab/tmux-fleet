/**
 * `stripControl` against the sequences a terminal actually obeys.
 *
 * Every fixture is a real sequence rather than a lone `\u001b`, because a lone
 * escape is the one payload a shell already eats: the dangerous ones are whole —
 * CSI wipes the screen, OSC sets the title or writes the clipboard.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { stripControl } from '../src/control.ts'

/** Anything left that a terminal would act on rather than draw. */
const controls = (text: string): readonly string[] => text.match(/[\u0000-\u001f\u007f-\u009f]/g) ?? []

test('a CSI sequence goes whole, not just its escape', () => {
  // Taking the ESC and leaving `[2J` on the screen is not a fix: it is the same
  // screen with the sequence spelled out in letters.
  assert.equal(stripControl('\u001b[2Jseen'), 'seen')
  assert.equal(stripControl('a\u001b[1;31mred\u001b[0m'), 'ared')
  assert.equal(stripControl('\u001b[?1049h'), '')
})

test('an OSC sequence goes whole, whichever terminator it uses', () => {
  assert.equal(stripControl('\u001b]0;pwned\u0007after'), 'after')
  assert.equal(stripControl('\u001b]52;c;cGF5bG9hZA==\u0007after'), 'after')
  // The string terminator is as legal as the BEL, and just as invisible.
  assert.equal(stripControl('\u001b]0;pwned\u001b\\after'), 'after')
})

test('a two-byte escape goes, including the one that resets the terminal', () => {
  assert.equal(stripControl('before\u001bcafter'), 'beforeafter')
  assert.equal(stripControl('\u001b7\u001b8'), '')
})

test('what is left of C0, DEL and C1 goes too', () => {
  assert.equal(stripControl('a\u0007b\u0008c\u007fd'), 'abcd')
  // The 8-bit form of CSI: one character, and no escape byte to notice.
  assert.equal(stripControl('a\u009b31mb'), 'a31mb')
  assert.deepEqual(controls(stripControl('a\u0000\u001f\u007f\u009fb')), [])
})

test('a newline separates words rather than vanishing', () => {
  // Stripping it outright would run two sentences together, which is a worse
  // transcript than the one with a space where the break was.
  assert.equal(stripControl('one\ntwo'), 'one two')
  assert.equal(stripControl('a\tb'), 'a b')
  assert.equal(stripControl('a\r\nb'), 'a  b')
})

test('ordinary text a peer wrote comes through untouched', () => {
  const text = 'Read src/a.ts · ✓ 100% — two words'
  assert.equal(stripControl(text), text)
  assert.deepEqual(controls(stripControl(text)), [])
})

test('a payload that is only escapes leaves nothing to print', () => {
  // Which is the point: the row is empty, not a row that does something.
  assert.equal(stripControl('\u001b[2J\u001b[1;1H\u001b]0;x\u0007'), '')
})
