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

import { isAbsolute } from 'node:path'
import { fleetError } from '@fleet/foundation-core'
import type { KeyWrap } from '@fleet/foundation-contracts'
import { execFileTool, type GitResult, type GitRunner } from './git.ts'

/** `age` on `PATH`. */
export const execFileAge: GitRunner = execFileTool('age')

/** A public key `age` accepts as a recipient: the type and the base64 body, no comment. */
const RECIPIENT = /^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/

/** Whether `key` (as a forge serves it, maybe with a comment) can hold a copy; the recipient if so. */
export const ageRecipient = (key: string): string | undefined => {
  const [type, body] = key.trim().split(/\s+/)
  const recipient = `${type ?? ''} ${body ?? ''}`
  return RECIPIENT.test(recipient) ? recipient : undefined
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

    async unwrap(armored, identityFile) {
      if (!isAbsolute(identityFile)) throw fleetError('invalid_input', `an identity file is an absolute path, got ${JSON.stringify(identityFile)}`)
      const result = await run(['--decrypt', '--identity', identityFile], { cwd, input: armored })
      if (result.code !== 0) failed('--decrypt', result)
      return result.stdout
    },
  }
}
