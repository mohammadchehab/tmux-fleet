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
 *
 * A record is also a claim anyone with push can write, so the copies it names are
 * read back and held to the keys each member has now, not to what it says about
 * them (`unverifiableCopy`): a copy that is not one `age` made, or one sealed to
 * a key that is not the member's, is a record that was not made here. That is
 * as far as a header can be read — it names a key by a 32-bit tag, so a key
 * ground to collide with a member's is not caught (TASK-121).
 */

import { createHash, randomBytes } from 'node:crypto'
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
/** The highest rotation the record's schema (and so the ref name) allows. */
const MAX_ROTATION = 999_999_999

/** The rotations under `<ns>/rotate/`, highest first. A ref that is not one is ignored. */
const rotationsOf = (refs: readonly CoordinationRef[], prefix: string): { readonly n: number; readonly ref: CoordinationRef }[] =>
  refs
    .map((ref) => ({ ref, tail: ref.name.slice(prefix.length) }))
    .filter(({ tail }) => ROTATION_NUMBER.test(tail))
    .map(({ ref, tail }) => ({ n: Number(tail), ref }))
    .sort((a, b) => b.n - a.n)

/** What a rotation records of the keys a copy was sealed to: the sha256 (hex) of each recipient, sorted. */
export const recipientFingerprints = (recipients: readonly string[]): string[] =>
  [...new Set(recipients.map((recipient) => createHash('sha256').update(recipient).digest('hex')))].sort()

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

  const prefix = 'rotate/'
  const rotations = rotationsOf(await options.coordination.refs(prefix), prefix)
  const [current] = rotations

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
  const copies: CopyCheck = { wrap: options.wrap, recipientsOf }

  if (current !== undefined) {
    // Rotation refs are written by anyone with push on the coordination
    // repository, so a revocation that trusts one as found can be blocked by it.
    // The numbers must run 1..n with no gap, and the winner must be what
    // `reconcileKey` makes; otherwise nothing is rotated and the log says why.
    const gap = rotations.findIndex((r, i) => r.n !== current.n - i) !== -1 || rotations.at(-1)?.n !== 1
    if (gap) {
      return { kind: 'refused', reason: `the rotations under ${prefix} are not 1..${current.n} without a gap; someone wrote a ref that reconcileKey did not` }
    }
    if (current.n >= MAX_ROTATION) {
      return { kind: 'refused', reason: `rotation ${current.n} is the last number a rotation can have` }
    }
    const checked = await readRecord(options.coordination, current.ref, copies)
    if (!checked.ok) return { kind: 'refused', reason: `rotation ${current.n} is not one this fleet's rule would make: ${checked.reason}` }
    const record = checked.record
    if (sameList(record.members, members)) {
      // The same team. What else can have changed is a member's keys. A key *added*
      // (or a member with no key getting one) is a new rotation: the copy is still
      // sealed to every key it was. A key *replaced or removed* is not, because the
      // key they dropped can still open the copy sealed to it and the fleet cannot
      // tell a rotated key from a stolen one: it refuses and a person clears the ref
      // (decision-4). A record with no fingerprints says nothing about the keys its
      // copies were sealed to, so it is rotated over, once.
      let changed = record.recipients === undefined
      for (const member of record.missing) if ((await recipientsOf(member)).length > 0) changed = true
      for (const [member, sealedTo] of Object.entries(record.recipients ?? {})) {
        const now = recipientFingerprints(await recipientsOf(member))
        if (!sealedTo.every((fingerprint) => now.includes(fingerprint))) {
          return {
            kind: 'refused',
            reason: `${member} no longer has every key rotation ${current.n} was sealed to (one was replaced or removed); the old key still opens their copy, so a person must clear ${current.ref.name} and decide`,
          }
        }
        if (now.length !== sealedTo.length) changed = true
      }
      if (!changed) return { kind: 'current', rotation: current.n }
    }
  }

  const rotation = (current?.n ?? 0) + 1
  const key = (options.newKey ?? (() => randomBytes(32).toString('base64')))()
  const files: Record<string, string> = {}
  const missing: string[] = []
  const sealedTo: Record<string, string[]> = {}
  for (const member of members) {
    const usable = await recipientsOf(member)
    if (usable.length === 0) {
      missing.push(member)
      continue
    }
    files[`${member}.age`] = await options.wrap.wrap(key, usable)
    sealedTo[member] = recipientFingerprints(usable)
  }
  if (missing.length === members.length) {
    return { kind: 'refused', reason: `no member of ${options.team} has an ssh-ed25519 or ssh-rsa key on GitHub` }
  }

  const record: KeyRotation = { version: 1, rotation, members, missing, recipients: sealedTo, by: options.self, at: options.clock.now() }
  files[ROTATION_FILE] = `${JSON.stringify(record, null, 2)}\n`
  const created = await options.coordination.create({
    ref: `${prefix}${rotation}`,
    files,
    message: `rotation ${rotation}: ${members.length} member(s)${missing.length > 0 ? `, ${missing.length} without a key` : ''}`,
  })
  if (created.created) return { kind: 'rotated', rotation, members, missing }
  // Someone else made this number. A fleet's own lose is a valid rotation; an
  // attacker's ref that got there first is not, and must not read as a lost race.
  const winner = await readRecord(options.coordination, { name: `${prefix}${rotation}`, sha: created.sha }, copies)
  if (!winner.ok) return { kind: 'refused', reason: `rotation ${rotation} was made by someone else and is not valid: ${winner.reason}` }
  return { kind: 'lost_race', rotation }
}

