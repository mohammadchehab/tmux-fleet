/**
 * Secrets, removed from text that is about to leave the machine.
 *
 * It lives in `foundation` because the caller is in `orchestration`:
 * `tracker-sync` redacts a peer's note before a board that may be a customer's
 * reads it, and it may not reach into another group for the helper (§1.1).
 *
 * This is **not** the log's redaction. The event stream decides what may be
 * stored by allowlist — a tool call contributes a file path or nothing at all —
 * because a pattern is a guess about where a secret sits (`@fleet/runtime-
 * provider-claude`'s `TARGET_TOOL_NAMES` says why). A note is different: it has
 * to be sent somewhere, so the choice is between a guess and sending it whole,
 * and a guess that removes too much is the one that fails safe.
 *
 * `[REDACTED]` is deliberately visible — a reader who sees it knows the text was
 * cut, rather than reading a silently shortened line as the whole one.
 *
 * Two things keep "too much" from becoming "everything". The rules are ordered
 * widest-span first, so a PEM block or a connection string goes whole before a
 * narrower rule could leave a piece behind. And a name is matched by its
 * segments, not its letters: `GITHUB_TOKEN` and `client_secret` are credentials,
 * while `inputTokens: 0` is a count — a redactor that turns a note's code into
 * rubble is one whose output nobody can read.
 */

const MARK = '[REDACTED]'

/** Already redacted, so the rules below can run over each other's output. */
const NOT_YET = `(?!\\${MARK})`

/** Header names whose value is a credential; `Content-Type` is not one. */
const HEADER = '(?:proxy-authorization|authorization|x-api-key|api-key|x-auth-token|x-amz-security-token|cookie)'

/** The segment of a name that makes its value a secret: `API_KEY`, `token`, `client_secret`, … */
const NAME = '(?:api[_-]?key|access[_-]?key|private[_-]?key|secret[_-]?key|client[_-]?secret|secret|token|passw(?:or)?d|pwd|credential|auth)'

/**
 * A name that *is* a credential, in one piece: the keyword as a whole segment,
 * so `GITHUB_TOKEN` and `X-Api-Key` match and `inputTokens` and `tokenRow` do not.
 *
 * The surrounding segments are counted rather than starred. An unbounded `*` over
 * a run of `a_` has one way to match for every split, and text a note contains
 * would then cost the caller quadratically — a name with more than a few segments
 * is not a name.
 */
const NAME_EXPR = `(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_-]){0,6}${NAME}(?:[_-][A-Za-z0-9]+){0,6}(?![A-Za-z0-9])`

/** A parameter or flag name, where a bare `key` or `sig` is one by definition. */
const PARAM = '(?:api[_-]?key|apikey|key|token|secret|passw(?:or)?d|pwd|auth|sig|signature|credential)'

/**
 * `--api-key`, `?access_token`, `client_secret`: the same segment test, delimited by
 * `--` or `?`. A segment is alphanumeric and the `_`/`-` are the delimiters — letting
 * both match the delimiter leaves the engine two ways to read a run of dashes, which
 * is exponential backtracking on text a note can contain.
 */
const PARAM_EXPR = `(?:[A-Za-z0-9]+[_-]){0,6}${PARAM}(?:[_-][A-Za-z0-9]+){0,6}`

/** `sk-…`, `ghp_…`, `glpat-…`: a vendor prefix is the key's own name for itself. */
const VENDOR = '\\b(?:sk|rk|pk|whsec)[-_][A-Za-z0-9_-]{8,}|\\b(?:ghp|gho|ghu|ghs|ghr|glpat|glrt|xox[baprs])[-_][A-Za-z0-9_-]{8,}'

/** An AWS access key id: the prefix and sixteen upper-case alphanumerics. */
const AWS = '\\b(?:AKIA|ASIA|A3T[A-Z0-9])[A-Z0-9]{16}\\b'

/** A JSON Web Token: three base64url segments, which is nobody's prose. */
const JWT = '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}'

/**
 * The prefix of an assignment, up to and including the separator: the name a
 * credential goes by, and the `:`/`=` that makes what follows its value.
 */
const ASSIGN = `(${NAME_EXPR}["']?\\s*(?<![=!<>])[:=](?![=>])\\s*)${NOT_YET}`

