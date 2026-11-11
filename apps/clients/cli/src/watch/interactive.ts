/**
 * `fleet watch` the terminal program (watch-and-attach §7): raw keys in, a
 * painted screen out, and a `peer.watch` stream feeding the model.
 *
 * Everything that decides anything is in `model.ts` and `render.ts`; this file
 * only moves bytes. Streams, clock and the daemon are arguments so the loop is a
 * test with no terminal in it.
 *
 * Taking a peer over suspends the watch: the screen is given back, the keys are
 * released, `attachPeer` runs the provider's CLI in this terminal, and the watch
 * paints itself again when that returns — the stream kept running meanwhile, so
 * the timeline it comes back to is current.
 */

import type { Readable, Writable } from 'node:stream'

import { toFleetError } from '@fleet/foundation-core'
import type { LsResult } from '@fleet/foundation-contracts'

import type { DaemonCaller } from '../client.ts'
import { attachPeer } from '../run.ts'
import { TERMINAL_RESET, type Takeover } from '../takeover.ts'
import { createKeyParser } from './keys.ts'
import { initialState, reduce, type Action, type Effect, type Input, type WatchState } from './model.ts'
import { render } from './render.ts'
import { openWatch as defaultOpenWatch, type OpenWatch, type WatchHandle } from './stream.ts'

export interface InteractiveDeps {
  readonly socketPath: string
  readonly call: DaemonCaller
  readonly takeover: Takeover | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdin: Readable & { readonly isTTY?: boolean; setRawMode?: (mode: boolean) => unknown }
  readonly stdout: Writable & { readonly columns?: number; readonly rows?: number }
  readonly openWatch?: OpenWatch
  readonly now?: () => number
  /** Minutes east of UTC; `-new Date().getTimezoneOffset()` by default. */
  readonly offsetMinutes?: number
  /** How long to wait before reopening a lost stream, and between slow `ls` refreshes. */
  readonly reconnectMs?: number
  readonly refreshMs?: number
}

const ENTER_SCREEN = '\u001b[?1049h\u001b[?25l'
const LEAVE_SCREEN = '\u001b[?25h\u001b[?1049l'

