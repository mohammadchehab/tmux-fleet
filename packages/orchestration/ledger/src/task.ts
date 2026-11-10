/**
 * What a build *is*, as a string (§11, §17).
 *
 * §11 keys the ledger on `(repo, sha, task)`, so `task` is the only place a
 * caller can say "which build". A task is `<class>[:<detail>…]`:
 *
 *     test                              the repo's own test run
 *     evals:judge:claude:opus-5-5       one eval suite, at one provider and model
 *
 * The **class** — everything before the first `:` — is what §11 routes on
 * ("heavy tasks route to the remote host by task class in the profile"), so a
 * class that is heavy is heavy for every detail of it: adding a suite does not
 * mean editing the profile, and a suite can never accidentally run locally
 * because someone forgot to list it.
 *
 * §17 asks for more than §11's triple: an eval run is unique on
 * `(repo, sha, suite, provider, model)`, so that "an identical run never
 * repeats" while the *same* suite across two models does run twice. That is a
 * five-tuple inside a three-tuple key, and `evalBuildTask` is the encoding that
 * keeps the one promise without widening the store's `UNIQUE (repo, sha, task)`.
 */

import { fleetError } from '@fleet/foundation-core'

/** Everything before the first `:`; the routing key (§11). A task with no `:` is all class. */
export const buildTaskClass = (task: string): string => {
  const at = task.indexOf(':')
  return at === -1 ? task : task.slice(0, at)
}

/** The identity §17 makes an eval run unique on, beside the repo and sha. */
export interface EvalBuildIdentity {
  readonly suite: string
  readonly provider: string
  readonly model: string
}

/**
 * The `task` a remote eval run is filed under.
 *
 * A component may not contain `:` — the separator would move the class boundary
 * or split a detail in two, and the next reader of the string would decode a
 * different identity than the caller encoded. A model named `a:b` is refused
 * here rather than silently truncated, because the ledger's whole job is that
 * two different runs never share a key.
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
 * The class every eval task has to route together (§11's "by task class").
 * Exported so a profile can name it without spelling a detail.
 */
export const EVAL_TASK_CLASS = 'evals'
