/**
 * `fleet-board`'s argument grammar (§2): words in, one of a closed set of
 * commands out, `invalid_input` for anything else.
 *
 * The grammar is two shapes, not four. `--once` renders the page to stdout and
 * exits; without it the same page is served over HTTP on `--host`:`--port`.
 * That is one rule ("show this, once or until interrupted") rather than a flag
 * per mode, and it is what makes `--once` a test of the exact renderer the
 * server uses.
 *
 * Nothing here touches `process`, a socket or a port, so every branch below is
 * a test.
 */

import { fleetError } from '@fleet/foundation-core'

export const DEFAULT_PORT = 7777
/** Loopback by default: a board that serves a fleet's Work to the network is a decision, not a default. */
export const DEFAULT_HOST = '127.0.0.1'

export interface Target {
  /** `--socket`, verbatim. */
  readonly socket?: string
  /** `--profile`, or `FLEET_PROFILE` when this is absent. */
  readonly profile?: string
}

export type BoardCommand =
  /** Render once, print, exit. */
  | ({ readonly kind: 'once' } & Target)
  /** Serve the same page until interrupted. */
  | ({ readonly kind: 'serve'; readonly host: string; readonly port: number } & Target)
  | { readonly kind: 'help' }

export const usage = (): string =>
  [
    'fleet-board: a read-only board of the fleet\'s Work items',
    '',
    'usage: fleet-board [--profile <name> | --socket <path>] [--host <addr>] [--port <n>] [--once]',
    '',
    '  --profile <name>   the fleet to read; defaults to FLEET_PROFILE',
    '  --socket <path>    talk to this daemon socket instead; defaults to FLEET_SOCKET',
    '  --host <addr>      the address to serve on (default 127.0.0.1)',
    '  --port <n>         the port to serve on (default 7777; 0 picks a free one)',
    '  --once             print the page and exit, with no server or browser needed',
    '  -h, --help         this',
  ].join('\n')

const usageError = (message: string): Error => fleetError('invalid_input', message)

/** `--name value` and `--name=value` both, as the rest of the fleet's CLI takes them. */
const valueOf = (args: readonly string[], index: number, arg: string): { readonly value: string; readonly next: number } => {
  const equals = arg.indexOf('=')
  if (equals >= 0) {
    const value = arg.slice(equals + 1)
    if (value === '') throw usageError(`${arg.slice(0, equals)} needs a value`)
    return { value, next: index + 1 }
  }
  const value = args[index + 1]
  if (value === undefined || value === '') throw usageError(`${arg} needs a value`)
  return { value, next: index + 2 }
}

const port = (raw: string): number => {
  const value = Number(raw)
  // 0 is the one exception and it is not a special case in the grammar: it is
  // how a caller asks the OS for a free port, which the tests rely on.
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw usageError(`--port takes a whole number from 0 to 65535, not "${raw}"`)
  }
  return value
}

export const parseArgv = (argv: readonly string[]): BoardCommand => {
  // argv[0] is node and argv[1] this script; like every CLI here, the words start at 2.
  const args = argv.slice(2)
  let socket: string | undefined
  let profile: string | undefined
  let host = DEFAULT_HOST
  let portNumber = DEFAULT_PORT
  let once = false

  for (let index = 0; index < args.length; ) {
    const arg = args[index] ?? ''
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    if (arg === '--once') {
      once = true
      index += 1
      continue
    }
    if (arg === '--socket' || arg.startsWith('--socket=')) {
      const read = valueOf(args, index, arg)
      socket = read.value
      index = read.next
      continue
    }
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      const read = valueOf(args, index, arg)
      profile = read.value
      index = read.next
      continue
    }
    if (arg === '--host' || arg.startsWith('--host=')) {
      const read = valueOf(args, index, arg)
      host = read.value
      index = read.next
      continue
    }
    if (arg === '--port' || arg.startsWith('--port=')) {
      const read = valueOf(args, index, arg)
      portNumber = port(read.value)
      index = read.next
      continue
    }
    throw usageError(arg.startsWith('-') ? `unknown option ${arg}` : `unexpected argument "${arg}"; fleet-board takes options only`)
  }

  if (socket !== undefined && profile !== undefined) {
    // Both name a fleet and the second would silently win; saying so is cheaper
    // than a person wondering which one they are looking at.
    throw usageError('--socket and --profile name the same fleet two ways; pass one')
  }

  const target: Target = {
    ...(socket === undefined ? {} : { socket }),
    ...(profile === undefined ? {} : { profile }),
  }
  return once ? { kind: 'once', ...target } : { kind: 'serve', host, port: portNumber, ...target }
}
