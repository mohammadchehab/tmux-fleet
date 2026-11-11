/** The small text helpers the watch's render and `--once` share: fitting to a width, wrapping, a clock. */

/** Cut to `width` columns, with a marker, or pad with spaces to exactly `width`. */
export const fit = (text: string, width: number): string => {
  if (width <= 0) return ''
  const chars = [...text]
  if (chars.length <= width) return text + ' '.repeat(width - chars.length)
  return width === 1 ? '…' : `${chars.slice(0, width - 1).join('')}…`
}

/** Break `text` into lines of at most `width` columns, at spaces when it can. */
export const wrap = (text: string, width: number): readonly string[] => {
  if (width <= 0) return []
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let rest = paragraph
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
