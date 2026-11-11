/** The small text helpers the watch's render and `--once` share: fitting to a width, wrapping, a clock. */

/**
 * A whole escape sequence: CSI (`\u001b[`, parameters, a final byte), OSC
 * (`\u001b]` up to the BEL or the string terminator), or one of the two-byte
 * escapes (`\u001bc` resets the terminal outright).
 */
const ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g
/** Whatever is left: C0 (a stray ESC included), DEL, and C1. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
/** Control that separates words rather than drawing anything: the break is worth keeping. */
const BREAK = /[\n\r\t\v\f]/g

/**
 * Strip the terminal control characters out of text a peer chose the bytes of.
 *
 * Everything the watch paints that a peer had a hand in — the target of its last
 * tool call, a line of its output, the question it asks, the mail it was sent,
 * even its own id — is a string the peer wrote. A terminal cannot tell a peer's
 * `\u001b[2J` from this view's own colour, so a payload there is not a garbled
 * row: it is a cleared screen, a moved cursor, a rewritten window title, a
 * clipboard write. The render is the only place that still knows which escapes
 * are its own, so it is where the two are told apart (TASK-105).
 *
 * Not `wrap`'s job alone: `--once` prints no escapes of its own and so never
 * passes through `fit` — it strips every line it builds instead.
 */
export const stripControl = (text: string): string =>
  text.replace(ESCAPE, '').replace(BREAK, ' ').replace(CONTROL, '')

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
