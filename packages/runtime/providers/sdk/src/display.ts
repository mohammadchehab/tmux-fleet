/**
 * What an adapter needs to offer `Provider.display` (watch-and-attach §6): a
 * queue of display lines that costs nothing until someone reads it, and the one
 * mapping from a contract event to the line it stands for.
 *
 * The mapping is shared so both adapters agree on the rule the conformance suite
 * checks: a `turn` line for every `turn.started` and `turn.ended`, and a `tool`
 * line for every `tool.use`, carrying the redacted summary the event already has.
 * Text is the only line an adapter makes for itself, from its vendor's deltas.
 */

import type { DisplayLine, ProviderEvent } from '@fleet/foundation-contracts'

/** The line a contract event stands for, or `undefined` when it has none (questions, approvals, errors). */
export const displayLineOf = (event: { readonly type: string }): DisplayLine | undefined => {
  const typed = event as ProviderEvent
  switch (typed.type) {
    case 'turn.started':
      return { kind: 'turn', phase: 'started' }
    case 'turn.ended':
      return { kind: 'turn', phase: 'ended', reason: typed.reason }
    case 'tool.use':
      return typed.summary === undefined ? { kind: 'tool', tool: typed.tool } : { kind: 'tool', tool: typed.tool, summary: typed.summary }
    default:
      return undefined
  }
}

/** The most lines a queue holds for a reader that is not keeping up; the oldest go first. */
export const displayQueueLimit = 2_000

/**
 * Lines for one reader. Bounded, so a reader that stalls — or never comes — loses its
 * oldest lines instead of the daemon's memory; and kept from the first push, so the
 * brief turn's lines, said before the daemon starts reading, are not lost. Closing
 * ends the iteration after the lines already queued.
 */
export class DisplayQueue implements AsyncIterable<DisplayLine> {
  readonly #queued: DisplayLine[] = []
  #wake: (() => void) | undefined
  #closed = false

  push(line: DisplayLine): void {
    if (this.#closed) return
    this.#queued.push(line)
    if (this.#queued.length > displayQueueLimit) this.#queued.shift()
    this.#notify()
  }

  close(): void {
    this.#closed = true
    this.#notify()
  }

  #notify(): void {
    const wake = this.#wake
    this.#wake = undefined
    wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<DisplayLine> {
    for (;;) {
      const next = this.#queued.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.#closed) return
      await new Promise<void>((resolve) => {
        this.#wake = resolve
      })
    }
  }
}
