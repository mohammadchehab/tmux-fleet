/**
 * The state file: the one thing a peer carries across a purge (§8).
 *
 * It is `StateFile` from the contracts, so there is no second spelling of it
 * here — and two ways to obtain one, in this order:
 *
 * 1. **What the peer said.** The purge asks a typed question: answer with the
 *    state file, as a JSON object, fenced. The answer is *validated* against
 *    `stateFile()` — a reply missing `next` is refused and asked again, twice.
 *    This is the one place the fleet reads structure out of a peer's words, and
 *    it is safe to do only because the schema decides what is valid, not the
 *    reader; every other provider signal is a typed event (§4).
 * 2. **What the fleet already knows.** After two refusals the handoff must not
 *    fail: the mechanical summary — assigned work, open PRs, branch — is built
 *    from the store, the purge is logged `purge.degraded`, and the next session
 *    starts from facts instead of prose.
 *
 * The markdown is for humans and is derived from the validated object, never
 * parsed back (`~/.fleet/<profile>/peers/<peerId>/state.md`, §1.1).
 */

import { parseStrict, type PeerId, type Schema } from '@fleet/foundation-core'
import { stateFile, type StateFile } from '@fleet/foundation-contracts'

/** The contract's handoff object, re-exported so a caller of this package needs one import (§8). */
export type { StateFile }

/** How many times the peer is asked before the handoff degrades (§8). */
export const STATE_FILE_ASKS = 2

/**
 * The question put to the peer at the turn boundary. It is also the whole
 * contract of `1.` above: an object, these fields, nothing else required.
 */
export const stateFileAsk = (briefVersion: number): string =>
  [
    'Your context is being handed off: this session is about to be replaced by a fresh one.',
    'This is not a question about the work — do not start anything new.',
    '',
    'Reply with your state file as a single fenced ```json block, and nothing else:',
    '',
    '```json',
    '{',
    `  "peerId": "<your peer id>",`,
    '  "goal": "<one sentence: what this peer is trying to achieve>",',
    '  "done": ["<what is finished and verified>"],',
    '  "inFlight": ["<what is half-done, and exactly where it is>"],',
    '  "next": ["<the next concrete action, in order>"],',
    '  "decisions": ["<what was decided and why, so it is not re-litigated>"],',
    '  "openQuestions": ["<what is unresolved and who can resolve it>"],',
    `  "briefVersion": ${briefVersion}`,
    '}',
    '```',
    '',
    'Every field is required; empty lists are valid answers. The next session reads this and nothing else from this one.',
  ].join('\n')

/** A fenced block, or the whole reply when the peer pasted a bare object. */
const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/gi

/** The last fenced JSON block in the reply, or the whole text. */
const candidate = (reply: string): string => {
  const blocks = [...reply.matchAll(fenced)].map((match) => match[1] ?? '')
  if (blocks.length > 0) return blocks[blocks.length - 1] ?? ''
  return reply
}

/** What a state file attempt yielded: the object, or why it could not be read. */
export type StateFileReading =
  | { readonly ok: true; readonly stateFile: StateFile }
  | { readonly ok: false; readonly reason: string }

/**
 * Read a peer's reply as a state file, or say precisely why it is not one.
 *
 * The reason is fed back to the peer on the second ask and into
 * `purge.degraded`, so it names the field, not "invalid".
 */
export const readStateFile = (reply: string, peerId: PeerId, schema: Schema<StateFile> = stateFile()): StateFileReading => {
  const text = candidate(reply).trim()
  if (text.length === 0) return { ok: false, reason: 'the reply carried no state file' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'the state file was not valid JSON' }
  }
  let state: StateFile
  try {
    state = parseStrict(schema, value)
  } catch (thrown) {
    return { ok: false, reason: `the state file did not match its schema: ${(thrown as Error).message}` }
  }
  // The peer ids in a fleet are what make a handoff addressable; a state file
  // naming another peer is a copy-paste, and a purge that accepted it would
  // start the next session believing it is someone else.
  if (state.peerId !== peerId) {
    return { ok: false, reason: `the state file names peer ${state.peerId}, not ${peerId}` }
  }
  return { ok: true, stateFile: state }
}

/**
 * The facts the fleet already holds about a peer, for the degraded path (§8):
 * assigned work, its PRs, and the branch it is on. Injected, because the
 * supervisor does not own the store, the PR gate or git.
 */
export interface MechanicalFacts {
  readonly peerId: PeerId
  readonly briefVersion: number
  readonly goal: string
  readonly assignedWork: readonly string[]
  readonly prs: readonly string[]
  readonly branch?: string
  /** The last tool the peer used, when the event stream still has it — often the truest "where it is". */
  readonly lastTool?: string
}

/**
 * A state file built from facts, never from prose. It is intentionally poorer
 * than what a peer would write: `next` is empty, because the fleet does not
 * know what the peer intended, and inventing it would be worse than stopping.
 */
export const mechanicalStateFile = (facts: MechanicalFacts): StateFile => ({
  peerId: facts.peerId,
  goal: facts.goal,
  done: [],
  inFlight: [...facts.assignedWork, ...facts.prs],
  next: [],
  decisions: [],
  openQuestions:
    facts.branch === undefined && facts.lastTool === undefined
      ? ['nothing was recorded about this session; the next one starts from the brief']
      : [],
  briefVersion: facts.briefVersion,
})

/** The human copy, written to `<state>/peers/<peerId>/state.md` (§1.1). */
export const renderStateMarkdown = (state: StateFile, at: string): string => {
  const section = (title: string, items: readonly string[]): string[] =>
    items.length === 0 ? [`## ${title}`, '', '_none_', ''] : [`## ${title}`, '', ...items.map((item) => `- ${item}`), '']
  return [
    `# ${state.peerId}`,
    '',
    `Written ${at}, from brief v${state.briefVersion}.`,
    '',
    '## Goal',
    '',
    state.goal,
    '',
    ...section('Done', state.done),
    ...section('In flight', state.inFlight),
    ...section('Next', state.next),
    ...section('Decisions', state.decisions),
    ...section('Open questions', state.openQuestions),
  ].join('\n')
}
