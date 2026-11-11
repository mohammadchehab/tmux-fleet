/**
 * The connection the tree draws (§7, §9): one poll at a time, and the four
 * things a window can be looking at.
 *
 * There is no long-lived socket here, because there is nothing to follow yet:
 * `peer.watch` is the watch-and-attach batch, and until it lands `ls` is the
 * whole of the fleet's public state. So this polls — `ls` is one request, one
 * answer, no state held (`client.ts`), and a window that polls it every few
 * seconds is as live as the daemon is. When `peer.watch` lands, the *only* file
 * that changes is the one below this comment: the tree, the rows and the actions
 * already take a snapshot.
 *
 * The states are deliberately separate rather than one "error":
 *
 * - `no-fleet` is "nothing is running here", which is a normal state with a
 *   Start button, not a failure;
 * - `disconnected` is "there was a fleet, and now there is not", which keeps the
 *   last rows greyed out so a window that lost the daemon does not look like a
 *   window that has an empty fleet;
 * - `choose` is the one question §7 asks, asked once and saved.
 */

import type { DaemonStatus, LsResult } from '@fleet/foundation-contracts'

import type { Discovery } from './discovery.ts'
import { rowsOf, type FleetRows } from './rows.ts'

/**
 * The protocol this build of the extension speaks (§8).
 *
 * It is a constant, not a read: the extension's contract is the one it was
 * bundled with. The daemon's copy arrives as `status.protocolVersion` with
 * `peer.watch`; until then the check is skipped rather than failed, because
 * "the daemon said nothing" is not "the daemon is old".
 */
export const PROTOCOL_VERSION = 1

/** How often a window asks again (§7: "every few seconds"). */
export const POLL_MS = 3_000

export type FleetState =
  | { readonly phase: 'starting' }
  | { readonly phase: 'choose'; readonly profiles: readonly string[] }
  | { readonly phase: 'no-fleet' }
  | {
      readonly phase: 'connected'
      readonly socketPath: string
      readonly profile: string
      readonly rows: FleetRows
      readonly status: DaemonStatus
    }
  | {
      readonly phase: 'disconnected'
      readonly socketPath: string
      /** The last rows, kept so the tree can grey them out rather than empty itself. */
      readonly rows: FleetRows | undefined
      readonly reason: string
    }
  | { readonly phase: 'version-mismatch'; readonly socketPath: string; readonly daemonVersion: number }

export interface ConnectionDeps {
  /** Settings, the environment and the profile scan, resolved to one answer (`discovery.ts`, `profiles.ts`). */
  readonly discover: () => Promise<Discovery>
  /** One `ls` over the socket. */
  readonly list: (socketPath: string) => Promise<LsResult>
  readonly onState: (state: FleetState) => void
  readonly pollMs?: number
}

const EMPTY: FleetRows = { needsYou: [], peers: [] }

/** The daemon's own protocol number, when it sends one (§8). */
const protocolVersionOf = (status: DaemonStatus): number | undefined => {
  const raw = status as DaemonStatus & { readonly protocolVersion?: unknown }
  return typeof raw.protocolVersion === 'number' ? raw.protocolVersion : undefined
}

export class FleetConnection {
  readonly deps: ConnectionDeps
  private state: FleetState = { phase: 'starting' }
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  private socketPath: string | undefined

  constructor(deps: ConnectionDeps) {
    this.deps = deps
  }

  current(): FleetState {
    return this.state
  }

  /** The socket the last poll used, which `reconnect` and the actions reuse. */
  socket(): string | undefined {
    return this.socketPath
  }

  /**
   * One poll. Never rejects: a poll that throws is a poll that found the daemon
   * gone, which is a state, not an exception for the caller to handle.
   */
  async poll(): Promise<FleetState> {
    const discovery = await this.deps.discover()

    if (discovery.kind === 'none') {
      this.socketPath = undefined
      return this.setState({ phase: 'no-fleet' })
    }
    if (discovery.kind === 'choose') {
      this.socketPath = undefined
      return this.setState({ phase: 'choose', profiles: discovery.profiles })
    }

    const socketPath = discovery.socketPath
    this.socketPath = socketPath

    try {
      const ls = await this.deps.list(socketPath)
      const daemonVersion = protocolVersionOf(ls.status)
      if (daemonVersion !== undefined && daemonVersion !== PROTOCOL_VERSION) {
        return this.setState({ phase: 'version-mismatch', socketPath, daemonVersion })
      }
      return this.setState({
        phase: 'connected',
        socketPath,
        profile: ls.status.profile,
        rows: rowsOf(ls),
        status: ls.status,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const rows = this.state.phase === 'connected' ? this.state.rows : this.previousRows()
      return this.setState({ phase: 'disconnected', socketPath, rows, reason })
    }
  }

  /** The last rows we had, so a reconnect after a drop still shows something (§7). */
  private previousRows(): FleetRows | undefined {
    if (this.state.phase === 'disconnected') return this.state.rows
    return undefined
  }

  private setState(state: FleetState): FleetState {
    this.state = state
    this.deps.onState(state)
    return state
  }

  /** Begin polling. The first poll runs immediately so the tree is not empty for three seconds. */
  start(): void {
    if (this.running) return
    this.running = true
    void this.poll()
    this.timer = setInterval(() => {
      void this.poll()
    }, this.deps.pollMs ?? POLL_MS)
    // A poll must not keep a window alive on its own.
    this.timer.unref?.()
  }

  stop(): void {
    this.running = false
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Poll now, outside the interval — after an answer was saved, or a terminal closed. */
  refresh(): void {
    void this.poll()
  }
}

export { EMPTY as EMPTY_ROWS }
