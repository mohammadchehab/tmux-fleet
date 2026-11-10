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
import { runEvals } from './evals.ts'
import { run } from './run.ts'

process.exitCode = await run(process.argv, {
  call: (socketPath) => callerFor({ socketPath }),
  startFleetd: (profile) => spawnFleetd({ profile, env: process.env }),
  runEvals: (options) => runEvals(options),
  env: process.env,
})
