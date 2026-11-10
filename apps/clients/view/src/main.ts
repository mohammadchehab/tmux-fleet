#!/usr/bin/env node
/**
 * `fleet-view` the process: argv in, exit code out (§2).
 *
 * Everything with a decision in it is elsewhere and takes its caller as an
 * argument — `args.ts` parses, `view.ts` asks, `render.ts` formats, `tmux.ts`
 * plans. This file supplies the three things that need a process: the socket,
 * the clock, and `tmux`.
 *
 * Two ways to run, one rule (§2 "a read-only view, one pane per peer"):
 *
 * - `--once` prints and exits. Piped output, a test, a session over ssh and
 *   `--pane <peer>` all land here, and none of them needs a terminal.
 * - otherwise the view stays up. With `--pane` that is one pane redrawing; in
 *   a terminal with no `--pane` it is a tmux window of one pane per peer, each
 *   pane running this same binary with `--pane`. Inside that pane nothing is
 *   read from the keyboard except ctrl-c: there is no prompt, no shell, and
 *   nothing a keystroke could do to the fleet.
 */

import { spawn } from 'node:child_process'

import { toFleetError } from '@fleet/foundation-core'

import { parseArgv, usage, type ViewCommand } from './args.ts'
import { callerFor, type Caller } from './client.ts'
import { socketPathOf, type SocketChoice } from './socket.ts'
import { buildCommands, hasSessionCommand, showCommand, viewSessionName, type BuildOptions } from './tmux.ts'
import { paneLines, tableOnce } from './view.ts'

/** Command names exit 2, an unreadable fleet exits 1; the same split the `fleet` CLI makes. */
const USAGE_EXIT = 2

const write = (text: string): void => {
  process.stdout.write(`${text}\n`)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One tmux command. Resolves with its exit code and what it said, so a failure
 * to build the session can be reported instead of leaving a half-built grid.
 */
const tmux = (args: readonly string[]): Promise<{ readonly code: number; readonly stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn('tmux', [...args], { stdio: ['ignore', 'inherit', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      resolve({ code: error.code === 'ENOENT' ? 127 : 1, stderr: error.message })
    })
    child.once('close', (code) => {
      resolve({ code: code ?? 1, stderr })
    })
  })

/**
 * The pane: redraw the same lines on an interval until interrupted.
 *
 * `setRawMode` is the read-only half of the design, and the reason it is here
 * rather than in a flag: in cooked mode the tty echoes whatever the user types
 * into the middle of the render. Raw mode stops the echo *and* the signals, so
 * ctrl-c has to be taken as a byte — which is fine, because a view that took no
 * key at all could only be closed from the tmux prefix.
 */
const runPane = async (command: ViewCommand & { kind: 'live' }, call: Caller): Promise<number> => {
  const peer = command.peer
  if (peer === undefined) return USAGE_EXIT

  const tty = process.stdout.isTTY === true
  let stopped = false
  const quit = (): void => {
    stopped = true
    if (tty) process.stdout.write('\x1b[?25h')
    process.exit(0)
  }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
  process.on('SIGHUP', quit)

  if (process.stdin.isTTY === true) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', (chunk: Buffer) => {
      // 3 is ctrl-c, the one byte that still means something. Everything else is
      // dropped: "it never receives keystrokes" is literal here.
      if (chunk.includes(3)) quit()
    })
  }

  while (!stopped) {
    const lines = await paneLines(call, peer)
    if (tty) process.stdout.write('\x1b[H\x1b[2J')
    write(lines.join('\n'))
    write(`\n  redrawing every ${String(command.intervalMs)} ms — ctrl-c stops this pane`)
    await sleep(command.intervalMs)
  }
  return 0
}

const tmuxMissing = (stderr: string): string =>
  `cannot run tmux (${stderr.trim()}); use --once to print the view without it, or --pane <peer> for one peer`

/**
 * The grid: join the fleet's session if it is up, otherwise build it from the
 * peers the daemon reports and join that.
 *
 * The session is named after the profile, so `fleet-view --profile a` and
 * `--profile b` are two windows rather than one view of the wrong fleet, and a
 * second `fleet-view` on the same profile attaches to the view someone already
 * has open instead of splitting every peer into a second pane.
 */
const runGrid = async (command: ViewCommand & { kind: 'live' }, socket: SocketChoice, call: Caller): Promise<number> => {
  // Read once before building anything: a grid of panes each reporting "cannot
  // reach fleetd" is a worse answer than the one line saying so.
  const result = await call('ls', {})
  if (result.peers.length === 0) {
    write(`${result.status.profile}: no peers registered, so there is nothing to view`)
    return 0
  }

  const session = viewSessionName(command.profile ?? result.status.profile)
  const insideTmux = process.env['TMUX'] !== undefined
  const existing = await tmux(hasSessionCommand(session))
  if (existing.code === 0) {
    const shown = await tmux(showCommand(session, insideTmux))
    return shown.code === 0 ? 0 : 1
  }

  const script = process.argv[1]
  if (script === undefined) {
    write('cannot find the script to put in each pane; run fleet-view from its package instead')
    return 1
  }

  const plan: BuildOptions = {
    command: [process.execPath, script],
    socketPath: socket.socketPath,
    intervalMs: command.intervalMs,
    session,
    peers: result.peers.map((peer) => peer.peerId),
  }
  for (const argv of buildCommands(plan)) {
    const built = await tmux(argv)
    if (built.code === 0) continue
    write(built.code === 127 ? tmuxMissing(built.stderr) : `tmux ${argv.join(' ')} failed: ${built.stderr.trim()}`)
    // Leave nothing half-built: the panes are renderers for a fleet you asked to
    // see, and a partial grid would show some peers and silently drop others.
    await tmux(['kill-session', '-t', session])
    return 1
  }

  const shown = await tmux(showCommand(session, insideTmux))
  return shown.code === 0 ? 0 : 1
}

const main = async (): Promise<number> => {
  const command = parseArgv(process.argv)
  if (command.kind === 'help') {
    write(usage())
    return 0
  }

  const socket = socketPathOf({
    ...(command.socket === undefined ? {} : { socket: command.socket }),
    ...(command.profile === undefined ? {} : { profile: command.profile }),
    env: process.env,
  })
  const call = callerFor({ socketPath: socket.socketPath })

  if (command.kind === 'once') {
    if (command.peer === undefined) {
      write(await tableOnce(call))
      return 0
    }
    write((await paneLines(call, command.peer)).join('\n'))
    return 0
  }

  // A live whole-fleet view with no terminal to draw in is the same view printed
  // once: redrawing a pipe forever would be a process a person cannot stop.
  if (command.peer === undefined && process.stdout.isTTY !== true) {
    write(await tableOnce(call))
    return 0
  }
  return command.peer === undefined ? await runGrid(command, socket, call) : await runPane(command, call)
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    const fleet = toFleetError(error)
    process.stderr.write(`fleet-view: ${fleet.message}\n`)
    process.exitCode = fleet.code === 'invalid_input' ? USAGE_EXIT : 1
  },
)
