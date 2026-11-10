/**
 * The engagement key (shared-fleet.md §5): one random key per engagement, a
 * copy sealed to each member's GitHub SSH keys, and a new key whenever the
 * membership changes.
 *
 * A key lives in a rotation ref, `<ns>/rotate/<n>`, which is created once and
 * never edited: its files are the rotation record and one `<login>.age` copy per
 * member. The highest `n` is the current key. Any change in the team — someone
 * joined, someone left, a member with no usable SSH key added one — is a new
 * rotation for the team as it now stands, so:
 *
 * - a leaver's copy is not deleted, it is superseded: the new key is sealed to
 *   the remaining members only, and the leaver has already lost the repository;
 * - a newcomer gets a key made after they joined, never one that was in use
 *   before they were on the engagement;
 * - two fleets that see the same change race to create the same `<n>`, and the
 *   forge picks one (§2.1); the loser's key was never published.
 *
 * Nothing here holds the key past sealing it. In phase 1 (`taskData: false`) no
 * fleet needs to open its copy — there is no task data to encrypt — so the key is
 * generated, sealed and dropped. The first fleet up in an engagement makes
 * rotation 1; nobody runs an `init`.
 *
 * A rotation the team did not ask for is the failure to avoid, so this refuses
 * rather than rotates when the team reads as empty or this fleet's own user is
 * not on it: either is a token that cannot see the team, not a team that changed.
 */

import { randomBytes } from 'node:crypto'
import { decodeStrict, type Clock } from '@fleet/foundation-core'
import {
  keyRotation,
  ROTATION_FILE,
  type Coordination,
  type CoordinationRef,
  type KeyRotation,
  type KeyWrap,
  type TeamDirectory,
} from '@fleet/foundation-contracts'

export interface KeyReconcileOptions {
  readonly coordination: Coordination
  readonly directory: TeamDirectory
  readonly wrap: KeyWrap
  /** The engagement code name: `eng-07`. */
  readonly namespace: string
  /** `<org>/<slug>`: the engagement's GitHub team. */
  readonly team: string
  /** This fleet's own login. */
  readonly self: string
  readonly clock: Clock
  /** A fresh key, encoded as text. Defaults to 32 random bytes, base64. */
  readonly newKey?: () => string
}

export type KeyOutcome =
  /** The current rotation is sealed for the team as it stands. */
  | { readonly kind: 'current'; readonly rotation: number }
  /** This fleet made rotation `n`. */
  | { readonly kind: 'rotated'; readonly rotation: number; readonly members: readonly string[]; readonly missing: readonly string[] }
  /** Another fleet made rotation `n` first; the next look reads it. */
  | { readonly kind: 'lost_race'; readonly rotation: number }
  /** Nothing was rotated, and why. */
  | { readonly kind: 'refused'; readonly reason: string }

const ROTATION_NUMBER = /^[1-9][0-9]{0,8}$/

/** The rotations under `<ns>/rotate/`, highest first. A ref that is not one is ignored. */
const rotationsOf = (refs: readonly CoordinationRef[], prefix: string): { readonly n: number; readonly ref: CoordinationRef }[] =>
  refs
    .map((ref) => ({ ref, tail: ref.name.slice(prefix.length) }))
    .filter(({ tail }) => ROTATION_NUMBER.test(tail))
    .map(({ ref, tail }) => ({ n: Number(tail), ref }))
    .sort((a, b) => b.n - a.n)

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i])

export const reconcileKey = async (options: KeyReconcileOptions): Promise<KeyOutcome> => {
  const members = await options.directory.members(options.team)
  if (members.length === 0) {
    return { kind: 'refused', reason: `${options.team} reads as empty; a key sealed to nobody would lock every member out` }
  }
  if (!members.includes(options.self)) {
    return { kind: 'refused', reason: `${options.self} is not on ${options.team}, so this fleet does not decide its key` }
  }

  const prefix = `${options.namespace}/rotate/`
  const [current] = rotationsOf(await options.coordination.refs(prefix), prefix)

  /** Each member's usable recipients, read once per look. */
  const recipients = new Map<string, readonly string[]>()
  const recipientsOf = async (member: string): Promise<readonly string[]> => {
    const known = recipients.get(member)
    if (known !== undefined) return known
    const usable = (await options.directory.sshKeys(member))
      .map((key) => options.wrap.recipient(key))
      .filter((recipient): recipient is string => recipient !== undefined)
    recipients.set(member, usable)
    return usable
  }

  if (current !== undefined) {
    const record = await readRecord(options.coordination, current.ref)
    if (record !== undefined && sameList(record.members, members)) {
      // The same team; the only other change is a member who had no key adding one.
      let gained = false
      for (const member of record.missing) if ((await recipientsOf(member)).length > 0) gained = true
      if (!gained) return { kind: 'current', rotation: current.n }
    }
  }

  const rotation = (current?.n ?? 0) + 1
  const key = (options.newKey ?? (() => randomBytes(32).toString('base64')))()
  const files: Record<string, string> = {}
  const missing: string[] = []
  for (const member of members) {
    const usable = await recipientsOf(member)
    if (usable.length === 0) {
      missing.push(member)
      continue
    }
    files[`${member}.age`] = await options.wrap.wrap(key, usable)
  }
  if (missing.length === members.length) {
    return { kind: 'refused', reason: `no member of ${options.team} has an ssh-ed25519 or ssh-rsa key on GitHub` }
  }

  const record: KeyRotation = { version: 1, rotation, members, missing, by: options.self, at: options.clock.now() }
  files[ROTATION_FILE] = `${JSON.stringify(record, null, 2)}\n`
  const created = await options.coordination.create({
    ref: `${prefix}${rotation}`,
    files,
    message: `rotation ${rotation}: ${members.length} member(s)${missing.length > 0 ? `, ${missing.length} without a key` : ''}`,
  })
  return created.created ? { kind: 'rotated', rotation, members, missing } : { kind: 'lost_race', rotation }
}

/** A rotation's record, or `undefined` for one that is gone or does not decode — which then reads as stale. */
const readRecord = async (coordination: Coordination, ref: CoordinationRef): Promise<KeyRotation | undefined> => {
  const held = await coordination.read(ref)
  const text = held?.files[ROTATION_FILE]
  if (text === undefined) return undefined
  try {
    const decoded = decodeStrict(keyRotation(), JSON.parse(text))
    return decoded.ok ? decoded.value : undefined
  } catch {
    return undefined
  }
}
