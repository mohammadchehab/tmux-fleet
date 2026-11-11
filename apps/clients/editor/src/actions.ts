/**
 * What may be done to a peer, and what doing it runs (§4, §6).
 *
 * The table is the watch's table, and it is keyed on a peer's *standing* rather
 * than on its state, because that is what the person decides against: a working
 * peer and a waiting one are both running, and both take over the same way.
 *
 * `held` and `stopped` are the states watch-and-attach adds to `ls` (§4, §7.2):
 * a person has the session, or a person stopped it. `ended` and `failed` stay
 * in the table beside them, because a peer that died on its own is offered the
 * same `start` as one a person stopped.
 *
 * Two kinds of action, and the difference is deliberate:
 *
 * - **A takeover is a terminal**, exactly as §6 says: `fleet attach <peer>` in
 *   an integrated terminal named `fleet: <peer>`, which holds the peer, runs
 *   the native CLI and releases. The extension adds nothing to that path, so a
 *   takeover here and a takeover in a shell are the same thing.
 * - **Stop and start are one-shot**, so they are not a terminal to close:
 *   they run, and the outcome is a notification. A terminal per `fleet stop`
 *   would leave a tab that says one line and exits.
 */

import type { SendParams } from '@fleet/foundation-contracts'
import type { PeerId, PeerState } from '@fleet/foundation-core'

export type PeerStanding = 'running' | 'held' | 'stopped'

export type PeerAction = 'takeover' | 'takeover-now' | 'send' | 'stop' | 'reopen' | 'release' | 'start'

export const standingOf = (state: PeerState): PeerStanding => {
  switch (state) {
    case 'starting':
    case 'working':
    case 'waiting_input':
    case 'idle':
      return 'running'
    case 'held':
      return 'held'
    case 'stopped':
      return 'stopped'
    case 'ended':
    case 'failed':
      // A peer that died on its own is as free to start again as one a person stopped.
      return 'stopped'
  }
}

/**
 * §4's table, with one entry missing on purpose: *Interrupt* needs a `fleet
 * interrupt`, which neither main nor feat/watch-attach has. It comes back with
 * the command, not before, so nobody is offered an action that fails.
 */
export const actionsFor = (standing: PeerStanding): readonly PeerAction[] => {
  switch (standing) {
    case 'running':
      return ['takeover', 'takeover-now', 'send', 'stop']
    case 'held':
      return ['reopen', 'release']
    case 'stopped':
      return ['start']
  }
}

export const actionTitle = (action: PeerAction): string => {
  switch (action) {
    case 'takeover':
      return 'Take over when the turn ends'
    case 'takeover-now':
      return 'Take over now'
    case 'send':
      return 'Send a message'
    case 'stop':
      return 'Stop'
    case 'reopen':
      return 'Reopen the native session'
    case 'release':
      return 'Release'
    case 'start':
      return 'Start'
  }
}

export interface TerminalCommand {
  /** The terminal's name, `fleet: <peer>` (§6). */
  readonly name: string
  readonly argv: readonly string[]
}

/** The actions that are a terminal, and the ones that are not. Exported so the editor layer cannot drift. */
export const terminalActions: readonly PeerAction[] = ['takeover', 'takeover-now', 'reopen', 'release']
export const oneShotActions: readonly PeerAction[] = ['stop', 'start']

/**
 * The command line for an action, or `undefined` for the one that is not a
 * command at all (`send` opens an input box and calls the daemon).
 *
 * `cli` is what runs the fleet: `fleet` on a normal install, and anything else
 * (`node /path/to/apps/clients/cli/src/main.ts`) in a checkout, which is why it
 * is an argument and a setting rather than a constant.
 */
export const commandFor = (cli: string, action: PeerAction, peerId: string): TerminalCommand | undefined => {
  switch (action) {
    case 'takeover':
      return { name: `fleet: ${peerId}`, argv: [cli, 'attach', peerId] }
    case 'takeover-now':
      return { name: `fleet: ${peerId}`, argv: [cli, 'attach', peerId, '--now'] }
    case 'reopen':
      return { name: `fleet: ${peerId}`, argv: [cli, 'attach', peerId] }
    case 'release':
      return { name: `fleet: ${peerId}`, argv: [cli, 'release', peerId] }
    case 'stop':
      return { name: `fleet: ${peerId}`, argv: [cli, 'stop', peerId] }
    case 'start':
      return { name: `fleet: ${peerId}`, argv: [cli, 'start', peerId] }
    case 'send':
      return undefined
  }
}

/**
 * The `send` a message turns into (§4). The kind is `nudge`: `brief` is the
 * opening handoff, `answer` replies to a question and `info` is context, so a
 * person typing "look at TASK-4" at a peer that is already running is exactly a
 * nudge. `fleet send <peer> <kind> <body>` asks for the kind because a script
 * may mean any of them; this window is one person and one meaning.
 */
export const sendParamsFor = (peerId: string, body: string): SendParams => ({
  to: peerId as PeerId,
  kind: 'nudge',
  body,
})