/**
 * Every `BEGIN … END` block becomes one mark, and an unterminated block takes the
 * rest of the text with it — the header alone is proof of what follows.
 *
 * A scan, not a pattern: `-----BEGIN[^\n]*-----[\s\S]*?-----END` backtracks
 * quadratically on a long run of dashes, and a note's content must not be able
 * to make the daemon's redaction hang.
 */
const redactPemBlocks = (text: string): string => {
  const lines = text.split('\n')
  const kept: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!line.includes('-----BEGIN')) {
      kept.push(line)
      continue
    }
    // The block ends at its own footer; without one it runs to the end of the text.
    let end = index
    while (end < lines.length && !(lines[end] ?? '').includes('-----END')) end += 1
    kept.push(MARK)
    index = end
  }
  return kept.join('\n')
}

const RULES: readonly (readonly [RegExp, string])[] = [
  // `postgres://user:password@host` — the password is the part between the colons.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]*@/gi, `$1${MARK}@`],

  // A quoted header, the way `curl -H '…'` carries it: the name stays, the value goes.
  [new RegExp(`(-H\\s+)(['"])(${HEADER}\\s*:\\s*)[^'"]*\\2`, 'gi'), `$1$2$3${MARK}$2`],
  // The same header with no `-H` and no quotes, as a note would quote it. It runs to
  // the end of the line: what follows a credential on that line is suspect too.
  [new RegExp(`(^|[^'"\\w-])(${HEADER}\\s*:\\s*)${NOT_YET}[^\\n]*`, 'gim'), `$1$2${MARK}`],

  // `API_KEY=…`, `export GITHUB_TOKEN=…`, `token: …`, `{"password":"…"}` — an
  // assignment names its value, whatever quotes it wears. The quoted spellings go
  // first so the delimiter survives: without it a reader cannot tell that
  // `{"password":"…"}` was ever JSON. A comparison is not an assignment
  // (`token === ''`) and a value that opens a bracket is code, not a credential,
  // so the note keeps its snippets.
  [new RegExp(`${ASSIGN}"[^"\\n]*"`, 'gi'), `$1"${MARK}"`],
  [new RegExp(`${ASSIGN}'[^'\\n]*'`, 'gi'), `$1'${MARK}'`],
  [new RegExp(`${ASSIGN}\`[^\`\\n]*\``, 'gi'), `$1\`${MARK}\``],
  [new RegExp(`${ASSIGN}(?![\\s"'\`])[^\\s,;&()\\[\\]{}<>]+`, 'gi'), `$1${MARK}`],

  // `--token=…` and `--token …`: a flag's value, in both spellings.
  [new RegExp(`(--${PARAM_EXPR}=)${NOT_YET}[^\\s&]+`, 'gi'), `$1${MARK}`],
  [new RegExp(`(--${PARAM_EXPR}\\s+)${NOT_YET}[^\\s-]\\S*`, 'gi'), `$1${MARK}`],

  // `?access_token=…`: the parameter's name says what its value is, so a compound
  // name (`client_secret`, `access_token`) is the shape to catch, not `key` alone.
  [new RegExp(`([?&]${PARAM_EXPR}=)${NOT_YET}[^&\\s]+`, 'gi'), `$1${MARK}`],

  // A key that announces itself, wherever it sits.
  [new RegExp(VENDOR, 'g'), MARK],
  [new RegExp(AWS, 'g'), MARK],
  [new RegExp(JWT, 'g'), MARK],
]

/**
 * Remove common secret patterns from strings: env lines, auth headers, vendor
 * keys, PEM blocks, connection strings, `--flag` values and secret query
 * parameters. Too much is the safe direction — see the note above.
 */
export const redactSecrets = (value: string): string =>
  RULES.reduce<string>((text, [pattern, replacement]) => text.replace(pattern, replacement), redactPemBlocks(value))

/**
 * Remove secret query parameters from URLs (api_key, token, auth, etc).
 */
export const redactUrlSecrets = (url: string): string => {
  try {
    const parsed = new URL(url)
    // The same names `redactSecrets` reads, so a parameter one rule calls secret
    // the other does too.
    let hasRedaction = false
    for (const name of [...parsed.searchParams.keys()]) {
      if (new RegExp(`^${PARAM_EXPR}$`, 'i').test(name)) {
        parsed.searchParams.set(name, MARK)
        hasRedaction = true
      }
    }
    // If no secret params were found, return original URL to preserve formatting
    if (!hasRedaction) return url
    return parsed.toString()
  } catch {
    // If URL parsing fails, redact known patterns as fallback
    return redactSecrets(url)
  }
}
