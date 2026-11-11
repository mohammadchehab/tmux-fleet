/**
 * `peer.watch` on the wire (watch-and-attach §6): the daemon's one streaming
 * method, and the shapes every client of it reads. `fleet watch` and the editor
 * extension are both built on these, so the frame is spelled once, here.
 *
 * A watch is one connection that never carries a second request. The client sends
 * one line, `{ id, method: 'peer.watch', params }`; the daemon answers with frames,
 * each one line of JSON carrying the same `id` and a `stream` kind:
 *
 * - `line`  — what a peer said or did, one `DisplayLine` (display data, not stored).
 * - `row`   — a fact from the store the view needs: a state change, mail, a decision.
 * - `ready` — the buffered history has been sent; everything after is live.
 * - `end`   — the last frame; the daemon then closes the connection.
 *
 * A request that cannot start (bad params) is answered as any request is, with a
 * single `{ id, ok: false, error }` line and no stream.
 *
 * Every `line` and `row` carries `seq`, one counter for the whole daemon run, so a
 * client that reconnects sends `since` and gets only what it missed — and when the
 * ring has already dropped some of it, `ready.from` says where the history begins.
 */

import {
  count,
  decisionId,
  literal,
  messageId,
  objectAs,
  oneOf,
  optional,
  peerId,
  peerState,
  string,
  unionAs,
  type DecisionId,
  type MessageId,
  type PeerId,
  type PeerState,
  type Schema,
} from '@fleet/foundation-core'
import { displayLine, type DisplayLine } from './provider.ts'

/**
 * The version of this wire protocol, as `DaemonStatus.protocolVersion` reports it.
 * Bumped whenever a stream frame or an RPC changes shape, so a client that reads
 * it on connect knows whether it can speak to this daemon.
 */
export const daemonProtocolVersion = 1

export interface WatchParams {
  /** One peer's lines (the rows still say what the fleet did); absent: every peer. */
  readonly peerId?: PeerId
  /** The last `seq` the client has seen: only later frames are sent. Absent: the whole buffer. */
  readonly since?: number
}

export const watchParams = (): Schema<WatchParams> =>
  objectAs<WatchParams>()({ peerId: optional(peerId()), since: optional(count()) })

/** A fact from the store, cut down to what a view shows. */
export type WatchRow =
  | { readonly kind: 'state'; readonly peerId: PeerId; readonly state: PeerState }
  | { readonly kind: 'mail'; readonly phase: 'sent' | 'delivered'; readonly msgId: MessageId; readonly to: PeerId; readonly from?: string }
  | { readonly kind: 'decision'; readonly phase: 'requested' | 'answered'; readonly decisionId: DecisionId; readonly question?: string }

export const watchRow = (): Schema<WatchRow> =>
  unionAs<WatchRow>()([
    objectAs<Extract<WatchRow, { kind: 'state' }>>()({ kind: literal('state'), peerId: peerId(), state: peerState() }),
    objectAs<Extract<WatchRow, { kind: 'mail' }>>()({
      kind: literal('mail'),
      phase: oneOf(['sent', 'delivered'] as const),
      msgId: messageId(),
      to: peerId(),
      from: optional(string({ maxLength: 80 })),
    }),
    objectAs<Extract<WatchRow, { kind: 'decision' }>>()({
      kind: literal('decision'),
      phase: oneOf(['requested', 'answered'] as const),
      decisionId: decisionId(),
      question: optional(string({ maxLength: 500 })),
    }),
  ])

export const watchEndReasons = [
  /** The client asked to stop, or went away. */
  'closed',
  /** The client could not keep up and was dropped; it may reconnect with `since`. */
  'dropped',
  /** The daemon is going down. */
  'shutdown',
] as const
export type WatchEndReason = (typeof watchEndReasons)[number]

export type WatchFrame =
  | { readonly id?: string; readonly stream: 'line'; readonly seq: number; readonly at: string; readonly peerId: PeerId; readonly line: DisplayLine }
  | { readonly id?: string; readonly stream: 'row'; readonly seq: number; readonly at: string; readonly row: WatchRow }
  /** The history is sent. `seq` is the newest the daemon has; `from` the oldest it still holds. */
  | { readonly id?: string; readonly stream: 'ready'; readonly seq: number; readonly from: number; readonly protocolVersion: number }
  | { readonly id?: string; readonly stream: 'end'; readonly reason: WatchEndReason }

const idField = () => optional(string({ minLength: 1, maxLength: 64 }))

export const watchFrame = (): Schema<WatchFrame> =>
  unionAs<WatchFrame>()([
    objectAs<Extract<WatchFrame, { stream: 'line' }>>()({
      id: idField(),
      stream: literal('line'),
      seq: count(),
      at: string({ minLength: 1, maxLength: 40 }),
      peerId: peerId(),
      line: displayLine(),
    }),
    objectAs<Extract<WatchFrame, { stream: 'row' }>>()({
      id: idField(),
      stream: literal('row'),
      seq: count(),
      at: string({ minLength: 1, maxLength: 40 }),
      row: watchRow(),
    }),
    objectAs<Extract<WatchFrame, { stream: 'ready' }>>()({
      id: idField(),
      stream: literal('ready'),
      seq: count(),
      from: count(),
      protocolVersion: count(),
    }),
    objectAs<Extract<WatchFrame, { stream: 'end' }>>()({ id: idField(), stream: literal('end'), reason: oneOf(watchEndReasons) }),
  ])

export type { DisplayLine }
