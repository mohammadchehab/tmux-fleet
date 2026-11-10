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
 */

/**
 * Remove common secret patterns from strings (API keys, tokens, passwords).
 * Matches patterns like `-H 'Authorization: Bearer token'`, `api_key=secret`, etc.
 */
export const redactSecrets = (value: string): string => {
  // Remove Authorization headers and API keys/tokens in various formats
  // Matches: -H 'Authorization: ...', --api-key=..., api_key=..., etc.
  return value
    .replace(/-H\s+['"][Aa]uthorization:\s*Bearer\s+[^'"]+['"]/g, "-H 'Authorization: [REDACTED]'")
    .replace(/-H\s+['"][Aa]uthorization:\s*[^'"]+['"]/g, "-H 'Authorization: [REDACTED]'")
    .replace(/([?&]|--)(api[_-]?key|key|token|auth|secret|password|pwd)\s*=\s*[^&\s]+/gi, '$1$2=[REDACTED]')
    .replace(/(["'])(.*?\1)/g, (match) => {
      // Redact bearer tokens and similar patterns inside quotes
      if (/^["']?Bearer\s+\S+["']?$/.test(match) || /^["']?sk_\w+["']?$/.test(match)) {
        return match.charAt(0) + '[REDACTED]' + match.charAt(0)
      }
      return match
    })
}

/**
 * Remove secret query parameters from URLs (api_key, token, auth, etc).
 */
export const redactUrlSecrets = (url: string): string => {
  try {
    const parsed = new URL(url)
    const secretParams = ['api_key', 'key', 'token', 'auth', 'secret', 'password', 'pwd', 'api', 'bearer']
    let hasRedaction = false
    for (const param of secretParams) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '[REDACTED]')
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
