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

/** How many bytes a UTF-8 character that starts with `lead` has. */
const utf8Length = (lead: number): number => (lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1)

export const createKeyParser = (): KeyParser => {
  let mode: Mode = 'ground'
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
          if (byte === 0x5b) mode = 'csi'
          else if (byte === 0x4f) mode = 'ss3'
          else {
            // ESC then something else: the escape key, and that something on its own.
            mode = 'ground'
            out.push({ kind: 'escape' })
            ground(byte, out)
          }
          break
        case 'csi':
          // Parameters and intermediates are 0x20-0x3F; the final byte is 0x40-0x7E. Mouse, focus and
          // the rest end here unread: only the four arrows mean anything.
          if (byte >= 0x40 && byte <= 0x7e) {
            mode = 'ground'
            const key = arrow(byte)
            if (key !== undefined) out.push(key)
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
