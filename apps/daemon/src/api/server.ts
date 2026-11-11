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
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fleetError, parseStrict, SchemaError, toFleetError, type FleetError } from '@fleet/foundation-core'
import { watchParams, type DaemonApi, type DaemonResponse, type WatchFrame, type WatchParams } from '@fleet/foundation-contracts'
import { encodeLine, handleLine } from './rpc.ts'

export interface ServerDeps {
  readonly api: DaemonApi
  readonly socketPath: string
  readonly pidPath: string
  /** What the daemon's `down` does once the last response has been written. */
  readonly onDown?: () => void
  /** Every request that failed, so the daemon can log it; the socket already answered the client. */
  readonly onError?: (line: string, response: DaemonResponse) => void
  /**
   * What `peer.watch` streams from (watch-and-attach §6): frames until the stream
   * ends. Absent, the method is refused as unsupported rather than hung.
   */
  readonly watch?: (params: WatchParams) => AsyncIterable<WatchFrame>
  /** How much unsent output a watch connection may hold before it is dropped; see `watchBufferCap`. */
  readonly watchBufferCap?: number
}

/**
 * A watch whose socket holds more than this unsent is destroyed (§6: a stalled
 * client buffered 9 MB in 2 s in the spike). Not `write()`'s own `false`, which
 * fires at 16 KiB — less than the replay of a few peers' rings a healthy client is
 * sent in one burst. The feed's own queue bound is the other half: a client that
 * is slow, rather than stalled, is dropped there with an `end` frame.
 */
export const watchBufferCap = 4 * 1024 * 1024

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
/** A `peer.watch` request, read off the line before the ordinary dispatcher sees it; `undefined` for anything else. */
const watchRequest = (line: string): { readonly id: string | undefined; readonly params: unknown } | undefined => {
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null || (value as { method?: unknown }).method !== 'peer.watch') return undefined
    const { id, params } = value as { id?: unknown; params?: unknown }
    return { id: typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : undefined, params: params ?? {} }
  } catch {
    return undefined
  }
}

const isDown = (line: string): boolean => {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && (value as { method?: unknown }).method === 'down'
  } catch {
    return false
  }
}

export const createDaemonServer = async (deps: ServerDeps): Promise<DaemonServer> => {
  // 0700 when this creates the directory: what crosses the socket can include a
  // provider key (watch-and-attach §4, `peer.hold`), so the path to it is the
  // owner's. An existing directory is left as the person made it.
  await mkdir(dirname(deps.socketPath), { recursive: true, mode: 0o700 })
  // A socket file left by a dead daemon makes `listen` fail with EADDRINUSE and
  // no way to tell live from dead, so it is removed first: the pid file is the
  // liveness answer, not the socket.
  await rm(deps.socketPath, { force: true })

  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    // Aborts when the client goes away, so a request waiting on something that
    // outlives it (a hold waiting for a turn) is dropped with it.
    const gone = new AbortController()
    socket.setEncoding('utf8')
    let buffer = ''
    let chain: Promise<void> = Promise.resolve()
    /** This connection became a watch: it carries frames from here on, and no second request. */
    let watching = false

    const fail = (id: string | undefined, error: FleetError): void => {
      if (socket.writable) {
        socket.write(
          encodeLine({ ...(id === undefined ? {} : { id }), ok: false, error: { code: error.code, message: error.message } }),
        )
      }
    }

    const watch = async (request: { readonly id: string | undefined; readonly params: unknown }): Promise<void> => {
      if (deps.watch === undefined) {
        watching = false
        fail(request.id, fleetError('unsupported', 'this daemon has no display feed to watch'))
        return
      }
      let params: WatchParams
      try {
        params = parseStrict(watchParams(), request.params)
      } catch (thrown) {
        watching = false
        fail(
          request.id,
          thrown instanceof SchemaError
            ? fleetError('invalid_input', thrown.message, { cause: thrown, details: { issues: thrown.issues } })
            : toFleetError(thrown, 'internal'),
        )
        return
      }
      watching = true
      const cap = deps.watchBufferCap ?? watchBufferCap
      const stream = deps.watch(params)[Symbol.asyncIterator]()
      // The client going away ends the stream, whatever it was waiting on.
      const stop = (): void => void stream.return?.()
      socket.once('close', stop)
      try {
        for (let next = await stream.next(); next.done !== true; next = await stream.next()) {
          if (!socket.writable) break
          socket.write(`${JSON.stringify({ ...(request.id === undefined ? {} : { id: request.id }), ...next.value })}\n`)
          // A client that cannot keep up is dropped, never waited for: the feed must
          // not be able to slow a peer or grow the daemon.
          if (socket.writableLength > cap) {
            socket.destroy()
            break
          }
        }
      } finally {
        socket.off('close', stop)
        await stream.return?.()
        if (socket.writable) socket.end()
      }
    }

    socket.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        if (watching) {
          // One connection per watch: a request here would queue behind a stream that never ends.
          fail(undefined, fleetError('invalid_input', 'this connection is a watch; open another connection to send a request'))
          continue
        }
        const request = watchRequest(line)
        if (request !== undefined) {
          watching = true
          chain = chain.then(() => watch(request))
          continue
        }
        // Requests on one connection are answered in order, because a client
        // that sends `send` then `peek` expects the second to see the first.
        chain = chain.then(async () => {
          const response = await handleLine(deps.api, line, gone.signal)
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

    socket.on('close', () => {
      sockets.delete(socket)
      gone.abort()
    })
    socket.on('error', () => {
      sockets.delete(socket)
      gone.abort()
    })
  })

  // The socket is the owner's alone: `peer.hold` hands the takeover the env the
  // headless session got, keys included (watch-and-attach §4). The umask makes
  // the file 0600 from the moment `listen` binds it, so there is no window in
  // which another user could connect; the chmod after is the same rule stated
  // once more, for a platform whose bind ignores the umask.
  const umask = process.umask(0o177)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(deps.socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } finally {
    process.umask(umask)
  }
  await chmod(deps.socketPath, 0o600)

  const pid = process.pid
  await writeFile(deps.pidPath, `${String(pid)}\n`, 'utf8')

  return {
    address: deps.socketPath,
    pid,
    async close() {
      // Stop accepting new connections; don't wait for clients to disconnect.
      // Clients are destroyed immediately so they don't block shutdown.
      server.close()
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
