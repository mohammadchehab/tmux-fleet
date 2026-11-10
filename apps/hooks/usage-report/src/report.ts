/**
 * From a Stop hook's stdin and the peer's environment to the one `usage`
 * request the daemon takes (§6.2). Pure, so every way the environment can be
 * wrong is a test, not a surprise at the end of someone's turn.
 *
 * What comes from where:
 * - **peer** from `FLEET_PEER`, set by the daemon for every session;
 * - **context limit** from `FLEET_CONTEXT_LIMIT`, set from the profile. It is
 *   never read from the transcript or guessed: the self-purge ratio is only as
 *   good as the limit under it (§4, §8). Absent or not a positive integer means
 *   no report, with the reason, not a made-up number;
 * - **work** from `FLEET_WORK_ID` when the session was started for one Work;
 * - **counts** from the transcript (`transcript.ts`).
 */

import { decode, peerId, workId, type PeerId, type WorkId } from '@fleet/foundation-core'
import type { UsageParams } from '@fleet/foundation-contracts'
import { measureTurn } from './transcript.ts'

/** The fields of Claude Code's Stop payload this hook reads; the rest is ignored. */
export interface StopPayload {
  readonly transcriptPath?: string
  /** Claude sets this when a Stop hook already continued the turn; a second report would double-count. */
  readonly stopHookActive: boolean
}

export const readStopPayload = (stdin: string): StopPayload => {
  try {
    const value: unknown = JSON.parse(stdin)
    if (typeof value !== 'object' || value === null) return { stopHookActive: false }
    const record = value as Record<string, unknown>
    const path = record['transcript_path']
    return {
      ...(typeof path === 'string' && path !== '' ? { transcriptPath: path } : {}),
      stopHookActive: record['stop_hook_active'] === true,
    }
  } catch {
    return { stopHookActive: false }
  }
}

export type ReportResult =
  | { readonly status: 'report'; readonly params: UsageParams }
  | { readonly status: 'skip'; readonly reason: string }

export const buildReport = (
  payload: StopPayload,
  transcript: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): ReportResult => {
  if (payload.stopHookActive) return { status: 'skip', reason: 'the Stop hook is already active; not counting the turn twice' }

  const peer = decode(peerId(), env['FLEET_PEER'])
  if (!peer.ok) return { status: 'skip', reason: 'FLEET_PEER is not a peer id; this session was not started by the fleet' }

  const limit = Number(env['FLEET_CONTEXT_LIMIT'])
  if (!Number.isInteger(limit) || limit <= 0) {
    return { status: 'skip', reason: 'FLEET_CONTEXT_LIMIT is not a positive integer; the limit comes from the profile, not a guess' }
  }

  if (transcript === undefined) return { status: 'skip', reason: 'no transcript to read' }
  const measure = measureTurn(transcript)
  if (measure === undefined) return { status: 'skip', reason: 'no assistant message in the last turn' }

  const work = env['FLEET_WORK_ID'] === undefined ? undefined : decode(workId(), env['FLEET_WORK_ID'])
  return {
    status: 'report',
    params: {
      peerId: peer.value as PeerId,
      ...(work?.ok === true ? { workId: work.value as WorkId } : {}),
      contextLimit: limit,
      ...measure,
    },
  }
}
