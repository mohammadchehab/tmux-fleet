#!/usr/bin/env node
/**
 * `fleet` the process: argv in, exit code out (§2).
 *
 * Everything interesting is in `run.ts`, which takes its caller and its output
 * as arguments so it can be tested without a socket or a terminal. This file
 * supplies the two real ones and nothing else — it is the only place in the
 * CLI that reads `process`.
 */

import { callerFor } from './client.ts'
import { spawnFleetd } from './daemon.ts'
import { writeStarter } from './init.ts'
import { run } from './run.ts'
import { runTakeover } from './takeover.ts'
import { runWatch } from './watch/interactive.ts'
import { fleetError } from '@fleet/foundation-core'

process.exitCode = await run(process.argv, {
  call: (socketPath) => callerFor({ socketPath }),
  startFleetd: (profile) => spawnFleetd({ profile, env: process.env }),
  initProfile: (profile) => writeStarter(profile),
  takeover: runTakeover,
  watch: ({ socketPath, call }) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw fleetError('invalid_input', 'fleet watch needs a terminal; `fleet watch --once` prints a snapshot')
    }
    return runWatch({ socketPath, call, takeover: runTakeover, env: process.env, stdin: process.stdin, stdout: process.stdout })
  },
  env: process.env,
})
