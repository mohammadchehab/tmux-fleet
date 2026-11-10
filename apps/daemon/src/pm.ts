/**
 * The PM the daemon runs until `orchestration/pm` lands.
 *
 * §5.2's ProjectManager is pure and synchronous; "decide nothing" is a
 * legitimate tick (`routine.finished.actions = 0`), which is what every routine
 * does today. This is therefore not a placeholder that pretends: it records the
 * same `inputsHash` a real PM would have to record, so the scheduler's events
 * are well-formed and a replay can tell an empty decision from a missing one.
 *
 * `compose()` takes a `pm` and this is the default. When the real package
 * arrives, the only change is `main.ts` passing it.
 */

import type { DecideRequest, DecideResult, ProjectManager } from '@fleet/foundation-contracts'

/**
 * FNV-1a over the inputs, as eight hex characters. §5.4 compares the hash for
 * equality and never parses it: it answers "did the inputs change", not "what
 * were they".
 */
const hashOf = (text: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').slice(0, 8)
}

export const idlePm: ProjectManager = {
  decide(request: DecideRequest): DecideResult {
    return {
      actions: [],
      inputsHash: hashOf(
        JSON.stringify({
          state: request.state,
          event: request.event?.seq ?? null,
          tick: request.tick?.routineId ?? null,
        }),
      ),
    }
  },
}
