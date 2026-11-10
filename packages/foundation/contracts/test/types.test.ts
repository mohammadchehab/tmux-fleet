/**
 * The compile-time half of the contract suite.
 *
 * A schema and the interface it produces are two declarations of one shape, and
 * the whole point of `objectAs`/`unionAs` is that a disagreement between them
 * fails to compile. `node --test` cannot see any of that, so this file is
 * checked by `tsc --noEmit` (the `typecheck` task) — every `@ts-expect-error`
 * below is a claim that must stay false, and an unused one fails the build.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boolean, objectAs, parseStrict, positiveInt, text, unionAs, type Equal, type Schema } from '@fleet/foundation-core'
import type { Schema as CoreSchema } from '@fleet/foundation-core'
import { EVENT_SCHEMAS, type AppendEvent, type FleetEventType } from '../src/index.ts'
import type { BriefId, PeerId, Repo, Sha, WorkId } from '@fleet/foundation-core'

interface Widget {
  readonly id: string
  readonly flag: boolean
}

const widget: Schema<Widget> = objectAs<Widget>()({ id: text(10), flag: boolean() })

// A shape that lost a field is not the interface.
// @ts-expect-error `flag` is missing from the shape
const missingField: Schema<Widget> = objectAs<Widget>()({ id: text(10) })

// A shape that gained one is not the interface either: this is the drift plain
// assignability would wave through, because an extra optional field is fine there.
// @ts-expect-error the shape declares `extra`, the interface does not
const extraField: Schema<Widget> = objectAs<Widget>()({ id: text(10), flag: boolean(), extra: text(10) })

// Neither is a shape whose field types moved.
// @ts-expect-error `id` is a string in the interface, not a number
const wrongType: Schema<Widget> = objectAs<Widget>()({ id: positiveInt(), flag: boolean() })

// A union whose members do not add up to the interface.
// @ts-expect-error the union cannot produce `flag`
const shortUnion: Schema<Widget> = unionAs<Widget>()([objectAs<{ id: string }>()({ id: text(10) })])

// `readonly` is not a difference: an interface written with it and a shape
// written without it describe the same value, and demanding both spellings
// match would make every use of `objectAs` a cast again.
const readonlyDiffers: Equal<{ a: string }, { readonly a: string }> = true

/** The registry must produce exactly the union type the fleet is written against. */
type RegistryTypes = AppendEvent['type']
const allTypes: Equal<RegistryTypes, FleetEventType> = true

test('the checks above are erased and the schemas they produced still work', () => {
  assert.deepEqual(parseStrict(widget, { id: 'a', flag: true }), { id: 'a', flag: true })
  assert.throws(() => parseStrict(widget, { id: 'a', flag: true, extra: 1 }), /extra: unknown field/)
  void missingField
  void extraField
  void wrongType
  void shortUnion
  void readonlyDiffers
  void allTypes
})

/**
 * An append is the pre-seq event, and it stays a discriminated union: the
 * `type` and the `data` must agree. `Omit` over a union collapses to the keys
 * the variants share, which would accept a `work.assigned` envelope carrying
 * `work.merged`'s data — the `@ts-expect-error` below catches exactly that.
 */
const envelope = { ts: '2026-11-10T09:10:00.000Z', subject: 'wrk_7f3a91c2d84b0e56', actor: 'pm' } as const

// Branded ids are not literals; naming them here is how a fixture is written too.
const workId = 'wrk_7f3a91c2d84b0e56' as WorkId
const peerId = 'engineer-1' as PeerId
const briefId = 'brf_3c4d5e6f708192a3' as BriefId

const assigned: AppendEvent = {
  ...envelope,
  type: 'work.assigned',
  data: { workId, peerId, briefId, briefVersion: 1 },
}

const mergedData = { pr: { repo: 'backbase/me-services-fleet' as Repo, number: 42 }, headSha: 'abc1234' as Sha }

// @ts-expect-error a `work.assigned` append cannot carry a merged PR's data
const mismatched: AppendEvent = { ...envelope, type: 'work.assigned', data: mergedData }

// @ts-expect-error `seq` belongs to the store; a caller never supplies it
const withSeq: AppendEvent = { ...assigned, seq: 1 }

/** One event type's envelope, reached through the registry, keeps its own data. */
type AssignedEvent = (typeof EVENT_SCHEMAS)['work.assigned'] extends CoreSchema<infer T> ? T : never
const assignedType: Equal<AssignedEvent['type'], 'work.assigned'> = true

test('the append type keeps each variant, and seq is not part of it', () => {
  assert.equal(assigned.type, 'work.assigned')
  assert.equal(Object.hasOwn(assigned, 'seq'), false)
  void mismatched
  void withSeq
  void assignedType
})
