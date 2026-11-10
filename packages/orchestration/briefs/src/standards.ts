/**
 * The standards a peer works under, as text (§12.1, §4): the profile's
 * non-negotiables, the skill documents its role needs, and what the repo's own
 * `AGENTS.md` and `CLAUDE.md` say.
 *
 * Why a brief builds this and a provider does not: the claude provider runs with
 * `settingSources: []` (SDK isolation, §4), because turning `user` settings on
 * leaks hooks and env into a peer. That isolation also means a peer never reads
 * the repo's instructions, or finds a skill, on its own. So the standards are
 * *handed* to it, in the system prompt, once per session, as text — which is the
 * one route that works for every provider, `cursor` (no Skill tool, no settings)
 * included. A skill is therefore a document inlined here, not a name to look up.
 *
 * **Pure.** No file is read here: the daemon passes `StandardsSource`s in. The
 * same sources give the same text and digest, which is what lets the daemon decide
 * "unchanged" from a hash alone and a replay rebuild the brief.
 *
 * **Order is precedence**, highest first, and each document sits in its own
 * `<document>` so its headings stay its own.
 *
 * **Size is cost.** The text rides in every turn's context, against §8's purge
 * threshold. Each document is capped, and so is the whole. What happens at a cap
 * depends on who owns the document:
 * - a repo's `AGENTS.md`/`CLAUDE.md` (`truncate`) is cut, with a marker naming the
 *   file and the sizes — a repo does not know it is feeding a fleet, and a long
 *   file should not stop a peer from starting;
 * - a document the *profile* declared (`refuse`) is never cut: its last rules are
 *   the ones a cut removes, and the profile's author can shorten it. Over the cap
 *   is an error that says so.
 * - the whole being over its cap is an error too, never a silent trim.
 */

import { createHash } from 'node:crypto'

import { fleetError } from '@fleet/foundation-core'

export type SourceMode = 'truncate' | 'refuse'

/** One document the standards are made of. `name` is how the peer is told where it came from. */
export interface StandardsSource {
  readonly name: string
  readonly text: string
  readonly mode: SourceMode
  /** The commit it was read at, when it came from git. */
  readonly ref?: string
}

/** What one document may contribute. */
export const MAX_SOURCE_CHARS = 16_000
/** What all of them may, with the wrappers: ~10k tokens in every turn is the most a peer is asked to carry. */
export const MAX_TOTAL_CHARS = 40_000

/** What the event records about each document that went in. */
export interface StandardsSourceInfo {
  readonly name: string
  /** The document's own size, before any cut. */
  readonly chars: number
  readonly truncated: boolean
  readonly ref?: string
}

export interface Standards {
  /** Goes to `SessionSpec.systemPromptAppend`; empty when there is nothing to say. */
  readonly text: string
  /** Hex sha-256 of `text`: equal text, equal digest. */
  readonly digest: string
  readonly sources: readonly StandardsSourceInfo[]
}

/** The digest's length as shown to a peer; the full hash decides equality. */
const SHORT = 12

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

const tooLong = (source: StandardsSource): never => {
  throw fleetError(
    'config_mismatch',
    `${source.name} is ${String(source.text.length)} characters, over the ${String(MAX_SOURCE_CHARS)} a standards document may be. ` +
      'It is never cut, because a cut removes its last rules: shorten it, or split what can be read on demand out of it.',
    { details: { name: source.name, chars: source.text.length, max: MAX_SOURCE_CHARS } },
  )
}

const bodyOf = (source: StandardsSource): { readonly body: string; readonly truncated: boolean } => {
  if (source.text.length <= MAX_SOURCE_CHARS) return { body: source.text.trim(), truncated: false }
  if (source.mode === 'refuse') return tooLong(source)
  return {
    body:
      `${source.text.slice(0, MAX_SOURCE_CHARS).trimEnd()}\n\n` +
      `[truncated: ${source.name} is ${String(source.text.length)} characters and only the first ` +
      `${String(MAX_SOURCE_CHARS)} are here. Read the whole file before relying on what is missing.]`,
    truncated: true,
  }
}

export const buildStandards = (input: { readonly sources: readonly StandardsSource[] }): Standards => {
  // A document the profile declared that is empty is a rule that went missing, not
  // a repo with nothing to say: refused, never dropped.
  for (const source of input.sources) {
    if (source.mode === 'refuse' && source.text.trim() === '') {
      throw fleetError(
        'config_mismatch',
        `${source.name} is empty: a declared standards document must say something. Write it, or remove it from the profile.`,
        { details: { name: source.name } },
      )
    }
  }
  const sources = input.sources.filter((source) => source.text.trim() !== '')
  if (sources.length === 0) return { text: '', digest: sha(''), sources: [] }

  const parts: string[] = [
    'Standards you work under',
    '',
    "These are this repo's and this fleet's own rules for the work you do, in precedence order: the first " +
      'document outranks the ones after it, and they all outrank your habits. A Work brief cannot waive a standard: ' +
      'if what a brief asks conflicts with one, do not quietly pick a side — raise it as a blocker. When you follow a ' +
      'standard over what you would otherwise have done, say so in your reply.',
  ]
  const info: StandardsSourceInfo[] = []
  for (const source of sources) {
    const { body, truncated } = bodyOf(source)
    // Tagged rather than headed: a document brings headings of its own, and a
    // `##` of ours between them would read as one of theirs.
    parts.push('', `<document name="${source.name}">`, body, '</document>')
    info.push({
      name: source.name,
      chars: source.text.length,
      truncated,
      ...(source.ref === undefined ? {} : { ref: source.ref }),
    })
  }

  const text = `${parts.join('\n')}\n`
  if (text.length > MAX_TOTAL_CHARS) {
    throw fleetError(
      'config_mismatch',
      `the standards come to ${String(text.length)} characters, over the ${String(MAX_TOTAL_CHARS)} a peer carries in every turn: ` +
        `${info.map((source) => `${source.name} ${String(Math.min(source.chars, MAX_SOURCE_CHARS))}`).join(', ')}. Shorten one.`,
      { details: { chars: text.length, max: MAX_TOTAL_CHARS, sources: info.map((source) => source.name) } },
    )
  }
  return { text, digest: sha(text), sources: info }
}

/**
 * The line a brief carries about its standards. It is part of the brief's text on
 * purpose: change the standards and the brief's text changes, which is what makes
 * "a change is a new Brief" (§12.1) true rather than a convention. `digest` is the
 * one the `peer.standards_set` event records, so the peer, the log and the board
 * name the same thing. "Standing instructions", not "system prompt": cursor has no
 * system prompt, and the text is true of both providers.
 */
export const standardsLine = (digest: string): string =>
  `Your standing instructions (digest ${digest.slice(0, SHORT)}) were given to you with this brief; follow them.`
