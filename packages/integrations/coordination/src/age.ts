/**
 * The `KeyWrap` port over the `age` binary (shared-fleet.md §5.1).
 *
 * `age` is called the way `git` and `gh` are — argv, no shell, the secret on
 * stdin and never in an argument or the environment — because its SSH
 * recipients are the point: a member's copy of the engagement key opens with
 * the SSH key they already sign in to GitHub with, so nobody generates, shares
 * or rotates a key by hand.
 *
 * Only `ssh-ed25519` and `ssh-rsa` recipients exist in `age`. A key of any other
 * type is refused here rather than silently skipped: which of a member's keys
 * can hold a copy is the caller's decision, and a copy wrapped to fewer keys
 * than the caller asked for is a member who might not be able to open it.
 */

import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { fleetError } from '@fleet/foundation-core'
import type { KeyWrap } from '@fleet/foundation-contracts'
import { execFileTool, type GitResult, type GitRunner } from './git.ts'

/** `age` on `PATH`. */
export const execFileAge: GitRunner = execFileTool('age')

/** A public key `age` accepts as a recipient: the type and the base64 body, no comment. */
const RECIPIENT = /^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/

/** The armor `age --armor` writes, and the line every file it makes begins with, decoded. */
const ARMOR_BEGIN = '-----BEGIN AGE ENCRYPTED FILE-----'
const ARMOR_END = '-----END AGE ENCRYPTED FILE-----'
const FILE_INTRO = 'age-encryption.org/v1'
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Whether `key` (as a forge serves it, maybe with a comment) can hold a copy; the recipient if so. */
export const ageRecipient = (key: string): string | undefined => {
  const [type, body] = key.trim().split(/\s+/)
  const recipient = `${type ?? ''} ${body ?? ''}`
  return RECIPIENT.test(recipient) ? recipient : undefined
}

/**
 * The tag `age` names a recipient by in a copy's header: the first four bytes of
 * the SHA-256 of the SSH public key's wire form, base64 without padding
 * (`agessh.sshFingerprint`, age 1.3.2). It is the identity `age` matches a
 * private key on when it opens a copy, which is what makes the header a
 * statement that can be checked without the key: a copy is sealed to a key
 * exactly when one of its stanzas carries that key's tag.
 */
const ageRecipientTag = (recipient: string): string | undefined => {
  const [type, body] = recipient.trim().split(/\s+/)
  if (type === undefined || body === undefined || !RECIPIENT.test(`${type} ${body}`)) return undefined
  return createHash('sha256').update(Buffer.from(body, 'base64')).digest().subarray(0, 4).toString('base64').replace(/=+$/, '')
}

/**
 * The tags of a copy's recipient stanzas, read from its cleartext header;
 * `undefined` if it is not a copy `wrap` made — not armor, not an age file, no
 * recipients, or no header terminator. The header is base64 inside the armor,
 * and a stanza's body may run on over more lines, so only `->` and `---` lines
 * carry anything this reads.
 */
const stanzaTags = (armored: string): readonly string[] | undefined => {
  const lines = armored
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines[0] !== ARMOR_BEGIN || lines.at(-1) !== ARMOR_END) return undefined
  const payload = lines.slice(1, -1).join('')
  if (!BASE64.test(payload)) return undefined
  const [intro, ...header] = Buffer.from(payload, 'base64').toString('latin1').split('\n')
  if (intro !== FILE_INTRO) return undefined
  const tags: string[] = []
  for (const line of header) {
    if (line.startsWith('--- ')) return tags.length > 0 ? tags : undefined
    if (!line.startsWith('-> ')) continue
    const [, type, tag] = line.split(' ')
    // A stanza that is not an SSH recipient is a key no member's SSH key is, and
    // is kept as its own unmatchable tag rather than skipped: a copy an X25519
    // identity could open is not a copy sealed only to the member's SSH keys.
    tags.push(type !== undefined && tag !== undefined && RECIPIENT.test(`${type} ${tag}`) ? tag : 'not-an-ssh-recipient')
  }
  return undefined
}

export const createAgeKeyWrap = (options: { readonly age?: GitRunner; readonly cwd?: string } = {}): KeyWrap => {
  const run = options.age ?? execFileAge
  const cwd = options.cwd ?? process.cwd()

  const failed = (verb: string, result: GitResult): never => {
    // stderr, never stdout: a decrypt that half-worked must not put key bytes in an error.
    throw fleetError('external_failed', `age ${verb} exited ${result.code}: ${result.stderr.trim().slice(0, 300) || 'no output'}`, {
      details: { verb, exitCode: result.code },
    })
  }

  return {
    recipient: ageRecipient,

    async wrap(plaintext, recipients) {
      if (recipients.length === 0) throw fleetError('invalid_input', 'a key wrapped to nobody is a key nobody can open')
      for (const recipient of recipients) {
        if (!RECIPIENT.test(recipient)) {
          throw fleetError('invalid_input', `age has no recipient type for ${JSON.stringify(recipient.split(' ')[0] ?? '')}`)
        }
      }
      const args = ['--encrypt', '--armor', ...recipients.flatMap((recipient) => ['--recipient', recipient])]
      const result = await run(args, { cwd, input: plaintext })
      if (result.code !== 0) failed('--encrypt', result)
      return result.stdout
    },

    sealedOnlyTo(armored, recipients) {
      const tags = stanzaTags(armored)
      if (tags === undefined) return false
      const allowed = new Set(recipients.map(ageRecipientTag))
      // Every stanza, not any: one sealed to an outsider as well is a copy an
      // outsider opens, however well the member's own key is in there.
      return tags.every((tag) => allowed.has(tag))
    },

    async unwrap(armored, identityFile) {
      if (!isAbsolute(identityFile)) throw fleetError('invalid_input', `an identity file is an absolute path, got ${JSON.stringify(identityFile)}`)
      const result = await run(['--decrypt', '--identity', identityFile], { cwd, input: armored })
      if (result.code !== 0) failed('--decrypt', result)
      return result.stdout
    },
  }
}