const painted = (lines: readonly string[]): string => `\u001b[H${lines.map((line) => `${line}\u001b[K`).join('\r\n')}\u001b[J`

export const runWatch = async (deps: InteractiveDeps): Promise<void> => {
  const { stdin, stdout, call } = deps
  const now = deps.now ?? Date.now
  const open = deps.openWatch ?? defaultOpenWatch
  const size = (): { cols: number; rows: number } => ({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
  let state: WatchState = initialState(size(), deps.offsetMinutes ?? -new Date().getTimezoneOffset())
  let suspended = false
  let finished = false
  let stream: WatchHandle | undefined
  let refreshing = false
  let refreshAgain = false
  const timers = new Set<NodeJS.Timeout>()
  const later = (ms: number, fn: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
  }

  let resolveDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const paint = (): void => {
    if (suspended || finished) return
    stdout.write(painted(render(state, now())))
  }

  const refresh = async (): Promise<void> => {
    if (refreshing) {
      refreshAgain = true
      return
    }
    refreshing = true
    try {
      const ls: LsResult = await call('ls', {})
      dispatch({ type: 'snapshot', ls })
    } catch (thrown) {
      dispatch({ type: 'notice', text: `ls failed: ${toFleetError(thrown).message}` })
    } finally {
      refreshing = false
      if (refreshAgain) {
        refreshAgain = false
        later(100, () => void refresh())
      }
    }
  }

  const connect = (): void => {
    if (finished) return
    dispatch({ type: 'link', link: 'connecting' })
    stream = open({
      socketPath: deps.socketPath,
      ...(state.lastSeq > 0 ? { since: state.lastSeq } : {}),
      onFrame: (frame) => dispatch({ type: 'frame', frame }),
      onClose: () => {
        stream = undefined
        if (finished) return
        dispatch({ type: 'link', link: 'lost' })
        later(deps.reconnectMs ?? 1000, connect)
      },
    })
  }

  const act = async (action: Action): Promise<void> => {
    try {
      switch (action.kind) {
        case 'attach': {
          if (deps.takeover === undefined) {
            dispatch({ type: 'notice', text: 'this build cannot hand a terminal over' })
            return
          }
          suspended = true
          stdin.setRawMode?.(false)
          stdin.pause()
          stdout.write(`${LEAVE_SCREEN}${TERMINAL_RESET}`)
          try {
            await attachPeer(call, deps.takeover, deps.env, action.peer, action.now, (line) => {
              stdout.write(`${line}\n`)
            })
            state = { ...state, notice: `${action.peer} handed back` }
          } finally {
            stdout.write(ENTER_SCREEN)
            stdin.setRawMode?.(true)
            stdin.resume()
            suspended = false
            // Whatever happened while the screen was given away, paint what is true now.
            paint()
          }
          break
        }
        case 'interrupt': {
          const result = await call('peer.interrupt', { peerId: action.peer })
          dispatch({ type: 'notice', text: result.interrupted ? `interrupted ${action.peer}` : `${action.peer} was not mid-turn` })
          break
        }
        case 'release':
          await call('peer.release', { peerId: action.peer })
          dispatch({ type: 'notice', text: `handed ${action.peer} back` })
          break
        case 'stop':
          await call('peer.stop', { peerId: action.peer, ...(action.now ? { now: true } : {}) })
          dispatch({ type: 'notice', text: `stopped ${action.peer}` })
          break
        case 'start':
          await call('peer.start', { peerId: action.peer })
          dispatch({ type: 'notice', text: `started ${action.peer}` })
          break
        case 'compose':
        case 'compose-decision':
          break
        case 'decide': {
          await call('decide', { id: action.id, decision: action.option })
          dispatch({ type: 'notice', text: `decided: ${action.option}` })
          break
        }
      }
    } catch (thrown) {
      dispatch({ type: 'notice', text: toFleetError(thrown).message })
    }
    void refresh()
  }

  const run = (effect: Effect): void => {
    switch (effect.kind) {
      case 'quit':
        quit()
        break
      case 'refresh':
        void refresh()
        break
      case 'run':
        void act(effect.action)
        break
      case 'send':
        void (async () => {
          try {
            await call('send', { to: effect.peer, kind: 'info', body: effect.body })
            dispatch({ type: 'notice', text: `sent to ${effect.peer}` })
          } catch (thrown) {
            dispatch({ type: 'notice', text: toFleetError(thrown).message })
          }
        })()
        break
    }
  }

  function dispatch(input: Input): void {
    const step = reduce(state, input)
    state = step.state
    for (const effect of step.effects) run(effect)
    paint()
  }

  function quit(): void {
    if (finished) return
    finished = true
    for (const timer of timers) clearTimeout(timer)
    stream?.close()
    stdin.off('data', onData)
    stdout.off('resize', onResize)
    stdin.setRawMode?.(false)
    stdin.pause()
    stdout.write(`${LEAVE_SCREEN}${TERMINAL_RESET}`)
    resolveDone()
  }

  const parser = createKeyParser()
  let escapeTimer: NodeJS.Timeout | undefined
  const onData = (chunk: Buffer | string): void => {
    if (suspended) return
    if (escapeTimer !== undefined) clearTimeout(escapeTimer)
    for (const key of parser.feed(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)) dispatch({ type: 'key', key })
    // A lone ESC is the escape key only if nothing follows it straight away.
    if (parser.pending) {
      escapeTimer = setTimeout(() => {
        for (const key of parser.flush()) dispatch({ type: 'key', key })
      }, 30)
      escapeTimer.unref()
    }
  }
  const onResize = (): void => dispatch({ type: 'resize', ...size() })

  stdin.setRawMode?.(true)
  stdin.resume()
  stdin.on('data', onData)
  stdout.on('resize', onResize)
  stdout.write(ENTER_SCREEN)
  paint()
  connect()
  void refresh()
  const slow = (): void => {
    if (finished) return
    void refresh()
    later(deps.refreshMs ?? 5000, slow)
  }
  later(deps.refreshMs ?? 5000, slow)

  await done
}
