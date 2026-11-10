/**
 * The half of a build's name that *routes* it (§11).
 *
 * §11 keys the ledger on `(repo, sha, task)`, and a task is `<class>[:<detail>…]`:
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
 * What *encodes* a detail lives in `@fleet/foundation-contracts`, beside `buildKey`
 * and for the same reason: the caller that asks for an eval build and the ledger that
 * keys on it are on opposite sides of a socket, and only foundation is reachable from
 * both (§1.1). This file keeps the decoding, which is the ledger's alone.
 */

/** Everything before the first `:`; the routing key (§11). A task with no `:` is all class. */
export const buildTaskClass = (task: string): string => {
  const at = task.indexOf(':')
  return at === -1 ? task : task.slice(0, at)
}
