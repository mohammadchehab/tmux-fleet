/**
 * The grammar, word by word. Nothing here opens a socket or a port, so every
 * branch a person can reach with a typo is a test.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FleetError } from '@fleet/foundation-core'

import { DEFAULT_HOST, DEFAULT_PORT, parseArgv } from '../src/args.ts'

const parse = (...words: string[]) => parseArgv(['node', 'fleet-board', ...words])

const refuses = (message: RegExp, ...words: string[]) => {
  try {
    parse(...words)
  } catch (thrown) {
    assert.ok(thrown instanceof FleetError, 'a refusal is a FleetError, not a TypeError')
    assert.equal(thrown.code, 'invalid_input')
    assert.match(thrown.message, message)
    return
  }
  assert.fail(`"${words.join(' ')}" should have been refused`)
}

describe('board args: two shapes', () => {
  it('serves on loopback by default', () => {
    assert.deepEqual(parse(), { kind: 'serve', host: DEFAULT_HOST, port: DEFAULT_PORT })
  })

  it('renders once when asked', () => {
    assert.deepEqual(parse('--once'), { kind: 'once' })
  })

  it('takes --name value and --name=value alike', () => {
    assert.deepEqual(parse('--port', '9000', '--host=0.0.0.0'), {
      kind: 'serve',
      host: '0.0.0.0',
      port: 9000,
    })
  })

  it('carries the target through to both shapes', () => {
    assert.deepEqual(parse('--profile', 'work', '--once'), { kind: 'once', profile: 'work' })
    assert.deepEqual(parse('--socket=/x.sock'), {
      kind: 'serve',
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      socket: '/x.sock',
    })
  })

  it('takes port 0 as "pick a free one"', () => {
    const command = parse('--port', '0')
    assert.equal(command.kind === 'serve' ? command.port : -1, 0)
  })

  it('prints its usage on --help rather than serving', () => {
    assert.deepEqual(parse('--help'), { kind: 'help' })
    assert.deepEqual(parse('-h'), { kind: 'help' })
  })
})

describe('board args: what it refuses', () => {
  it('refuses a bare word: the board takes options only', () => {
    refuses(/unexpected argument "now"/, 'now')
  })

  it('refuses an unknown option rather than ignoring it', () => {
    refuses(/unknown option --verbose/, '--verbose')
  })

  it('refuses a flag with no value', () => {
    refuses(/--port needs a value/, '--port')
    refuses(/--host needs a value/, '--host=')
  })

  it('refuses a port that is not a port', () => {
    refuses(/--port takes a whole number from 0 to 65535, not "eighty"/, '--port', 'eighty')
    refuses(/not "70000"/, '--port', '70000')
  })

  it('refuses two ways of naming the same fleet', () => {
    refuses(/--socket and --profile name the same fleet two ways/, '--socket', '/x.sock', '--profile', 'work')
  })
})
