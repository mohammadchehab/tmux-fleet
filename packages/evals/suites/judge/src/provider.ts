/**
 * The module promptfoo loads as this suite's provider (§17).
 *
 * It is TypeScript because promptfoo 0.125.1 loads a `.ts` provider directly: it hands the path to Node, which strips
 * the types, so the "does promptfoo need a `.js`/`.mjs` shim" question §17 left open is answered *no shim* — and
 * every line of the suite stays type-checked. (Verified against the pinned version, not assumed: a probe config with a
 * `.ts` provider and a `.ts` tests file runs, and `defaultTest.options.repeat` multiplies the cases as §17 needs.)
 *
 * Promptfoo instantiates the class once per run, so the target is read once: a bad provider/model pair fails the run
 * before the first model call rather than once per case.
 */

import { providerFromEnv, type CallApiContext, type CallApiResponse, type JudgeProvider } from './judge-provider.ts'

export default class FleetJudgeProvider {
  readonly #inner: JudgeProvider

  constructor() {
    this.#inner = providerFromEnv(process.env)
  }

  id(): string {
    return this.#inner.id()
  }

  callApi(prompt: string, context: CallApiContext): Promise<CallApiResponse> {
    return this.#inner.callApi(prompt, context)
  }
}
