/** The small text helpers the watch's render and `--once` share: fitting to a width, wrapping, a clock. */

import { stripControl } from '@fleet/foundation-core'

/**
 * Where the strip lives, and why it is not here: `stripControl` is in
 * `@fleet/foundation-core`, because `fleet ls`, `fleet peek` and the watch all
 * print text a peer wrote and `apps` never import each other (§1.1). The watch
 * is the one client that also prints colours of its own, so it applies the strip
 * underneath them — in `fit` and `wrap`, which is every line the board lays
 * out — rather than to the finished line, which would take its own SGR with it
 * (TASK-105).
 */
export { stripControl }

/** Cut to `width` columns, with a marker, or pad with spaces to exactly `width`. */
export const fit = (text: string, width: number): string => {
  if (width <= 0) return ''
  const clean = stripControl(text)
  const chars = [...clean]
  if (chars.length <= width) return clean + ' '.repeat(width - chars.length)
  return width === 1 ? '…' : `${chars.slice(0, width - 1).join('')}…`
}

/** Break `text` into lines of at most `width` columns, at spaces when it can. */
export const wrap = (text: string, width: number): readonly string[] => {
  if (width <= 0) return []
  const out: string[] = []
  // A newline is the peer's own paragraph break, so it is split on first and
  // stripped per paragraph — it is the one control character `stripControl` is
  // never given the chance to eat.
  for (const paragraph of text.split('\n')) {
    let rest = stripControl(paragraph)
    if (rest === '') {
      out.push('')
      continue
    }
    while ([...rest].length > width) {
      const chars = [...rest]
      // One char past the width: a space exactly there ends the line cleanly.
      const head = chars.slice(0, width + 1).join('')
      const space = head.lastIndexOf(' ')
      const cut = space > width / 3 ? space : chars.slice(0, width).join('').length
      out.push(head.slice(0, cut).trimEnd())
      rest = rest.slice(cut).trimStart()
    }
    out.push(rest)
  }
  return out
}

/** `HH:MM` of an ISO instant, at the viewer's offset from UTC in minutes (the IO layer supplies it, so this stays pure). */
export const clock = (iso: string, offsetMinutes: number): string => {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return '--:--'
  const shifted = new Date(at + offsetMinutes * 60_000)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(shifted.getUTCHours())}:${two(shifted.getUTCMinutes())}`
}