type Checked = { readonly ok: true; readonly record: KeyRotation } | { readonly ok: false; readonly reason: string }

/**
 * A rotation's record, accepted only if it is what `reconcileKey` writes: it
 * decodes, names its own number, was made by one of its members, leaves at least
 * one member a copy, its files are exactly the record plus one `<login>.age` per
 * member that has a copy, and every one of those copies is sealed to a key that
 * member has now — otherwise it is a team member with push writing a key nobody
 * else agreed to, which is the one thing a record cannot be trusted for.
 */
const readRecord = async (coordination: Coordination, ref: CoordinationRef, copies: CopyCheck): Promise<Checked> => {
  const held = await coordination.read(ref)
  const text = held?.files[ROTATION_FILE]
  if (held === undefined || text === undefined) return { ok: false, reason: `it has no ${ROTATION_FILE}` }
  let record: KeyRotation
  try {
    const decoded = decodeStrict(keyRotation(), JSON.parse(text))
    if (!decoded.ok) return { ok: false, reason: `its ${ROTATION_FILE} does not decode` }
    record = decoded.value
  } catch {
    return { ok: false, reason: `its ${ROTATION_FILE} is not JSON` }
  }
  if (`${prefixOf(ref)}${record.rotation}` !== ref.name) return { ok: false, reason: `its record says rotation ${record.rotation}` }
  if (!record.members.includes(record.by)) return { ok: false, reason: `${record.by} made it and is not one of its members` }
  if (!record.missing.every((login) => record.members.includes(login))) return { ok: false, reason: 'it lists a missing member who is not a member' }
  if (record.missing.length >= record.members.length) return { ok: false, reason: 'it gives no member a copy' }
  const expected = [ROTATION_FILE, ...record.members.filter((m) => !record.missing.includes(m)).map((m) => `${m}.age`)].sort()
  const actual = Object.keys(held.files).sort()
  if (record.recipients !== undefined) {
    const withCopy = record.members.filter((m) => !record.missing.includes(m)).sort()
    if (!sameList(withCopy, Object.keys(record.recipients).sort())) return { ok: false, reason: 'its fingerprints are not for exactly the members who have a copy' }
  }
  if (!sameList(expected, actual)) return { ok: false, reason: 'its files are not its record plus one copy per member it names' }
  const unverifiable = await unverifiableCopy(record, held.files, copies, ref)
  if (unverifiable !== undefined) return { ok: false, reason: unverifiable }
  return { ok: true, record }
}

/** What a record's copies are held to: the sealing, and each member's keys as the forge serves them now. */
interface CopyCheck {
  readonly wrap: KeyWrap
  readonly recipientsOf: (member: string) => Promise<readonly string[]>
}

/**
 * The first member whose copy is not what this fleet would have sealed for them,
 * and why, or `undefined` when every copy is sealed to its own member's current
 * keys and to nothing else.
 *
 * This is the check decision-3 asked for: the record is a claim anyone with push
 * can write, so the copies it names are read and held to the keys their members
 * have now, not to what the record says about them. A copy that is not an age
 * file, one sealed to a key that is not the member's, and one sealed to a key the
 * member has since replaced all fail it, because at the header they are the same
 * thing. The header names a key by a 32-bit tag rather than by the key, so a key
 * ground to carry a member's tag passes: this refuses cheap forgeries, and
 * TASK-121 is the card for the expensive one.
 *
 * That last case is the cost of it, and decision-4 (a) took it: a member who
 * replaced or removed a key stops the rotation rather than causing one, and the
 * reason says which member and which ref a person has to remove, because the
 * fleet does not step around a ref it cannot tell from a forgery. Decision-4 (b)
 * would make an empty or disjoint set stale and rotate instead; this function is
 * the only place that changes, so it would be a diff and not a rewrite.
 */
const unverifiableCopy = async (
  record: KeyRotation,
  files: Readonly<Record<string, string>>,
  copies: CopyCheck,
  ref: CoordinationRef,
): Promise<string | undefined> => {
  const clear = `a person must remove ${ref.name}; this fleet does not rotate over a ref it cannot tell from a forgery`
  for (const member of record.members) {
    if (record.missing.includes(member)) continue
    let usable: readonly string[]
    try {
      usable = await copies.recipientsOf(member)
    } catch (error) {
      // A member whose keys cannot be read is one whose copy cannot be checked,
      // and a check that cannot run is not one that passed.
      return `${member}'s keys cannot be read (${error instanceof Error ? error.message : String(error)}), so their copy cannot be checked; ${clear}`
    }
    if (usable.length === 0) return `${member} has no ssh-ed25519 or ssh-rsa key now, so their copy opens for nobody; ${clear}`
    if (!copies.wrap.sealedOnlyTo(files[`${member}.age`] ?? '', usable)) {
      return `the copy for ${member} is not sealed to ${member}'s current keys alone; ${clear}`
    }
  }
  return undefined
}

/** `<ns>/rotate/` of a rotation ref. */
const prefixOf = (ref: CoordinationRef): string => ref.name.slice(0, ref.name.lastIndexOf('/') + 1)
