/**
 * Quoting one argument so a POSIX shell hands it back unchanged.
 *
 * The fleet builds a single command string (the pane command) out of flags, paths,
 * session names and model ids, and tmux gives that string to the user's default shell
 * (`zsh` on macOS, `sh` elsewhere). Every one of those values must survive that trip
 * byte for byte, so this mirrors bash's `printf '%q'`, which is what the shell scripts
 * used. It is pure: the round-trip proof lives in tests/unit/shell-quote.test.ts, which
 * runs real bash and zsh rather than re-implementing a parser.
 */

/** Characters a shell would give a meaning of its own, so they get a backslash. */
const SPECIAL = new Set([..." \"'\\`$&;|<>()*?[]{}#!"]);

/** Short escapes bash uses inside `$'…'`; every other control char becomes octal. */
const SHORT_ESCAPE = new Map<number, string>([
  [0x07, "\\a"],
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0b, "\\v"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x1b, "\\E"],
]);

/**
 * A string is only safe to quote with backslashes while it holds no control
 * characters: those have no printable spelling, so bash switches to `$'…'` for
 * them and so do we.
 */
function needsAnsiC(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
    if (code >= 0x80 && code <= 0x9f) return true;
    // Unicode line/paragraph separators: a shell would see a newline inside the word.
    if (code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/** Octal spelling of one code point's UTF-8 bytes, as bash does it (`\302\200`). */
function octalBytes(char: string): string {
  return [...new TextEncoder().encode(char)]
    .map((byte) => `\\${byte.toString(8).padStart(3, "0")}`)
    .join("");
}

/** `$'…'`: the fallback for values holding control characters. */
function ansiQuote(value: string): string {
  let out = "$'";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const short = SHORT_ESCAPE.get(code);
    if (short !== undefined) {
      out += short;
    } else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += code < 0x80 ? `\\${code.toString(8).padStart(3, "0")}` : octalBytes(char);
    } else if (char === "\\" || char === "'") {
      // The only two printable characters with a meaning inside $'…': everything
      // else is literal there, so `*` or `[` must stay bare (a stray backslash
      // before them survives into the value).
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return `${out}'`;
}

/**
 * Quote `value` for a shell.
 *
 * The result is a single word that expands back to exactly `value`. An empty
 * value becomes `''` (an unquoted empty word would vanish), a value holding
 * control characters uses `$'…'` (read by bash and zsh; a strict POSIX `sh` does
 * not, but no fleet value — session name, path, model id, role prompt — carries
 * one), and a leading `~` or `=` is escaped: zsh expands a word beginning with `=`
 * as a command path, so an unescaped `=fleet-a-engineer:` would be looked up on
 * PATH and the pane would die at once.
 */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (needsAnsiC(value)) return ansiQuote(value);

  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    const leading = index === 0 && (char === "~" || char === "=");
    if (SPECIAL.has(char) || leading) out += `\\${char}`;
    else out += char;
  }
  return out;
}
