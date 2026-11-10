#!/usr/bin/env node
/**
 * `fleet-evals-judge`: the `judge` suite as a process (§17).
 *
 * `fleet evals run judge` spawns this the way `fleet up` spawns `fleetd` — by bin
 * name, over a process boundary, because nothing outside `evals` may import `evals`
 * (§1.1) and the CLI's report formatter lives outside it. The contract between the
 * two is one JSON object on stdout and an exit code; everything a human may read
 * while it runs goes to stderr, so the JSON is never polluted.
 *
 * Exit codes are the CLI's: `0` the run is not worse than its baseline, `1` it is,
 * `2` the run could not be made (no model named, no git revision, a baseline that
 * does not parse). `1` is a verdict about the model; `2` is a mistake in the setup,
 * and a script may retry the first and cannot fix the second.
 *
 * Nothing here decides anything: `runJudge` produces the whole result, `run.ts` is
 * what a test drives, and this file is the filesystem and the clock.
 */

import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { toFleetError } from '@fleet/foundation-core'

import { loadCases } from './cases.ts'
import { BASELINE_PATH, runJudge } from './run.ts'
import { createJudgeRunner, targetFromEnv } from './judge-provider.ts'

/** `packages/evals/suites/judge/src/main.ts` → the repo root the relative paths are read from. */
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

/** `--flag`, `--flag value`. No short forms: this binary is spawned, not typed at a prompt. */
const flag = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}

const fail = (message: string): never => {
  process.stderr.write(`fleet-evals-judge: ${message}\n`)
  process.exit(2)
}

const main = async (): Promise<number> => {
  const argv = process.argv.slice(2)
  const saveBaseline = argv.includes('--save-baseline')
  const casesDir = flag(argv, '--cases') ?? join(REPO_ROOT, 'tests/evals/cases/judge')
  const baselineFile = flag(argv, '--baseline') ?? join(REPO_ROOT, BASELINE_PATH)

  // The commit the run is about: a baseline naming a revision nobody can check out is
  // not a baseline, so it is read rather than assumed (§17).
  let sha: string
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch (thrown) {
    return fail(`cannot read the commit this run is against: ${toFleetError(thrown, 'external_failed').message}`)
  }

  // The provider is built from the environment, the same variables the promptfoo
  // config documents, and refused before the first case if the pair is wrong.
  const target = targetFromEnv(process.env)
  const cases = await loadCases(casesDir)
  const run = createJudgeRunner(target)

  let baseline: string | undefined
  if (!saveBaseline) {
    try {
      baseline = await readFile(baselineFile, 'utf8')
    } catch (thrown) {
      // No file is the expected first run, and `runJudge` says what that means. Any
      // other read failure is a setup mistake worth stopping for.
      if ((thrown as NodeJS.ErrnoException).code !== 'ENOENT') throw thrown
    }
  }

  const judged = await runJudge({
    cases,
    provider: target.provider,
    model: target.model,
    sha,
    now: new Date().toISOString(),
    run: async (c) => {
      process.stderr.write(`judge: ${c.id}\n`)
      return run(c)
    },
    ...(baseline === undefined ? {} : { baseline }),
    ...(saveBaseline ? { saveBaseline } : {}),
  })

  if (judged.baseline !== undefined) {
    await mkdir(dirname(baselineFile), { recursive: true })
    await writeFile(baselineFile, `${JSON.stringify(judged.baseline, null, 2)}\n`, 'utf8')
    process.stderr.write(`judge: baseline written to ${BASELINE_PATH}\n`)
  }

  process.stdout.write(`${JSON.stringify(judged.output, null, 2)}\n`)
  if (judged.output.gate.kind === 'regressed') {
    for (const regression of judged.output.gate.regressions) {
      process.stderr.write(
        `judge: ${regression.caseId} fell to ${String(regression.passes)}/${String(regression.attempts)} from ${String(regression.baselinePasses)}/${String(regression.baselineAttempts)}\n`,
      )
    }
  }
  return judged.output.gate.exitCode
}

process.exitCode = await main().catch((thrown: unknown) => fail(toFleetError(thrown, 'internal').message))
