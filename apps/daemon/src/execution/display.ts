/**
 * The display feed (watch-and-attach §6): what each peer said and did, kept in
 * memory for `fleet watch`, and never in the event store.
 *
 * Display data, not facts. Nothing decides on it, replay does not need it, and the
 * log must not grow with prose — so a restart empties it and that is correct.
 *
 * Three limits keep it from becoming a way to hurt the daemon, whatever a peer
 * prints:
 *
 * - a line is cut to `displayLineMaxChars` before it is buffered, so a peer that
 *   prints a large file cannot grow the ring or a socket payload;
 * - each peer has a ring of the last `perPeer` lines (default 500), and the
 *   store-derived rows a small ring of their own;
 * - a subscriber that falls `maxQueued` frames behind is dropped, never waited for.
 *
 * Text arrives as deltas of a few characters. They are gathered per peer and
 * flushed as one line at a newline, at the width budget, at the next tool or turn
 * line, or after `flushMs` — so a ring slot is a line a person would read, and a
 * delta does not cost a frame.
 */

import type { PeerId } from '@fleet/foundation-core'
import {
  daemonProtocolVersion,
  displayLineMaxChars,
  type DisplayLine,
  type WatchEndReason,
  type WatchFrame,
  type WatchParams,
  type WatchRow,
} from '@fleet/foundation-contracts'

export const defaultPerPeer = 500
export const defaultRowRing = 200
export const defaultMaxQueued = 2_000
export const defaultFlushMs = 100

type LineFrame = Extract<WatchFrame, { stream: 'line' }>
type RowFrame = Extract<WatchFrame, { stream: 'row' }>
type Entry = LineFrame | RowFrame

export interface DisplayFeedOptions {
  readonly perPeer?: number
  readonly rows?: number
  readonly maxQueued?: number
  readonly flushMs?: number
  readonly now?: () => string
}

export interface Watcher extends AsyncIterable<WatchFrame> {
  /** End the stream; the iterator finishes after what it already holds. Idempotent. */
  close(reason?: WatchEndReason): void
}

export interface DisplayFeed {
  /** One display line from a peer. Text is gathered into lines; everything else is cut and buffered at once. */
  push(peerId: PeerId, line: DisplayLine): void
  /** A fact from the store, in the order it was committed. */
  row(row: WatchRow): void
  /** Flush every peer's gathered text now (a turn ending does this itself). */
  flush(): void
  /** The newest seq, and the oldest one still held (`from`); both 0 when nothing has been pushed. */
  readonly seq: number
  readonly from: number
  /**
   * The buffered history, then live frames, as one stream: the replay for `since`
   * and `peerId`, a `ready` marker, then each new entry until closed or dropped.
   */
  watch(params: WatchParams): Watcher
  /** End every watcher (the daemon is going down). */
  closeAll(reason: WatchEndReason): void
}

/** Cut to the width budget; the marker is the one character the schema leaves room for. */
export const cut = (text: string): string =>
  text.length <= displayLineMaxChars ? text : `${text.slice(0, displayLineMaxChars)}…`

const cutLine = (line: DisplayLine): DisplayLine => {
  if (line.kind === 'text') return { kind: 'text', text: cut(line.text) }
  if (line.kind === 'tool') return line.summary === undefined ? line : { ...line, summary: cut(line.summary) }
  return line
}

