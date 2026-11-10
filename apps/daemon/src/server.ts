/**
 * The Unix-socket server (§2). One connection, one line of JSON, one line back.
 *
 * It holds no state and makes no decisions: `handleLine` does the decode and the
 * call, and this file only owns the socket lifecycle — a stale socket file from
 * a crashed daemon is removed on `listen`, the pid file says who is running, and
 * `close()` stops accepting and lets in-flight requests finish. That split is
 * what makes the API testable without a filesystem.
 */

import { createServer, type Server, type Socket } from 'node:net'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fleetError, type FleetError } from '@fleet/foundation-core'
import type { DaemonApi, DaemonResponse } from '@fleet/foundation-contracts'
import { encodeLine, handleLine } from './rpc.ts'

export interface ServerDeps {
  readonly api: DaemonApi
  readonly socketPath: string
  readonly pidPath: string
  /** What the daemon's `down` does once the last response has been written. */
  readonly onDown?: () => void
  /** Every request that failed, so the daemon can log it; the socket already answered the client. */
  readonly onError?: (line: string, response: DaemonResponse) => void
}

export interface DaemonServer {
  readonly address: string
  /** Stop accepting, remove the socket and the pid file. Idempotent. */
  close(): Promise<void>
  /** The pid this server wrote, or `undefined` before `listen`. */
  readonly pid: number | undefined
}

/** A pid file is for `fleet ls` of a daemon nobody can reach; a stale one is worse than none. */
export const readPid = async (pidPath: string): Promise<number | undefined> => {
  try {
    const raw = await readFile(pidPath, 'utf8')
    const pid = Number.parseInt(raw.trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** Was this line a `down` request? The method is the only field that matters here, so it is read before the handler runs. */
const isDown = (line: string): boolean => {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && (value as { method?: unknown }).method === 'down'
  } catch {
    return false
  }
}

export const createDaemonServer = async (deps: ServerDeps): Promise<DaemonServer> => {
  await mkdir(dirname(deps.socketPath), { recursive: true })
  // A socket file left by a dead daemon makes `listen` fail with EADDRINUSE and
  // no way to tell live from dead, so it is removed first: the pid file is the
  // liveness answer, not the socket.
  await rm(deps.socketPath, { force: true })

  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let chain: Promise<void> = Promise.resolve()

    socket.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        // Requests on one connection are answered in order, because a client
        // that sends `send` then `peek` expects the second to see the first.
        chain = chain.then(async () => {
          const response = await handleLine(deps.api, line)
          if (!response.ok) deps.onError?.(line, response)
          if (socket.writable) socket.write(encodeLine(response))
          if (response.ok && isDown(line)) {
            // `down` answers, then the daemon goes away; the deferral lets the
            // response reach the client before the socket closes under it.
            setImmediate(() => deps.onDown?.())
          }
        })
      }
    })

    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(deps.socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const pid = process.pid
  await writeFile(deps.pidPath, `${String(pid)}\n`, 'utf8')

  return {
    address: deps.socketPath,
    pid,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await rm(deps.socketPath, { force: true })
      await rm(deps.pidPath, { force: true })
    },
  }
}

/**
 * The client half, for the tests and for `fleet up`'s readiness check: one line
 * out, one line back, on a fresh connection.
 */
export const rpcCall = async (socketPath: string, request: unknown): Promise<DaemonResponse> => {
  const { connect } = await import('node:net')
  return new Promise<DaemonResponse>((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    const fail = (error: FleetError): void => {
      socket.destroy()
      reject(error)
    }
    socket.setEncoding('utf8')
    socket.once('error', (error) => fail(fleetError('internal', `cannot reach fleetd at ${socketPath}: ${error.message}`)))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      socket.end()
      try {
        resolve(JSON.parse(line) as DaemonResponse)
      } catch (cause) {
        reject(fleetError('internal', `fleetd answered something that is not JSON: ${(cause as Error).message}`))
      }
    })
    socket.write(`${JSON.stringify(request)}\n`)
  })
}
