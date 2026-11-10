/**
 * The macOS channel (§6.1): a desktop banner from `terminal-notifier` when it
 * is installed, else `osascript display notification`. Clicking a decision's
 * banner opens a terminal running `fleet decide <id>`.
 *
 * Both paths are one `execFile` away, and the executor is injected, so the
 * tests assert the exact argv without spawning anything — no banner during a
 * test run, and no `osascript` on a Linux CI box. `terminal-notifier` is an
 * optional `brew install`, so its absence is a downgrade, not a failure: the
 * osascript banner still arrives, it just cannot be withdrawn or clicked.
 */

import { execFile } from 'node:child_process'
import type { NotificationKey } from '@fleet/foundation-core'
import type { Notifier, NotifierMessage, NotifyResult } from '@fleet/notify-core'

export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs one program with argv, no shell. Resolves on a non-zero exit too; only a spawn failure is a rejection. */
export type Executor = (file: string, args: readonly string[]) => Promise<ExecResult>

export const execFileExecutor: Executor = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
        return
      }
      const code = typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || error.message })
    })
  })

/** Is a program on `PATH`? `which` answers, through the same injected executor, so nothing else to fake. */
export type BinaryProbe = (binary: string) => Promise<boolean>

export const whichProbe =
  (exec: Executor): BinaryProbe =>
  async (binary) => {
    const result = await exec('/usr/bin/which', [binary])
    return result.code === 0
  }

export interface MacNotifierOptions {
  /** Defaults to `execFile`, no shell. A test passes a fake and reads the argv. */
  readonly exec?: Executor
  /** Defaults to `which` through `exec`. */
  readonly has?: BinaryProbe
  /** Defaults to `process.platform`; injected so a test can pin either branch. */
  readonly platform?: string
}

/** A single-quoted shell word. The action string reaches terminal-notifier's `-execute`, which runs it through a shell. */
const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** The body of an AppleScript string literal: a raw quote or backslash would end it early. */
const appleScriptQuote = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/**
 * §6.1's action: "opens a terminal running `fleet decide <id>`". `-execute` runs
 * without a TTY, so the command is handed to Terminal.app rather than run where
 * the notification daemon cannot see its output.
 */
const terminalCommand = (cmd: string): string =>
  `/usr/bin/osascript -e ${shQuote(`tell application "Terminal" to do script "${appleScriptQuote(cmd)}"`)}`

/** A notification is a headline and a line or two; the rest is in `fleet ls` and `fleet decide` (§6.1). */
const MAX_BODY = 240

/** `display notification` takes one AppleScript literal, so a body's newlines become spaces, not an error. */
const appleScriptBody = (body: string): string => appleScriptQuote(body.replace(/\s+/g, ' ').trim().slice(0, MAX_BODY))

const argvFor = (message: NotifierMessage, terminalNotifier: boolean): { readonly file: string; readonly args: readonly string[] } =>
  terminalNotifier
    ? {
        file: 'terminal-notifier',
        args: [
          '-title',
          message.title,
          '-message',
          message.body,
          // The group is the key, which is what lets `withdraw` remove exactly this banner (§6.1).
          '-group',
          message.key,
          '-sound',
          'default',
          ...(message.action === undefined ? [] : ['-execute', terminalCommand(message.action.cmd)]),
        ],
      }
    : {
        file: 'osascript',
        args: [
          '-e',
          `display notification "${appleScriptBody(message.body)}" with title "${appleScriptQuote(message.title)}" sound name "Glass"`,
        ],
      }

/**
 * The channel. `id` is what every `notify.sent` records as `channel`, so it is
 * `macos` whether the banner came from terminal-notifier or osascript.
 */
export const createMacNotifier = (options: MacNotifierOptions = {}): Notifier => {
  const exec = options.exec ?? execFileExecutor
  const platform = options.platform ?? process.platform
  const has = options.has ?? whichProbe(exec)

  const assertPlatform = (): void => {
    if (platform !== 'darwin') throw new Error(`the macos channel needs macOS, this is ${platform}`)
  }

  // Probed once: the answer does not change during a run, and `which` on every banner is a process to no purpose.
  let terminalNotifier: Promise<boolean> | undefined
  const usingTerminalNotifier = async (): Promise<boolean> => {
    terminalNotifier ??= has('terminal-notifier').catch(() => false)
    return terminalNotifier
  }

  return {
    id: 'macos',

    async notify(message: NotifierMessage): Promise<NotifyResult> {
      assertPlatform()
      const { file, args } = argvFor(message, await usingTerminalNotifier())
      const result = await exec(file, args)
      // A non-zero exit is a delivery failure with a reason, which §6.1 records as `notify.failed`; `delivered: false`
      // is reserved for a channel that chose not to show the banner at all.
      if (result.code !== 0) throw new Error(`${file} exited ${result.code}: ${result.stderr.trim() || 'no output'}`)
      return { delivered: true }
    },

    async withdraw(key: NotificationKey): Promise<void> {
      assertPlatform()
      // Only terminal-notifier can take a banner back, and only one it posted. An osascript banner is on a timer of
      // its own; the `notify.withdrawn` event is still appended, so the row is closed either way (§6.1).
      if (!(await usingTerminalNotifier())) return
      const result = await exec('terminal-notifier', ['-remove', key])
      if (result.code !== 0) throw new Error(`terminal-notifier -remove exited ${result.code}: ${result.stderr.trim() || 'no output'}`)
    },
  }
}
