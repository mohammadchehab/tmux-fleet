#!/usr/bin/env node
/**
 * `fleet-board` the process: argv in, exit code out (§2).
 *
 * Everything with a decision in it is elsewhere and takes its caller as an
 * argument — `args.ts` parses, `serve.ts` listens, `render.ts` formats. This
 * file supplies the two things that need a process: the socket and the clock.
 *
 * Two ways to run, one rule (§2 "a board that only reads"):
 *
 * - `--once` renders the page and prints it. A test, a pipe and a person
 *   checking the board over ssh all land here, and none needs a port.
 * - otherwise the board stays up on `--host`:`--port` until interrupted.
 *   Every request re-reads the daemon, so there is no refresh loop to keep
 *   alive and nothing to go stale between a page load and an answer.
 */

import { toFleetError } from '@fleet/foundation-core'

import { parseArgv, usage } from './args.ts'
import { callerFor } from './client.ts'
import { renderBoard, renderUnreachable } from './render.ts'
import { serveBoard } from './serve.ts'
import { socketPathOf } from './socket.ts'

/** Command names exit 2, an unreadable fleet exits 1; the same split the `fleet` CLI makes. */
const USAGE_EXIT = 2

const write = (text: string): void => {
  process.stdout.write(`${text}\n`)
}

const now = (): string => new Date().toISOString()

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
    // The same renderer the server uses, so `--once` is a test of the page.
    try {
      const [ls, work] = await Promise.all([call('ls', {}), call('work', {})])
      write(renderBoard({ status: ls.status, work: work.work, renderedAt: now() }))
      return 0
    } catch (thrown) {
      write(renderUnreachable(socket.socketPath, toFleetError(thrown).message, now()))
      return 1
    }
  }

  const board = await serveBoard({ socketPath: socket.socketPath, host: command.host, port: command.port, call, now })
  write(`fleet-board: ${board.url} (read-only; ctrl-c stops it)`)

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  await board.stop()
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    const fleet = toFleetError(error)
    process.stderr.write(`fleet-board: ${fleet.message}\n`)
    process.exitCode = fleet.code === 'invalid_input' ? USAGE_EXIT : 1
  },
)
