/**
 * The one vocabulary for what a peer is doing (architecture §4, §13). It is
 * what `Provider.status` returns and what the peer projection stores, so the
 * board, the PM and a notification all agree without scraping a pane.
 *
 * `waiting_input` replaces v1's regex-on-`?` guess: a provider says its model
 * asked a question as an event, never as text to parse (§4).
 */

import { oneOf, type Schema } from './schema.ts'

/**
 * `held` and `stopped` are a peer deliberately not running (watch-and-attach §4,
 * §7.2): a person has its session, or a person stopped it. Neither is live,
 * terminal or assignable; only a release or a start ends them.
 */
export const peerStates = ['starting', 'working', 'waiting_input', 'idle', 'ended', 'failed', 'held', 'stopped'] as const

export type PeerState = (typeof peerStates)[number]

export const peerState = (): Schema<PeerState> => oneOf(peerStates)

/** A session exists and can be sent a turn. */
export const isLive = (state: PeerState): boolean =>
  state === 'starting' || state === 'working' || state === 'waiting_input' || state === 'idle'

/** Nothing more will happen without a new `start` (or a `resume`). */
export const isTerminal = (state: PeerState): boolean => state === 'ended' || state === 'failed'

/** Deliberately not running: a person holds it or stopped it (watch-and-attach §4, §7.2). */
export const isParked = (state: PeerState): boolean => state === 'held' || state === 'stopped'

/** Free to be given work: idle, and only idle (§5.2 `assign`, `keep-busy`). */
export const isAssignable = (state: PeerState): boolean => state === 'idle'

/** Blocked on a human or another peer; the PM's `unblock` rule fires here (§5.2). */
export const needsAttention = (state: PeerState): boolean => state === 'waiting_input' || state === 'failed'
