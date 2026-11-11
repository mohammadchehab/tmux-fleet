/**
 * The `KeyWrap` port over `age` (shared-fleet.md §5.1). The argv and the
 * refusals are tested against a recording runner; the property the design
 * rests on — a member opens their own copy with the SSH key they already have,
 * and nobody else's key opens it — is tested against the real binary with keys
 * made for the test, wherever `age` is installed.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { FleetError } from '@fleet/foundation-core'
import { ageRecipient, createAgeKeyWrap, type GitRunner } from '../src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'fleet-age-'))
after(() => rmSync(root, { recursive: true, force: true }))

const has = (binary: string): boolean => {
  try {
    execFileSync('which', [binary], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const noAge = has('age') && has('ssh-keygen') ? false : 'needs the age and ssh-keygen binaries'

/** A fresh SSH key pair: the private key's path and the public key as GitHub serves it. */
const keyPair = (name: string, type: 'ed25519' | 'rsa' = 'ed25519'): { readonly identity: string; readonly recipient: string } => {
  const identity = join(root, name)
  execFileSync('ssh-keygen', ['-q', '-t', type, ...(type === 'rsa' ? ['-b', '2048'] : []), '-N', '', '-C', '', '-f', identity])
  return { identity, recipient: ageRecipient(readFileSync(`${identity}.pub`, 'utf8'))! }
}

const recording = (reply: { code?: number; stdout?: string; stderr?: string } = {}) => {
  const calls: { args: string[]; input: string | undefined }[] = []
  const age: GitRunner = async (args, call) => {
    calls.push({ args: [...args], input: call.input })
    return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
  }
  return { calls, age }
}

const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (thrown: unknown) => thrown instanceof FleetError && thrown.code === code)

/** A copy `age` makes to a recipient `wrap` refuses, to show the reader refuses it too. */
const ageEncrypt = (recipient: string): string =>
  execFileSync('age', ['--encrypt', '--armor', '--recipient', recipient], { input: 'engagement-key', encoding: 'utf8' })

const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHvKiqk0tzYG0dBpqEzuHf9u9g2oZXQ6eTW6wNy4P1Lh'

