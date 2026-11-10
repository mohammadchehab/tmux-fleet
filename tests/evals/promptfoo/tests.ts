// The tests file promptfoo runs for the `judge` suite (§17).
//
// The case list is the case directory, not this file: `loadCases` reads `tests/evals/cases/judge/*.json` (engineer-3's
// files, one incident each) and `promptfooTests` turns each into one promptfoo test carrying the whole case and its
// expected decision rendered canonically. The assertion (`output === context.vars.expectedText`) is attached there, in
// TypeScript, so what a pass means is type-checked code and not a string in a config file.
//
// The relative import is deliberate: `tests/` is not a workspace package, so there is no package name to import and
// nothing that could import it back. Set `FLEET_EVAL_CASES` to run a subset from another directory.

import { fileURLToPath } from 'node:url'

import { loadCases } from '../../../packages/evals/suites/judge/src/cases.ts'
import { promptfooTests } from '../../../packages/evals/suites/judge/src/promptfoo-tests.ts'

export default async function tests() {
  const dir = process.env['FLEET_EVAL_CASES'] ?? fileURLToPath(new URL('../cases/judge', import.meta.url))
  return promptfooTests(await loadCases(dir))
}
