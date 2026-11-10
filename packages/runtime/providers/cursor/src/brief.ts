/**
 * The opening message: what a peer is told when its session starts (§7, §8).
 *
 * `cursor-agent -p` is one process per prompt, so the brief is not a handshake —
 * it *is* the first turn, and there is no session to speak of until it runs. The
 * adapter reports it as `turn.started` with the handle's `briefTurnId`, like any
 * other turn.
 *
 * A purge resume carries the state file (§8): the same brief plus what the
 * previous session had done, so the peer restarts mid-thought instead of at the
 * beginning. The brief's version travels with it because a reply written against
 * a superseded brief is rejected by the Mailbox (§7).
 *
 * `systemPromptAppend` — the codegraph guard policy, for instance (§6.2) — is
 * part of the opening message rather than a system prompt because this CLI takes
 * no per-run system prompt on the command line. It is introduced as policy so a
 * peer reads it as instruction rather than as part of its brief.
 */

import type { SessionSpec, Turn } from '@fleet/runtime-provider-sdk'

export const openingMessage = (spec: SessionSpec): Turn => {
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

  const appended = spec.systemPromptAppend?.trim()
  if (appended !== undefined && appended !== '') {
    lines.push('', 'Session policy, which applies to everything you do:', '', appended)
  }

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

  lines.push(
    '',
    'You are running read-only, in plan mode: you can read and search, and you cannot change anything.',
  )

  return { text: lines.join('\n'), kind: 'brief', briefVersion: spec.brief.version }
}

const section = (heading: string, items: readonly string[]): string[] =>
  items.length === 0 ? [] : ['', `${heading}:`, ...items.map((item) => `- ${item}`)]
