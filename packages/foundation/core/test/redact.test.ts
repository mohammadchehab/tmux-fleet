/**
 * `redactSecrets` against the shapes a secret actually arrives in.
 *
 * Every fixture is the non-secret phrase `do-not-print-me` in the place a real
 * secret would sit: the redactor is a pattern, and a realistic-looking key in a
 * test file is a finding the scanners are right to raise (the same reason
 * `tracker-sync`'s test uses it).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { redactSecrets } from '../src/redact.ts'

const SECRET = 'do-not-print-me'

// Assembled rather than written: an AWS key is a shape, not a phrase, so the
// only fixture that exercises the rule is one the scanners would flag in source.
const AWS_KEY = ['AKIA', 'DONOTPRINTME0000'].join('')

const redacted = (value: string): string => redactSecrets(value)

/** The input came through the redactor with the secret gone, and the mark left behind. */
const assertRedacted = (input: string, leaked: string = SECRET): void => {
  const output = redacted(input)
  assert.doesNotMatch(output, new RegExp(leaked), `the secret survived: ${output}`)
  assert.match(output, /\[REDACTED\]/, `nothing was marked as cut: ${output}`)
}

test('an env line keeps its name and loses its value, exported or not', () => {
  // The commonest paste of all: a whole `.env` line, upper-case, no quotes.
  assertRedacted(`export API_KEY=${SECRET}`)
  assertRedacted(`GITHUB_TOKEN=${SECRET}`)
  assertRedacted(`DEEPINFRA_API_KEY=${SECRET}`)
  assertRedacted(`AWS_SECRET_ACCESS_KEY=${SECRET}`)
  assert.equal(redacted(`API_KEY=${SECRET}`), 'API_KEY=[REDACTED]', 'the name is not the secret')
})

test('a vendor key is caught by its prefix, hyphens included', () => {
  // `sk-ant-…` is the Anthropic shape; the old rule only knew `sk_`.
  assertRedacted(`ANTHROPIC_API_KEY=sk-ant-api03-${SECRET}`)
  assertRedacted(`ghp_${SECRET}`)
  assertRedacted(`export TOKEN=ghp_${SECRET}`)
})

test('an authorization header is redacted with or without -H, in any case', () => {
  assertRedacted(`curl -H 'Authorization: Bearer ${SECRET}' https://example.test`)
  assertRedacted(`curl -H "AUTHORIZATION: Bearer ${SECRET}" https://example.test`)
  // No `-H`, no quotes: the header as a note would quote it.
  assertRedacted(`Authorization: Bearer ${SECRET}`)
  assertRedacted(`authorization: ${SECRET}`)
  assertRedacted(`curl -H "X-Api-Key: ${SECRET}" https://example.test`)
  assertRedacted(`Proxy-Authorization: Basic ${SECRET}`)
})

test('a name-value pair in prose or JSON loses its value', () => {
  assertRedacted(`token: ${SECRET}`)
  assertRedacted(`{"password":"${SECRET}"}`)
  assertRedacted(`password=${SECRET}`)
  assertRedacted(`  password=${SECRET}`)
  assertRedacted(`client_secret: ${SECRET}`)
})

test('a connection string loses its password and keeps its shape', () => {
  const output = redacted(`postgres://fleet:${SECRET}@db.internal:5432/fleet`)
  assert.doesNotMatch(output, new RegExp(SECRET))
  assert.match(output, /^postgres:\/\/fleet:\[REDACTED\]@db\.internal:5432\/fleet$/)
})

test('an AWS access key id is recognised on its own', () => {
  assertRedacted(`the key was ${AWS_KEY} when I found it`, AWS_KEY)
})

test('a PEM block goes whole, header and body', () => {
  // A label rather than a real key kind: the rule redacts any `BEGIN … END`
  // block, because a note that carries one is carrying the key inside it.
  const pem = ['-----BEGIN DO-NOT-PRINT-ME-----', SECRET, SECRET, '-----END DO-NOT-PRINT-ME-----'].join('\n')
  const output = redacted(`here it is:\n${pem}\nthanks`)
  assert.doesNotMatch(output, new RegExp(SECRET))
  assert.doesNotMatch(output, /BEGIN DO-NOT-PRINT-ME/)
  assert.match(output, /^here it is:\n\[REDACTED\]\nthanks$/)
})

test('a command-line secret loses its value in both spellings', () => {
  assertRedacted(`deploy --api_key=${SECRET} now`)
  assertRedacted(`deploy --token ${SECRET} now`)
})

test('a query parameter is caught even with a compound name', () => {
  assertRedacted(`https://example.test/cb?access_token=${SECRET}&x=1`)
  assertRedacted(`https://example.test/cb?x=1&client_secret=${SECRET}`)
  assertRedacted(`https://example.test/cb?api_key=${SECRET}`)
})

test('text with no secret in it comes through untouched', () => {
  // A redactor that eats ordinary prose is one nobody can trust to leave the rest
  // alone, so the shapes above must not be the only thing that survives.
  const prose = 'the scheduler woke the peer, the transition moved the card to In Review, and the build passed'
  assert.equal(redacted(prose), prose)

  const code = 'if (peer.token !== undefined) return peer.token.length'
  assert.equal(redacted(code), code, 'a property read is not an assignment')

  // A comparison is not an assignment, and a value that opens a bracket is code.
  const comparisons = "if (token === '') throw new Error('missing')\nconst token = (firstLine ?? '').trim()"
  assert.equal(redacted(comparisons), comparisons)
})

test('a field that counts tokens is not a credential', () => {
  // The sweep that found the misses also finds this: `tokens` is a count in this
  // repo, and a note quoting a snippet must stay readable. The rule matches a
  // name piece, not a substring — `token` followed by `s` or `R` is another word.
  const snippet = [
    'const totals = { turns: 0, inputTokens: 0, outputTokens: 0, tokens: [] }',
    'const tokenRow = (row: TokenReport): readonly string[] => []',
  ].join('\n')
  assert.equal(redacted(snippet), snippet)
})

test('a quoted value keeps the quotes it had', () => {
  // The delimiter is the shape of the value, not part of the secret.
  assert.equal(redacted(`{"password":"${SECRET}"}`), '{"password":"[REDACTED]"}')
})

test('text a note can contain does not make the redactor backtrack', () => {
  // This runs in the daemon on a peer's note, so the note's content decides the
  // cost. A run of dashes or of `a_` used to be quadratic — and the PEM rules
  // exponential — which is a daemon a single note could stall. Each of these is
  // ~32k of the one character class a rule reads, and the whole set must be cheap.
  const cases = ['-'.repeat(32_000), 'a_'.repeat(16_000), 'A'.repeat(32_000), '-----BEGIN x-----\n'.repeat(2_000)]
  const started = Date.now()
  for (const text of cases) redactSecrets(text)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1_500, `redacting 4 pathological notes took ${elapsed}ms`)
})
