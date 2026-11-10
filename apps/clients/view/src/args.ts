/**
 * `fleet-view`'s argument grammar (§2): words in, one of a closed set of
 * commands out, `invalid_input` for anything else.
 *
 * The grammar is two shapes, not four. `--once` prints what the view shows and
 * exits; without it the same command runs live — a tmux grid of panes, or, with
 * `--pane`, the single pane the grid would have run. That is one rule ("show
 * this, once or continuously") rather than a flag per mode, and it is what makes
 * `--once --pane engineer-1` a test of the exact renderer a pane uses.
 *
 * Nothing here touches `process` or a socket, so every branch below is a test.
 */

import { fleetError, parseStrict, peerId, SchemaError, type PeerId } from '@fleet/foundation-core'

export const MIN_INTERVAL_MS = 100
export const DEFAULT_INTERVAL_MS = 2_000

export interface Target {
  /** `--socket`, verbatim. */
  readonly socket?: string
  /** `--profile`, or `FLEET_PROFILE` when this is absent. */
  readonly profile?: string
  /** `--pane`: the one peer to render. Absent means the whole fleet. */
  readonly peer?: PeerId
}

export type ViewCommand =
  /** Print once and exit. */
  | ({ readonly kind: 'once' } & Target)
  /** Redraw on an interval until interrupted; `peer` absent means the tmux grid. */
  | ({ readonly kind: 'live'; readonly intervalMs: number } & Target)
  | { readonly kind: 'help' }

export const usage = (): string =>
  [
    'fleet-view: a read-only view of the fleet, one pane per peer',
    '',
    'usage: fleet-view [--profile <name> | --socket <path>] [--interval <ms>] [--once] [--pane <peer>]',
    '',
    '  --profile <name>   the fleet to look at; defaults to FLEET_PROFILE',
    '  --socket <path>    talk to this daemon socket instead; defaults to FLEET_SOCKET',
    '  --interval <ms>    how often a pane redraws (default 2000, minimum 100)',
    '  --once             print what the view shows and exit, with no tmux needed',
    '  --pane <peer>      watch one peer, the way one pane of the grid does',
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

const interval = (raw: string): number => {
  const value = Number(raw)
  // A view that redraws faster than a person can read would cost one request per
  // peer per tick for nothing, so the floor is a floor and not a suggestion.
  if (!Number.isInteger(value) || value < MIN_INTERVAL_MS) {
    throw usageError(`--interval takes whole milliseconds, ${String(MIN_INTERVAL_MS)} or more, not "${raw}"`)
  }
  return value
}

const decodePeer = (raw: string): PeerId => {
  try {
    return parseStrict(peerId(), raw)
  } catch (thrown) {
    if (thrown instanceof SchemaError) {
      throw usageError(`--pane: ${thrown.message.replace(/^<root>: /, '')}`)
    }
    throw thrown
  }
}

export const parseArgv = (argv: readonly string[]): ViewCommand => {
  // argv[0] is node and argv[1] this script; like every CLI here, the words start at 2.
  const args = argv.slice(2)
  let socket: string | undefined
  let profile: string | undefined
  let intervalMs = DEFAULT_INTERVAL_MS
  let once = false
  let peer: PeerId | undefined

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
    if (arg === '--interval' || arg.startsWith('--interval=')) {
      const read = valueOf(args, index, arg)
      intervalMs = interval(read.value)
      index = read.next
      continue
    }
    if (arg === '--pane' || arg.startsWith('--pane=')) {
      const read = valueOf(args, index, arg)
      peer = decodePeer(read.value)
      index = read.next
      continue
    }
    throw usageError(arg.startsWith('-') ? `unknown option ${arg}` : `unexpected argument "${arg}"; fleet-view takes options only`)
  }

  if (socket !== undefined && profile !== undefined) {
    // Both name a fleet and the second would silently win; saying so is cheaper
    // than a person wondering which one they are looking at.
    throw usageError('--socket and --profile name the same fleet two ways; pass one')
  }

  const target: Target = {
    ...(socket === undefined ? {} : { socket }),
    ...(profile === undefined ? {} : { profile }),
    ...(peer === undefined ? {} : { peer }),
  }
  return once ? { kind: 'once', ...target } : { kind: 'live', intervalMs, ...target }
}
