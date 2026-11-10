/**
 * Reading the case directory (§17): every `tests/evals/cases/judge/*.json` is one case.
 *
 * The directory *is* the suite's case list, so adding a case is adding a file and deleting one is deleting a file —
 * no registry to keep in step. The file name must be the case id: a report, a baseline and an event are all keyed by
 * that id (`eval.case_scored {caseId, …}`), so a file copied to a new name and not edited would score twice under one
 * id and silently halve a pass rate.
 */

import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { readCase, type JudgeCase } from './case.ts'

/** Every case in `dir`, sorted by id so a run is ordered the same way on every machine. */
export async function loadCases(dir: string): Promise<readonly JudgeCase[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
  const cases: JudgeCase[] = []
  for (const name of names) {
    const file = join(dir, name)
    const c = readCase(await readFile(file, 'utf8'), file)
    const stem = basename(name, '.json')
    if (c.id !== stem) throw new Error(`${file}: the case id is ${c.id}; a case file is named for its id (${stem}.json)`)
    cases.push(c)
  }
  if (cases.length === 0) throw new Error(`${dir}: no cases; a suite with no cases scores nothing`)
  return cases
}
