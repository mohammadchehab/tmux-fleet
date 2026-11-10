#!/usr/bin/env node
/**
 * `fleet-usage-report`: the Stop hook (§6.2, §8). Claude Code runs it after
 * every turn with the Stop payload on stdin; it measures the turn from the
 * transcript and tells the daemon, which appends `turn.usage_recorded`.
 *
 * Under fleetd this hook is **not installed**: the supervisor sits at the same
 * turn boundary and records the row itself from the provider, so there is one
 * measurer and nothing in a peer's settings to keep in step. This is the route
 * for the sessions fleetd does not supervise (§6.2); see the README.
 *
 * It **never fails the peer**: whatever goes wrong — no socket, no limit, a
 * transcript it cannot read — it says why on stderr and exits 0, because a hook
 * that blocked a Stop to report a number would cost more than the number is
 * worth. The environment it reads is `FLEET_PEER`, `FLEET_SOCKET`,
 * `FLEET_CONTEXT_LIMIT` and optionally `FLEET_WORK_ID` (see `report.ts`).
 */

import { readFile } from 'node:fs/promises'
import { callDaemon } from './client.ts'
import { buildReport, readStopPayload } from './report.ts'

const readStdin = async (): Promise<string> => {
  let data = ''
  for await (const chunk of process.stdin) data += String(chunk)
  return data
}

const main = async (): Promise<void> => {
  const payload = readStopPayload(await readStdin())
  const transcript =
    payload.transcriptPath === undefined ? undefined : await readFile(payload.transcriptPath, 'utf8').catch(() => undefined)

  const result = buildReport(payload, transcript, process.env)
  if (result.status === 'skip') {
    console.error(`usage-report: skipped: ${result.reason}`)
    return
  }
  const socket = process.env['FLEET_SOCKET']
  if (socket === undefined || socket === '') {
    console.error('usage-report: skipped: FLEET_SOCKET is not set')
    return
  }
  const reply = await callDaemon(socket, 'usage', result.params)
  if (!reply.ok) console.error(`usage-report: not recorded: ${reply.message ?? 'unknown'}`)
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`usage-report: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(0)
  },
)