export const createDisplayFeed = (options: DisplayFeedOptions = {}): DisplayFeed => {
  const perPeer = options.perPeer ?? defaultPerPeer
  const rowRing = options.rows ?? defaultRowRing
  const maxQueued = options.maxQueued ?? defaultMaxQueued
  const flushMs = options.flushMs ?? defaultFlushMs
  const now = options.now ?? (() => new Date().toISOString())

  let seq = 0
  const rings = new Map<PeerId, LineFrame[]>()
  const rows: RowFrame[] = []
  const gathered = new Map<PeerId, { text: string; timer: NodeJS.Timeout | undefined }>()
  const watchers = new Set<{ readonly peerId: PeerId | undefined; readonly offer: (entry: Entry) => void; readonly close: (reason: WatchEndReason) => void }>()

  const oldest = (): number => {
    let from = 0
    for (const ring of rings.values()) if (ring[0] !== undefined && (from === 0 || ring[0].seq < from)) from = ring[0].seq
    if (rows[0] !== undefined && (from === 0 || rows[0].seq < from)) from = rows[0].seq
    return from
  }

  const publish = (entry: Entry): void => {
    for (const watcher of watchers) watcher.offer(entry)
  }

  const store = (peerId: PeerId, line: DisplayLine): void => {
    seq += 1
    const entry: LineFrame = { stream: 'line', seq, at: now(), peerId, line: cutLine(line) }
    let ring = rings.get(peerId)
    if (ring === undefined) rings.set(peerId, (ring = []))
    ring.push(entry)
    if (ring.length > perPeer) ring.shift()
    publish(entry)
  }

  const flushPeer = (peerId: PeerId): void => {
    const pending = gathered.get(peerId)
    if (pending === undefined) return
    gathered.delete(peerId)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    if (pending.text.length > 0) store(peerId, { kind: 'text', text: pending.text })
  }

  /** The most lines one push may make; the rest of a flood is counted, not shown, so a peer cannot kick every watcher by printing a file. */
  const maxLinesPerPush = 50

  const gather = (peerId: PeerId, text: string): void => {
    let pending = gathered.get(peerId)
    if (pending === undefined) gathered.set(peerId, (pending = { text: '', timer: undefined }))
    pending.text += text
    let emitted = 0
    // Whole lines go out at once; what is left waits for its newline, its budget or its timer.
    for (;;) {
      const newline = pending.text.indexOf('\n')
      if (newline === -1 && pending.text.length < displayLineMaxChars) break
      if (emitted === maxLinesPerPush) {
        const skipped = pending.text.length
        pending.text = ''
        store(peerId, { kind: 'text', text: `… ${String(skipped)} more characters not shown` })
        break
      }
      const split = newline !== -1 && newline <= displayLineMaxChars
      const end = split ? newline : displayLineMaxChars
      const head = pending.text.slice(0, end)
      pending.text = pending.text.slice(split ? end + 1 : end)
      if (head.length > 0) {
        store(peerId, { kind: 'text', text: head })
        emitted += 1
      }
    }
    if (pending.text.length === 0) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      gathered.delete(peerId)
      return
    }
    pending.timer ??= setTimeout(() => flushPeer(peerId), flushMs).unref()
  }

  const feed: DisplayFeed = {
    push(peerId, line) {
      if (line.kind === 'text') {
        gather(peerId, line.text)
        return
      }
      // A tool or a turn boundary ends the sentence before it.
      flushPeer(peerId)
      store(peerId, line)
    },

    row(row) {
      seq += 1
      const entry: RowFrame = { stream: 'row', seq, at: now(), row }
      rows.push(entry)
      if (rows.length > rowRing) rows.shift()
      publish(entry)
    },

    flush() {
      for (const peerId of [...gathered.keys()]) flushPeer(peerId)
    },

    get seq() {
      return seq
    },

    get from() {
      return oldest()
    },

    watch(params) {
      const queue: WatchFrame[] = []
      let wake: (() => void) | undefined
      /** Why the stream ends; set once. The `end` frame is delivered after everything already queued. */
      let ending: WatchEndReason | undefined
      /** The `end` frame has been delivered: the iterator is finished. */
      let done = false
      const notify = (): void => {
        const resume = wake
        wake = undefined
        resume?.()
      }
      const finish = (reason: WatchEndReason): void => {
        if (ending !== undefined) return
        ending = reason
        watchers.delete(watcher)
        notify()
      }
      const wanted = (entry: Entry): boolean => entry.stream === 'row' || params.peerId === undefined || entry.peerId === params.peerId
      const watcher = {
        peerId: params.peerId,
        offer: (entry: Entry): void => {
          if (ending !== undefined || !wanted(entry)) return
          // The client is not keeping up: it is dropped, so it can never slow a peer or grow the daemon.
          if (queue.length >= maxQueued) {
            queue.length = 0
            finish('dropped')
            return
          }
          queue.push(entry)
          notify()
        },
        close: finish,
      }

      // The history first, in seq order, then `ready`; registered in the same tick, so nothing falls between.
      const since = params.since ?? 0
      const history: Entry[] = []
      for (const [peerId, ring] of rings) {
        if (params.peerId !== undefined && peerId !== params.peerId) continue
        for (const entry of ring) if (entry.seq > since) history.push(entry)
      }
      for (const entry of rows) if (entry.seq > since) history.push(entry)
      history.sort((a, b) => a.seq - b.seq)
      queue.push(...history, { stream: 'ready', seq, from: oldest(), protocolVersion: daemonProtocolVersion })
      watchers.add(watcher)

      return {
        close: finish,
        [Symbol.asyncIterator]: (): AsyncIterator<WatchFrame> => ({
          next: async (): Promise<IteratorResult<WatchFrame>> => {
            for (;;) {
              const next = queue.shift()
              if (next !== undefined) return { value: next, done: false }
              if (done) return { value: undefined, done: true }
              if (ending !== undefined) {
                done = true
                return { value: { stream: 'end', reason: ending }, done: false }
              }
              await new Promise<void>((resolve) => {
                wake = resolve
              })
            }
          },
          return: async (): Promise<IteratorResult<WatchFrame>> => {
            done = true
            finish('closed')
            return { value: undefined, done: true }
          },
        }),
      }
    },

    closeAll(reason) {
      for (const watcher of [...watchers]) watcher.close(reason)
    },
  }
  return feed
}
