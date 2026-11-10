/**
 * A finding's identity (§6.2): `fingerprint = hash(ruleId + path + normalized
 * snippet)`, and an id derived from it.
 *
 * The fingerprint exists to survive what a scanner is bad at: line numbers move
 * with every edit, so a finding keyed on `file:line` is a new finding every
 * time someone touches the file above it. Hashing the *rule*, the *path* and
 * the *cited code* instead means a re-run that sees the same sink in the same
 * place appends `finding.seen`, while the same rule on a different path is a
 * different finding — which is what a human means by "the same issue".
 *
 * Normalization is whitespace only: re-indenting or re-wrapping a snippet must
 * not launder a known finding, and anything more aggressive (stripping
 * identifiers, say) would merge findings that are not the same. A scanner that
 * gives no snippet is not penalized — its message is the cited text, so two
 * different messages of the same rule in one file stay two findings.
 */

import { deriveId, shortHash, type FindingId } from '@fleet/foundation-core'
import type { RawFinding } from './scanner.ts'

/** Collapse whitespace and trim: the only normalization, so a re-indent is not a new finding. */
export const normalizeSnippet = (snippet: string): string => snippet.replace(/\s+/gu, ' ').trim()

/** `hash(ruleId + path + normalized snippet)` (§6.2). Hex, 16 chars, never parsed — compared. */
export const fingerprintOf = (finding: RawFinding): string =>
  shortHash({
    ruleId: finding.ruleId,
    path: finding.path,
    snippet: normalizeSnippet(finding.snippet ?? finding.message),
  })

/**
 * The id a finding is raised under. Derived from the fingerprint rather than
 * minted, so a replay of the same scan names the same finding (§5.4) — the same
 * reason the PM derives a decision id from its question.
 */
export const findingIdOf = (fingerprint: string): FindingId => deriveId('fnd', { fingerprint }) as FindingId
