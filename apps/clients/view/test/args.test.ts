/**
 * The argument grammar: words in, a command out, `invalid_input` for the rest.
 * No socket, no terminal — `parseArgv` is a function of its argv and nothing else.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FleetError } from '@fleet/foundation-core'

import { DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, parseArgv, usage } from '../src/args.ts'

/** `argv[0]` is node and `argv[1]` the script, so the words start at the third element. */
const parse = (...words: readonly string[]): ReturnType<typeof parseArgv> => parseArgv(['node', 'fleet-view', ...words])

const refused = (words: readonly string[], pattern: RegExp): void => {
  assert.throws(
    () => parse(...words),
    (error: unknown) => {
      assert.ok(error instanceof FleetError, 'a bad argument is a FleetError, so main can exit 2')
      assert.equal(error.code, 'invalid_input')
      assert.match(error.message, pattern)
      return true
    },
  )
}

describe('args: the two shapes', () => {
  it('defaults to a live whole-fleet view on a two-second tick', () => {
    assert.deepEqual(parse(), { kind: 'live', intervalMs: DEFAULT_INTERVAL_MS })
  })

  it('`--once` is the same command, printed once', () => {
    assert.deepEqual(parse('--once'), { kind: 'once' })
  })

  it('`--pane` narrows either shape to one peer', () => {
    assert.deepEqual(parse('--pane', 'engineer-1'), { kind: 'live', intervalMs: DEFAULT_INTERVAL_MS, peer: 'engineer-1' })
    assert.deepEqual(parse('--once', '--pane=engineer-2'), { kind: 'once', peer: 'engineer-2' })
  })

  it('takes a profile or a socket, and carries it into both shapes', () => {
    assert.deepEqual(parse('--profile', 'firstrun'), {
      kind: 'live',
      intervalMs: DEFAULT_INTERVAL_MS,
      profile: 'firstrun',
    })
    assert.deepEqual(parse('--socket=/tmp/x.sock', '--once'), { kind: 'once', socket: '/tmp/x.sock' })
  })

  it('takes `--name value` and `--name=value` alike', () => {
    assert.deepEqual(parse('--interval', '500'), { kind: 'live', intervalMs: 500 })
    assert.deepEqual(parse('--interval=500'), { kind: 'live', intervalMs: 500 })
  })

  it('answers --help with the usage, and does not connect to anything', () => {
    assert.deepEqual(parse('--help'), { kind: 'help' })
    assert.deepEqual(parse('-h'), { kind: 'help' })
    assert.match(usage(), /usage: fleet-view/)
  })
})

describe('args: what is refused', () => {
  it('an option it does not have', () => {
    refused(['--watch'], /unknown option --watch/)
    refused(['-x'], /unknown option -x/)
  })

  it('a bare word: this command takes options only', () => {
    refused(['engineer-1'], /unexpected argument "engineer-1"/)
  })

  it('an option with no value', () => {
    refused(['--pane'], /--pane needs a value/)
    refused(['--profile='], /--profile needs a value/)
  })

  it('two ways of naming one fleet', () => {
    refused(['--socket', '/tmp/x.sock', '--profile', 'firstrun'], /name the same fleet two ways/)
  })

  it('an interval under the floor, or not a whole number', () => {
    refused(['--interval', '0'], /whole milliseconds/)
    refused(['--interval', '1.5'], /whole milliseconds/)
    refused(['--interval', 'soon'], /whole milliseconds/)
    // The floor is a floor: a view that outruns the reader costs a request per
    // peer per tick and buys nothing.
    assert.ok(MIN_INTERVAL_MS >= 100)
    assert.deepEqual(parse('--interval', String(MIN_INTERVAL_MS)), { kind: 'live', intervalMs: MIN_INTERVAL_MS })
  })

  it('a peer id the contract would not mint', () => {
    refused(['--pane', 'Engineer-1'], /PeerId/)
    refused(['--pane', 'engineer_1'], /PeerId/)
  })
})
