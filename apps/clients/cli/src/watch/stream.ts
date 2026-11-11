/**
 * The watch's one long connection: `peer.watch` over the daemon's socket
 * (watch-and-attach §6). A request line out, then frames until the daemon or
 * this side closes. It is not `callDaemon`: that is one line in, one line back.
 *
 * Frames are checked with the contract's own schema; a line that is not one ends
 * the stream (`closed`) rather than being painted, because a daemon that has
 * drifted from the contract should be loud, not half-rendered.
 */

import { createConnection } from 'node:net'

import { parseStrict } from '@fleet/foundation-core'
import { watchFrame, type WatchFrame } from '@fleet/foundation-contracts'

export interface WatchHandle {
  readonly close: () => void
}

export type OpenWatch = (options: {
  readonly socketPath: string
  readonly since?: number
  readonly onFrame: (frame: WatchFrame) => void
  /** Once, when the stream is over for any reason; `error` names a transport failure. */
  readonly onClose: (error?: Error) => void
}) => WatchHandle

export const openWatch: OpenWatch = ({ socketPath, since, onFrame, onClose }) => {
  const socket = createConnection(socketPath)
  socket.setEncoding('utf8')
  let buffer = ''
  let done = false
  const finish = (error?: Error): void => {
    if (done) return
    done = true
    socket.destroy()
    onClose(error)
  }
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ id: 'watch', method: 'peer.watch', params: since === undefined ? {} : { since } })}\n`)
  })
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line === '') continue
      try {
        onFrame(parseStrict(watchFrame(), JSON.parse(line)))
      } catch (thrown) {
        finish(thrown instanceof Error ? thrown : new Error(String(thrown)))
        return
      }
    }
  })
  socket.on('error', (error) => finish(error))
  socket.on('close', () => finish())
  return { close: () => finish() }
}
