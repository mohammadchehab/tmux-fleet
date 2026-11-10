/**
 * The macOS channel: what it runs, in what order, and what it does on a box
 * that is not a Mac or has no `terminal-notifier` (§6.1). The executor is a fake
 * that records argv, so no banner appears and nothing is spawned.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { NotificationKey } from '@fleet/foundation-core'
import { createMacNotifier, type ExecResult } from '../src/macos.ts'

const key = 'decision:dec_0123456789abcdef' as NotificationKey

const message = {
  key,
  class: 'decision' as const,
  title: 'Decision needed: ship it?',
  body: 'Ship the CI gate before notify?\nOptions: yes · no\n\nfleet decide dec_0123456789abcdef',
  action: { cmd: 'fleet decide dec_0123456789abcdef' },
}

const recordingExecutor = (results: Partial<ExecResult> = {}) => {
  const calls: { readonly file: string; readonly args: readonly string[] }[] = []
  return {
    calls,
    exec: async (file: string, args: readonly string[]): Promise<ExecResult> => {
      calls.push({ file, args })
      return { code: 0, stdout: '', stderr: '', ...results }
    },
  }
}

/** A probe that says whether `terminal-notifier` is installed, without running `which`. */
const hasTerminalNotifier = (present: boolean) => async (binary: string) => present && binary === 'terminal-notifier'

describe('terminal-notifier, when it is installed', () => {
  it('runs one argv with the title, the message, the key as the group, and a click that opens a terminal', async () => {
    const recorder = recordingExecutor()
    const notifier = createMacNotifier({ exec: recorder.exec, has: hasTerminalNotifier(true), platform: 'darwin' })

    assert.deepEqual(await notifier.notify(message), { delivered: true })
    assert.equal(recorder.calls.length, 1)

    const [call] = recorder.calls
    assert.equal(call?.file, 'terminal-notifier')
    assert.deepEqual(call?.args.slice(0, 6), [
      '-title',
      'Decision needed: ship it?',
      '-message',
      message.body,
      '-group',
      key,
    ])
    // §6.1's action: the banner's click opens a terminal running `fleet decide <id>`, not a second inbox.
    const execute = call?.args[call.args.indexOf('-execute') + 1] ?? ''
    assert.match(execute, /osascript/)
    assert.match(execute, /Terminal/)
    assert.match(execute, /fleet decide dec_0123456789abcdef/)
  })

  it('withdraws by group, which is the same key the banner was posted under', async () => {
    const recorder = recordingExecutor()
    const notifier = createMacNotifier({ exec: recorder.exec, has: hasTerminalNotifier(true), platform: 'darwin' })

    await notifier.withdraw?.(key)

    assert.deepEqual(recorder.calls.at(-1), { file: 'terminal-notifier', args: ['-remove', key] })
  })

  it('probes for the binary once, not on every banner', async () => {
    const recorder = recordingExecutor()
    let probes = 0
    const notifier = createMacNotifier({
      exec: recorder.exec,
      has: async (binary) => {
        probes += 1
        return binary === 'terminal-notifier'
      },
      platform: 'darwin',
    })

    await notifier.notify(message)
    await notifier.notify(message)
    await notifier.withdraw?.(key)

    assert.equal(probes, 1)
  })
})

describe('osascript, when it is not installed', () => {
  it('still delivers, through one `display notification` script', async () => {
    const recorder = recordingExecutor()
    const notifier = createMacNotifier({ exec: recorder.exec, has: hasTerminalNotifier(false), platform: 'darwin' })

    assert.deepEqual(await notifier.notify(message), { delivered: true })

    const [call] = recorder.calls
    assert.equal(call?.file, 'osascript')
    assert.deepEqual(call?.args[0], '-e')
    const script = call?.args[1] ?? ''
    assert.match(script, /^display notification "Ship the CI gate before notify\? Options: yes · no fleet decide dec_0123456789abcdef"/)
    assert.match(script, /with title "Decision needed: ship it\?"/)
    // One AppleScript literal: a raw newline in it would be a syntax error, so the body is flattened.
    assert.doesNotMatch(script, /\n/)
  })

  it('escapes a quote instead of ending the AppleScript early', async () => {
    const recorder = recordingExecutor()
    const notifier = createMacNotifier({ exec: recorder.exec, has: hasTerminalNotifier(false), platform: 'darwin' })

    await notifier.notify({ ...message, title: 'Say "yes"', body: 'He said "go"' })

    const script = recorder.calls[0]?.args[1] ?? ''
    assert.match(script, /with title "Say \\"yes\\""/)
    assert.match(script, /display notification "He said \\"go\\""/)
  })

  it('cannot withdraw a banner it did not post, and says so by doing nothing', async () => {
    const recorder = recordingExecutor()
    const notifier = createMacNotifier({ exec: recorder.exec, has: hasTerminalNotifier(false), platform: 'darwin' })

    await notifier.withdraw?.(key)

    // No process at all: an osascript banner has no group to remove (§6.1's withdraw is optional for a channel).
    assert.deepEqual(recorder.calls, [])
  })
})

describe('failure is a reason, not a silent nothing', () => {
  it('a non-zero exit throws with the command and its stderr, so notify.failed can say what broke', async () => {
    const notifier = createMacNotifier({
      exec: recordingExecutor({ code: 1, stderr: 'unable to connect to notification server' }).exec,
      has: hasTerminalNotifier(true),
      platform: 'darwin',
    })

    await assert.rejects(
      () => notifier.notify(message),
      /terminal-notifier exited 1: unable to connect to notification server/,
    )
  })

  it('refuses to run anywhere but macOS, rather than spawning an osascript that is not there', async () => {
    const recorder = recordingExecutor()
    const notifier = createMacNotifier({ exec: recorder.exec, has: hasTerminalNotifier(true), platform: 'linux' })

    await assert.rejects(() => notifier.notify(message), /needs macOS/)
    assert.deepEqual(recorder.calls, [])
  })
})
