/**
 * §5's live output: one read-only channel per peer, fed from `peer.watch`.
 *
 * One stream for the window, opened when the first channel is, carrying every
 * peer: the daemon replays its ring on connect, so a channel opened now starts
 * with what the peer has been doing, not with a blank page. Lines for a peer
 * whose channel is not open are kept (bounded) so opening it later shows them.
 *
 * Lines are prefixed as the watch prefixes them (§5): `✉` mail with what it
 * said, `⚙` a tool, `—` a turn boundary, and the peer's own words as they are.
 * A channel is plain text; the editor's `log` language gives the colour there is.
 *
 * When the stream ends without this side closing it, it reconnects from the last
 * seq it saw, so a daemon restart costs a gap of a few seconds and no repeats.
 */

import type { DisplayLine, WatchFrame } from '@fleet/foundation-contracts'

import type { Disposable, OutputLike } from './port.ts'

/** Lines kept per peer whose channel is not open yet: the daemon's own ring is the history. */
export const backlogLimit = 1_000

/** How long a dropped stream waits before it tries again. */
export const reconnectMs = 3_000

export type OpenWatch = (options: {
  readonly socketPath: string
  readonly since?: number
  readonly onFrame: (frame: WatchFrame) => void
  /** Once, when the stream is over for any reason. */
  readonly onClose: (error?: Error) => void
}) => { readonly close: () => void }

const lineText = (line: DisplayLine): readonly string[] => {
  switch (line.kind) {
    case 'text':
      return line.text.split('\n')
    case 'tool':
      return [`⚙ ${line.tool}${line.summary === undefined ? '' : ` ${line.summary}`}`]
    case 'turn':
      return [line.phase === 'started' ? '— turn started —' : `— turn ended${line.reason === undefined ? '' : ` (${line.reason})`} —`]
  }
}

/** What one frame adds to which peer's channel; `undefined` when it is nobody's output. */
export const linesOf = (frame: WatchFrame): { readonly peerId: string; readonly lines: readonly string[] } | undefined => {
  if (frame.stream === 'line') return { peerId: frame.peerId, lines: lineText(frame.line) }
  if (frame.stream !== 'row' || frame.row.kind !== 'mail') return undefined
  const row = frame.row
  if (row.phase === 'delivered') return { peerId: row.to, lines: ['  ✓ delivered'] }
  const head = `✉ ${row.mailKind ?? 'mail'}${row.from === undefined ? '' : ` from ${row.from}`}`
  const body = (row.text ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => `  ${line}`)
  return { peerId: row.to, lines: [head, ...body] }
}

export interface PeerOutputsDeps {
  readonly createOutput: (name: string) => OutputLike
  readonly openWatch: OpenWatch
  /** The socket the window is connected to now, or `undefined` when it is not. */
  readonly socketPath: () => string | undefined
  readonly log: (line: string) => void
  readonly setTimer?: (run: () => void, ms: number) => Disposable
}

const defaultTimer = (run: () => void, ms: number): Disposable => {
  const timer = setTimeout(run, ms)
  return { dispose: () => clearTimeout(timer) }
}

export class PeerOutputs implements Disposable {
  readonly #deps: PeerOutputsDeps
  readonly #channels = new Map<string, OutputLike>()
  readonly #backlog = new Map<string, string[]>()
  #stream: { readonly close: () => void; readonly socketPath: string } | undefined
  #retry: Disposable | undefined
  #lastSeq: number | undefined
  #disposed = false

  constructor(deps: PeerOutputsDeps) {
    this.#deps = deps
  }

  /** Open (or bring forward) a peer's channel, and make sure the stream that feeds it is running. */
  show(peerId: string): void {
    if (this.#disposed) return
    let channel = this.#channels.get(peerId)
    if (channel === undefined) {
      channel = this.#deps.createOutput(`Fleet: ${peerId}`)
      this.#channels.set(peerId, channel)
      for (const line of this.#backlog.get(peerId) ?? []) channel.append(line)
      this.#backlog.delete(peerId)
    }
    channel.show()
    this.#ensureStream()
  }

  /** The window moved to another daemon: the old stream's seqs mean nothing there. */
  socketChanged(): void {
    const now = this.#deps.socketPath()
    if (this.#stream !== undefined && this.#stream.socketPath !== now) {
      this.#closeStream()
      this.#lastSeq = undefined
    }
    if (this.#channels.size > 0) this.#ensureStream()
  }

  dispose(): void {
    this.#disposed = true
    this.#closeStream()
    for (const channel of this.#channels.values()) channel.dispose()
    this.#channels.clear()
    this.#backlog.clear()
  }

  #ensureStream(): void {
    if (this.#disposed || this.#stream !== undefined || this.#retry !== undefined) return
    const socketPath = this.#deps.socketPath()
    if (socketPath === undefined) return
    let handle: { readonly close: () => void } | undefined
    let closedByUs = false
    const stream = {
      socketPath,
      close: () => {
        closedByUs = true
        handle?.close()
      },
    }
    this.#stream = stream
    handle = this.#deps.openWatch({
      socketPath,
      ...(this.#lastSeq === undefined ? {} : { since: this.#lastSeq }),
      onFrame: (frame) => this.#onFrame(frame),
      onClose: (error) => {
        if (this.#stream === stream) this.#stream = undefined
        if (closedByUs || this.#disposed) return
        if (error !== undefined) this.#deps.log(`watch stream closed: ${error.message}`)
        this.#retry = (this.#deps.setTimer ?? defaultTimer)(() => {
          this.#retry = undefined
          this.#ensureStream()
        }, reconnectMs)
      },
    })
  }

  #closeStream(): void {
    this.#retry?.dispose()
    this.#retry = undefined
    const stream = this.#stream
    this.#stream = undefined
    stream?.close()
  }

  #onFrame(frame: WatchFrame): void {
    if ('seq' in frame) this.#lastSeq = Math.max(this.#lastSeq ?? 0, frame.seq)
    const out = linesOf(frame)
    if (out === undefined) return
    const channel = this.#channels.get(out.peerId)
    if (channel !== undefined) {
      for (const line of out.lines) channel.append(line)
      return
    }
    const kept = this.#backlog.get(out.peerId) ?? []
    kept.push(...out.lines)
    if (kept.length > backlogLimit) kept.splice(0, kept.length - backlogLimit)
    this.#backlog.set(out.peerId, kept)
  }
}
