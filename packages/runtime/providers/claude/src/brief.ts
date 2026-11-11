/**
 * The opening message: what a peer is told when its session starts (§7, §8).
 *
 * The SDK gives a session nothing until the first user message arrives — not
 * even an `init` — so the brief is not just the handoff, it is what makes the
 * session exist. It is delivered as a turn (the only channel there is), and the
 * adapter reports that turn as `turn.started` like any other.
 *
 * A purge resume carries the state file (§8): the same brief plus what the
 * previous session had done, so the peer restarts mid-thought instead of at the
 * beginning. The brief's version travels with it because a reply written
 * against a superseded brief is rejected by the Mailbox (§7).
 */

import type { SessionSpec, Turn } from '@fleet/runtime-provider-sdk'

export const openingMessage = (spec: SessionSpec): Turn => {
  // A resume after a takeover or a stop opens with the handback note, not the brief
  // (watch-and-attach §4): the conversation already holds the brief.
  if (spec.opening !== undefined) return { text: spec.opening, kind: 'info', briefVersion: spec.brief.version }
  const lines: string[] = [`You are the ${spec.role} peer on the ${spec.peerId} account.`, '']

  const contracts = spec.brief.contractVersions
    .map((contract) => `${contract.contractId} v${contract.version}`)
    .join(', ')
  lines.push(
    `Your brief is ${spec.brief.briefId} version ${spec.brief.version}` +
      (contracts.length > 0 ? `, written against ${contracts}.` : '.'),
    '',
    spec.brief.text.trim(),
  )

  if (spec.stateFile !== undefined) {
    const state = spec.stateFile
    lines.push(
      '',
      'You are resuming after a purge. This is what your previous session knew:',
      '',
      `Goal: ${state.goal}`,
      ...section('Done', state.done),
      ...section('In flight', state.inFlight),
      ...section('Next', state.next),
      ...section('Decisions already taken', state.decisions),
      ...section('Open questions', state.openQuestions),
      '',
      `Carry on from here. The brief above is version ${spec.brief.version}; your state file was written against version ${state.briefVersion}.`,
    )
  }

  return { text: lines.join('\n'), kind: 'brief', briefVersion: spec.brief.version }
}

const section = (heading: string, items: readonly string[]): string[] =>
  items.length === 0 ? [] : ['', `${heading}:`, ...items.map((item) => `- ${item}`)]
