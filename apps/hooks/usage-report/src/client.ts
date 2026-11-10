/**
 * One request to the daemon's socket (§2): a JSON line out, a JSON line back.
 * `node:net` and nothing else, so the hook's import graph stays tiny and its
 * start-up cost does not land on every turn of every peer (§6.2).
 */

import { createConnection } from 'node:net'

export interface DaemonReply {
  readonly ok: boolean
  readonly message?: string
}

/** Resolve with the daemon's answer or a reason; never reject, never hang past `timeoutMs`. */
export const callDaemon = (socketPath: string, method: string, params: unknown, timeoutMs = 2000): Promise<DaemonReply> =>
  new Promise((resolve) => {
    let buffer = ''
    let settled = false
    const socket = createConnection(socketPath)
    const finish = (reply: DaemonReply): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reply)
    }
    socket.setTimeout(timeoutMs, () => finish({ ok: false, message: `no answer from the daemon within ${String(timeoutMs)} ms` }))
    socket.on('error', (error) => finish({ ok: false, message: `cannot reach the daemon at ${socketPath}: ${error.message}` }))
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'usage', method, params })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as { ok?: boolean; error?: { message?: string } }
        finish(response.ok === true ? { ok: true } : { ok: false, message: response.error?.message ?? 'the daemon refused the report' })
      } catch {
        finish({ ok: false, message: 'the daemon answered with something that is not JSON' })
      }
    })
    socket.on('close', () => finish({ ok: false, message: 'the daemon closed the connection without answering' }))
  })
