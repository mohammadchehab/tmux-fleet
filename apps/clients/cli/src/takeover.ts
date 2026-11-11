/**
 * The person's half of a takeover (watch-and-attach §5, §7): run the provider's
 * own CLI in this terminal, in the foreground, and get the terminal back
 * however it ends.
 *
 * Two rules, both proven in tmux, iTerm2 and macOS Terminal by the spike:
 *
 * - This process ignores SIGINT while the child owns the terminal. A ctrl-c
 *   reaches the whole foreground process group, and a child that is not in raw
 *   mode at that moment would otherwise take this process — and the release
 *   that must follow — down with it.
 * - After the child exits, however it exits, the terminal modes a full-screen
 *   CLI can leave on are reset: a child that was killed never got to.
 *
 * A third, found by killing the terminal under a live attach: SIGHUP (the
 * terminal closed) and SIGTERM (someone killed this process) are forwarded to the
 * child and waited out, so the release that follows still runs. Left to default,
 * they ended this process first and the peer stayed held until `fleet release`.
 * A child that ignores the signal is escalated, so a hung CLI cannot keep a peer
 * held either.
 */

import { spawn } from 'node:child_process'

import type { AttachCommand } from '@fleet/foundation-contracts'

/** What a dead full-screen CLI can leave on: mouse reporting, bracketed paste, focus events, keyboard protocol, cursor shape. */
export const TERMINAL_RESET =
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1004l\x1b[<u\x1b[>4;0m\x1b[0 q\x1b[0m\x1b[?25h'

export interface TakeoverExit {
  readonly code: number | null
  readonly signal: string | null
}

export type Takeover = (
  command: AttachCommand,
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly graceMs?: number },
) => Promise<TakeoverExit>

/** The variables the person's terminal brings to the takeover, on top of the peer's env (§5 step 3). */
export const TERMINAL_KEYS = ['TERM', 'COLORTERM', 'HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const

/** The takeover's env: the peer's, plus this terminal's own keys; nothing else of this shell's (§5). */
export const takeoverEnv = (
  peerEnv: Readonly<Record<string, string>>,
  terminal: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const env: Record<string, string> = { ...peerEnv }
  for (const key of TERMINAL_KEYS) {
    const value = terminal[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  return env
}

/** How long a child gets to leave after a hangup or a kill before it is told harder, then killed. */
export const defaultGraceMs = 5_000

const FORWARDED = ['SIGHUP', 'SIGTERM'] as const

export const runTakeover: Takeover = (command, options) =>
  new Promise((resolve, reject) => {
    const ignore = (): void => undefined
    process.on('SIGINT', ignore)
    let child: ReturnType<typeof spawn>
    const timers: NodeJS.Timeout[] = []
    const grace = options.graceMs ?? defaultGraceMs
    const forward = (signal: NodeJS.Signals): void => {
      // The terminal's hangup reaches the child on its own when it shares the
      // tty; this covers the child that does not, and a kill aimed at this process.
      child.kill(signal)
      if (timers.length > 0) return
      timers.push(
        setTimeout(() => {
          child.kill('SIGTERM')
          timers.push(setTimeout(() => child.kill('SIGKILL'), grace).unref())
        }, grace).unref(),
      )
    }
    const forwarders = FORWARDED.map((signal) => [signal, () => forward(signal)] as const)
    for (const [signal, handler] of forwarders) process.on(signal, handler)
    try {
      child = spawn(command.executable, [...command.args], { cwd: options.cwd, env: { ...options.env }, stdio: 'inherit' })
    } catch (thrown) {
      process.off('SIGINT', ignore)
      for (const [signal, handler] of forwarders) process.off(signal, handler)
      reject(thrown instanceof Error ? thrown : new Error(String(thrown)))
      return
    }
    const done = (): void => {
      process.off('SIGINT', ignore)
      for (const [signal, handler] of forwarders) process.off(signal, handler)
      for (const timer of timers) clearTimeout(timer)
      if (process.stdout.isTTY) process.stdout.write(TERMINAL_RESET)
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
    }
    child.once('error', (error) => {
      done()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      done()
      resolve({ code, signal })
    })
  })