describe('a recipient', () => {
  it('is the type and body of an ed25519 or RSA key, with any comment dropped', () => {
    assert.equal(ageRecipient(`${ED} alice@laptop\n`), ED)
    assert.equal(ageRecipient('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7'), 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7')
  })

  it('does not exist for a key type age cannot encrypt to', () => {
    assert.equal(ageRecipient('ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAI'), undefined)
    assert.equal(ageRecipient('sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t'), undefined)
    assert.equal(ageRecipient('ssh-ed25519 not;base64'), undefined)
  })
})

describe('wrapping', () => {
  it('passes the secret on stdin and every recipient as its own argument', async () => {
    const { calls, age } = recording({ stdout: '-----BEGIN AGE ENCRYPTED FILE-----\n' })
    await createAgeKeyWrap({ age }).wrap('the-key', [ED, 'ssh-rsa AAAAB3NzaC1yc2E'])

    assert.deepEqual(calls[0]!.args, ['--encrypt', '--armor', '--recipient', ED, '--recipient', 'ssh-rsa AAAAB3NzaC1yc2E'])
    assert.equal(calls[0]!.input, 'the-key')
    assert.ok(!calls[0]!.args.some((arg) => arg.includes('the-key')), 'the secret is never an argument')
  })

  it('refuses no recipients and a recipient age has no type for, before running age', async () => {
    const { calls, age } = recording()
    const wrap = createAgeKeyWrap({ age })
    await rejectsWith(wrap.wrap('k', []), 'invalid_input')
    await rejectsWith(wrap.wrap('k', [ED, 'ecdsa-sha2-nistp256 AAAA']), 'invalid_input')
    await rejectsWith(wrap.wrap('k', ['--identity /etc/passwd']), 'invalid_input')
    assert.deepEqual(calls, [])
  })

  it('reports a failed age by its stderr and never its stdout', async () => {
    const { age } = recording({ code: 1, stdout: 'partial-plaintext', stderr: 'age: error: no identity matched' })
    await assert.rejects(
      createAgeKeyWrap({ age }).unwrap('armored', '/home/alice/.ssh/id_ed25519'),
      (thrown: unknown) => thrown instanceof FleetError && /no identity matched/.test(thrown.message) && !thrown.message.includes('partial-plaintext'),
    )
  })

  it('refuses an identity that is not an absolute path', async () => {
    const { calls, age } = recording()
    await rejectsWith(createAgeKeyWrap({ age }).unwrap('armored', '-o/tmp/x'), 'invalid_input')
    assert.deepEqual(calls, [])
  })
})

describe('a copy of the key, with the real age', { skip: noAge }, () => {
  it('opens with its member’s SSH key, and with no other member’s', async () => {
    const alice = keyPair('alice')
    const bob = keyPair('bob')
    const wrap = createAgeKeyWrap({ cwd: root })

    const forAlice = await wrap.wrap('engagement-key', [alice.recipient])

    assert.equal(await wrap.unwrap(forAlice, alice.identity), 'engagement-key')
    await rejectsWith(wrap.unwrap(forAlice, bob.identity), 'external_failed')
  })

  it('opens with any one of a member’s keys, ed25519 or RSA', async () => {
    const laptop = keyPair('laptop')
    const desktop = keyPair('desktop', 'rsa')
    const wrap = createAgeKeyWrap({ cwd: root })

    const copy = await wrap.wrap('engagement-key', [laptop.recipient, desktop.recipient])

    assert.equal(await wrap.unwrap(copy, laptop.identity), 'engagement-key')
    assert.equal(await wrap.unwrap(copy, desktop.identity), 'engagement-key')
  })
})

describe('a copy, read as sealed without decrypting it', { skip: noAge }, () => {
  it('is sealed to the keys it was wrapped for, ed25519 and RSA, and to no others', async () => {
    const alice = keyPair('sealed-alice')
    const aliceDesktop = keyPair('sealed-alice-desktop', 'rsa')
    const bob = keyPair('sealed-bob')
    const wrap = createAgeKeyWrap({ cwd: root })

    const copy = await wrap.wrap('engagement-key', [alice.recipient, aliceDesktop.recipient])
    const older = await wrap.wrap('engagement-key', [alice.recipient])

    assert.equal(wrap.sealedOnlyTo(copy, [alice.recipient, aliceDesktop.recipient]), true)
    assert.equal(wrap.sealedOnlyTo(copy, [alice.recipient, aliceDesktop.recipient, bob.recipient]), true, 'a member with keys it did not use')
    assert.equal(wrap.sealedOnlyTo(older, [alice.recipient, aliceDesktop.recipient]), true, 'a copy from before one of the member’s keys existed')
    assert.equal(wrap.sealedOnlyTo(copy, [alice.recipient]), false, 'a key it was wrapped for is not in the set given')
    assert.equal(wrap.sealedOnlyTo(copy, [bob.recipient]), false, 'bob holds no key it was wrapped for')
    assert.equal(wrap.sealedOnlyTo(copy, [alice.recipient, bob.recipient]), false)
    assert.equal(wrap.sealedOnlyTo(copy, []), false)
  })

  it('is not sealed only to its member once an outsider’s key is on it too', async () => {
    const alice = keyPair('together-alice')
    const mallory = keyPair('together-mallory')
    const wrap = createAgeKeyWrap({ cwd: root })
    const copy = await wrap.wrap('engagement-key', [alice.recipient, mallory.recipient])

    assert.equal(wrap.sealedOnlyTo(copy, [alice.recipient]), false)
    assert.equal(await wrap.unwrap(copy, mallory.identity), 'engagement-key', 'and mallory really can open it')
  })

  it('is false for anything that is not a copy age made', async () => {
    const alice = keyPair('garbage-alice')
    const wrap = createAgeKeyWrap({ cwd: root })
    const copy = await wrap.wrap('engagement-key', [alice.recipient])
    const lines = copy.trimEnd().split('\n')
    const half = [...lines.slice(0, 2), lines.at(-1)!].join('\n')

    assert.equal(wrap.sealedOnlyTo('', [alice.recipient]), false)
    assert.equal(wrap.sealedOnlyTo('engagement-key', [alice.recipient]), false)
    assert.equal(wrap.sealedOnlyTo(`${copy}\nand this`, [alice.recipient]), false, 'a copy with something appended')
    assert.equal(wrap.sealedOnlyTo(half, [alice.recipient]), false, 'a copy with its header cut short')
  })

  it('is false for a copy sealed to an identity that is not an SSH key', { skip: has('age-keygen') ? false : 'needs age-keygen' }, async () => {
    const alice = keyPair('x25519-alice')
    const identity = join(root, 'x25519.txt')
    execFileSync('age-keygen', ['-o', identity], { stdio: 'ignore' })
    const native = /^# public key: (age1[a-z0-9]+)$/m.exec(readFileSync(identity, 'utf8'))![1]!
    const wrap = createAgeKeyWrap({ cwd: root })
    const copy = await wrap.wrap('engagement-key', [alice.recipient])

    assert.equal(wrap.sealedOnlyTo(copy, [alice.recipient]), true)
    assert.equal(wrap.sealedOnlyTo(ageEncrypt(native), [alice.recipient]), false, 'an X25519 identity could open it')
  })
})
