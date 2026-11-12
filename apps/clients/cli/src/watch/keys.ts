/**
 * Terminal input, byte by byte (watch-and-attach §7): a terminal can deliver
 * several keys in one chunk (a paste, a key held down, an arrow and the next
 * letter), so a chunk is never one key.
 *
 * Pure: bytes in, keys out, with the half of an escape sequence that has not
 * arrived kept for the next chunk. A lone ESC is ambiguous with the start of a
 * sequence, so it stays pending until `flush()`, which the caller runs after a
 * short pause; a terminal sends the rest of a sequence in the same write.
 */

export type Key =
  | { readonly kind: 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'backspace' | 'tab' | 'ctrl-c' | 'ctrl-d' }
  /** The mouse wheel (SGR reporting) and PageUp/PageDown: they scroll the detail pane, never the selection. */
  | { readonly kind: 'scroll-up' | 'scroll-down' | 'page-up' | 'page-down' }
  | { readonly kind: 'char'; readonly char: string }

export interface KeyParser {
  feed(chunk: Uint8Array | string): readonly Key[]
  /** A lone ESC that nothing followed is the escape key. */
  flush(): readonly Key[]
  /** True when a lone ESC (or half a sequence) is waiting for more. */
  readonly pending: boolean
}

type Mode = 'ground' | 'esc' | 'csi' | 'ss3'

const arrow = (final: number): Key | undefined => {
  switch (String.fromCharCode(final)) {
    case 'A':
      return { kind: 'up' }
    case 'B':
      return { kind: 'down' }
    case 'C':
      return { kind: 'right' }
    case 'D':
      return { kind: 'left' }
    default:
      return undefined
  }
}

/**
 * A CSI sequence that is not an arrow: SGR mouse (`ESC [ < b ; x ; y M`), where
 * 64 and 65 are the wheel, and `ESC [ 5 ~` / `ESC [ 6 ~` for PageUp/PageDown.
 * Clicks, drags and the rest are read and dropped.
 */
const csiKey = (params: string, final: number): Key | undefined => {
  const end = String.fromCharCode(final)
  if (params.startsWith('<') && end === 'M') {
    const button = Number(params.slice(1).split(';')[0])
    if (button === 64) return { kind: 'scroll-up' }
    if (button === 65) return { kind: 'scroll-down' }
    return undefined
  }
  if (end === '~') {
    if (params === '5') return { kind: 'page-up' }
    if (params === '6') return { kind: 'page-down' }
    return undefined
  }
  return params === '' || params === '1' ? arrow(final) : undefined
}

/** How many bytes a UTF-8 character that starts with `lead` has. */
const utf8Length = (lead: number): number => (lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1)

export const createKeyParser = (): KeyParser => {
  let mode: Mode = 'ground'
  let params = ''
  let utf8: number[] = []
  let want = 0

  const ground = (byte: number, out: Key[]): void => {
    if (utf8.length > 0) {
      utf8.push(byte)
      if (utf8.length === want) {
        out.push({ kind: 'char', char: Buffer.from(utf8).toString('utf8') })
        utf8 = []
        want = 0
      }
      return
    }
    switch (byte) {
      case 0x1b:
        mode = 'esc'
        return
      case 0x0d:
      case 0x0a:
        out.push({ kind: 'enter' })
        return
      case 0x7f:
      case 0x08:
        out.push({ kind: 'backspace' })
        return
      case 0x09:
        out.push({ kind: 'tab' })
        return
      case 0x03:
        out.push({ kind: 'ctrl-c' })
        return
      case 0x04:
        out.push({ kind: 'ctrl-d' })
        return
      default:
        if (byte < 0x20) return // other control characters are nobody's key
        if (byte < 0x80) {
          out.push({ kind: 'char', char: String.fromCharCode(byte) })
          return
        }
        utf8 = [byte]
        want = utf8Length(byte)
        if (want === 1) utf8 = [] // a stray continuation byte
    }
  }

  const feed = (chunk: Uint8Array | string): readonly Key[] => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const out: Key[] = []
    for (const byte of bytes) {
      switch (mode) {
        case 'ground':
          ground(byte, out)
          break
        case 'esc':
          if (byte === 0x5b) {
            mode = 'csi'
            params = ''
          }
          else if (byte === 0x4f) mode = 'ss3'
          else {
            // ESC then something else: the escape key, and that something on its own.
            mode = 'ground'
            out.push({ kind: 'escape' })
            ground(byte, out)
          }
          break
        case 'csi':
          // Parameters and intermediates are 0x20-0x3F; the final byte is 0x40-0x7E. The arrows, the
          // wheel and PageUp/PageDown mean something (`csiKey`); focus and the rest end here unread.
          if (byte >= 0x40 && byte <= 0x7e) {
            mode = 'ground'
            const key = csiKey(params, byte)
            if (key !== undefined) out.push(key)
          } else {
            params += String.fromCharCode(byte)
          }
          break
        case 'ss3': {
          mode = 'ground'
          const key = arrow(byte)
          if (key !== undefined) out.push(key)
          break
        }
      }
    }
    return out
  }

  return {
    feed,
    flush() {
      if (mode === 'esc') {
        mode = 'ground'
        return [{ kind: 'escape' }]
      }
      mode = 'ground'
      return []
    },
    get pending() {
      return mode !== 'ground'
    },
  }
}
