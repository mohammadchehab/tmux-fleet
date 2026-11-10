/**
 * A build's *name* and the *path of its answer* (§11, §17): the two pure encodings
 * a caller and the ledger have to spell identically.
 *
 * They sit in `foundation` for the reason `buildKey` does: `apps/clients` may import
 * foundation types and nothing else (§1.1), and `fleet evals run` has to form the task
 * it asks the ledger for and then find the file the ledger wrote. A second spelling of
 * either string, one on each side of a socket, is a copy that drifts — and a task that
 * drifts is a build that runs twice, or never.
 *
 * What stays in `@fleet/orchestration-ledger` is everything with a decision in it:
 * which host runs a task, where the log is named and kept, and what a run's exit code
 * means. This file only answers "what is this build called" and "where did its answer
 * go".
 */

import { fleetError } from '@fleet/foundation-core'

/** The identity §17 makes an eval run unique on, beside the repo and sha. */
export interface EvalBuildIdentity {
  readonly suite: string
  readonly provider: string
  readonly model: string
}

/**
 * The `task` an eval run is filed under: `evals:<suite>:<provider>:<model>`.
 *
 * §11 keys the ledger on `(repo, sha, task)`, so `task` is the only place a caller can
 * say "which build". §17 asks for one more thing than §11's triple: an eval run is
 * unique on `(repo, sha, suite, provider, model)`, so "an identical run never repeats"
 * while the *same* suite across two models does run twice. That is a five-tuple inside
 * a three-tuple key, and this is the encoding that keeps the one promise without
 * widening the store's `UNIQUE (repo, sha, task)`.
 *
 * A component may not contain `:` — the separator would move the class boundary or
 * split a detail in two, and the next reader of the string would decode a different
 * identity than the caller encoded. A model named `a:b` is refused here rather than
 * silently truncated, because the ledger's whole job is that two different runs never
 * share a key.
 */
export const evalBuildTask = ({ suite, provider, model }: EvalBuildIdentity): string => {
  const parts = { suite, provider, model }
  for (const [name, value] of Object.entries(parts)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw fleetError('invalid_input', `an eval build identity needs a non-empty ${name}`, { details: parts })
    }
    if (value.includes(':')) {
      throw fleetError('invalid_input', `the eval ${name} "${value}" contains ":", which separates a build task's parts`, {
        details: parts,
      })
    }
  }
  return `evals:${suite}:${provider}:${model}`
}

/**
 * The class every eval task has to route together (§11's "by task class"), so a
 * profile can name the class without spelling a detail, and adding a suite never means
 * editing the profile.
 */
export const EVAL_TASK_CLASS = 'evals'

/**
 * `artifacts/builds/<sha>-<task>.out`: where a build's stdout is kept beside its log.
 *
 * Derived from the log path rather than carried in an event or a result, because the
 * two files are the same build and a reader that has one has the other. The *log's* own
 * name stays the ledger's business — it is the ledger that picks the directory and
 * slugs the task — but a reader outside the ledger has to find the answer from
 * `Build.logPath` alone, so this half is spelled here, once.
 */
export const buildStdoutPath = (logPath: string): string =>
  logPath.endsWith('.log') ? `${logPath.slice(0, -'.log'.length)}.out` : `${logPath}.out`
