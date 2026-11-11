/**
 * Terminal control characters, removed from text a peer chose the bytes of.
 *
 * A terminal cannot tell a peer's `\u001b[2J` from a client's own colour, so a
 * payload in a tool target is not a garbled row: it is a cleared screen, a moved
 * cursor, a rewritten window title, a clipboard write. Every client prints at
 * least one such string — `lastTarget` is the model's own `file_path`, a message
 * body is what a peer wrote — and none of them can strip it themselves, because
 * `apps` never import each other (§1.1). So the helper is here, in `foundation`,
 * where every client may reach it.
 *
 * The sequences are removed whole rather than cut at the escape byte: taking the
 * `\u001b` and leaving `[2J` behind is the same screen with the sequence spelled
 * out in letters.
 */

/**
 * A whole escape sequence: CSI (`\u001b[`, parameters, a final byte), OSC
 * (`\u001b]` up to the BEL or the string terminator), or any other one, ESC and
 * the byte after it — which is enough for `\u001bc` (a full terminal reset),
 * `\u001b#8` and the rest of the multi-byte forms, whose remaining tail is plain
 * ASCII and prints as nothing once the escape that gave it meaning is gone.
 */
const ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[ -~])/g

/** Whatever is left: C0 (a stray ESC included), DEL, and C1. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/** Control that separates words rather than drawing anything: the break is worth keeping. */
const BREAK = /[\n\r\t\v\f]/g

/**
 * Strip the terminal control characters out of a string a peer wrote.
 *
 * A newline, tab or carriage return becomes a space rather than vanishing: it
 * separates words, and dropping it outright would run two sentences together —
 * a worse transcript than the one with a space where the break was. Everything
 * else in C0 and C1, and DEL, is removed (TASK-100, TASK-105).
 */
export const stripControl = (text: string): string =>
  text.replace(ESCAPE, '').replace(BREAK, ' ').replace(CONTROL, '')
