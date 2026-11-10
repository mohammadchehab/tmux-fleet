/**
 * The event envelope (architecture §3): `{seq, ts, type, subject, actor,
 * causedBy, data}`. Everything that happens is one of these; every table the
 * code reads is a projection of them. `data` is the only per-type part, so
 * this file owns the envelope and `@fleet/foundation-contracts` owns the
 * registry of `type` → `data` schema.
 */

import { array, literal, number, object, oneOf, optional, refine, type Infer, type Schema, string } from './schema.ts'

/** Position in the store's total order. Assigned by `append`, never by a caller. */
export type Seq = number

/** An ISO 8601 instant, UTC, e.g. `2026-11-10T09:00:00.000Z`. */
export type Timestamp = string

export const seq = (): Schema<Seq> => number({ int: true, min: 1 })

export const timestamp = (): Schema<Timestamp> =>
  refine(string({ minLength: 20, maxLength: 30 }), (v) => !Number.isNaN(Date.parse(v)), 'an ISO 8601 timestamp')

/**
 * Who caused the event. `judge:<model>` records the model a typed answer came
 * from, so a replay can prove the answer was not re-asked (§5.4).
 */
export type Actor = 'pm' | 'scheduler' | 'user' | `peer:${string}` | `judge:${string}`

export const actor = (): Schema<Actor> =>
  refine(
    string({ pattern: /^(?:pm|scheduler|user|peer:[a-z0-9-]+|judge:[A-Za-z0-9._:/-]+)$/ }),
    (value) => {
      if (!value.startsWith('peer:')) return true
      // A peer actor must name a real peer id shape, not a session ref (§7).
      const name = value.slice('peer:'.length)
      return name.length <= 40 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)
    },
    'an actor (pm | scheduler | user | peer:<id> | judge:<model>)',
  ) as Schema<Actor>

export interface EventEnvelope<T> {
  /** Assigned by the store on append. */
  readonly seq: Seq
  readonly ts: Timestamp
  /** Dotted `<entity>.<verb>`, e.g. `work.assigned`. The registry keys on it. */
  readonly type: string
  /** The id of the entity the event is about; for peer-scoped events, the peerId. */
  readonly subject: string
  readonly actor: Actor
  /** The seqs this event was caused by, so a decision can be audited backwards. */
  readonly causedBy?: readonly Seq[]
  readonly data: T
}

/** An event before it has a place in the store. What a producer appends. */
export type NewEvent<T> = Omit<EventEnvelope<T>, 'seq'>

/**
 * `Omit` that distributes over a union, so stripping `seq` from a
 * discriminated event union keeps every variant's `data` instead of collapsing
 * to the fields the variants share.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** The envelope around any `data` schema, with `type` left open. */
export const envelope = <D extends Schema<unknown>>(
  data: D,
): Schema<EventEnvelope<Infer<D>>> =>
  object({
    seq: seq(),
    ts: timestamp(),
    type: string({ pattern: /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/ }),
    subject: string({ minLength: 1, maxLength: 200 }),
    actor: actor(),
    causedBy: optional(array(seq())),
    data,
  }) as Schema<EventEnvelope<Infer<D>>>

/**
 * An event schema for one concrete `type`. The registry is a map of these, and
 * `Infer` on the union of them is the fleet's discriminated event union.
 */
export const event = <const T extends string, D extends Schema<unknown>>(
  type: T,
  data: D,
): Schema<EventEnvelope<Infer<D>> & { readonly type: T }> =>
  object({
    seq: seq(),
    ts: timestamp(),
    type: literal(type),
    subject: string({ minLength: 1, maxLength: 200 }),
    actor: actor(),
    causedBy: optional(array(seq())),
    data,
  }) as unknown as Schema<EventEnvelope<Infer<D>> & { readonly type: T }>

/**
 * The list of actors a peer's own events may carry. The supervisor is the only
 * writer of peer events and always knows which peer it writes for.
 */
export const peerActor = (id: string): Actor => `peer:${id}` as Actor
export const judgeActor = (model: string): Actor => `judge:${model}` as Actor

export const actorKinds = ['pm', 'scheduler', 'user', 'peer', 'judge'] as const
export type ActorKind = (typeof actorKinds)[number]
export const actorKindSchema: Schema<ActorKind> = oneOf(actorKinds)

export const actorKindOf = (a: Actor): ActorKind => {
  if (a === 'pm' || a === 'scheduler' || a === 'user') return a
  return a.startsWith('peer:') ? 'peer' : 'judge'
}

/** The peer a peer-actor event is from, or `undefined` for every other actor. */
export const peerOf = (a: Actor): string | undefined =>
  a.startsWith('peer:') ? a.slice('peer:'.length) : undefined
