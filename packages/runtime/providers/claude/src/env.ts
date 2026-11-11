/**
 * What is specific to the claude adapter's env: the endpoint and model a spec's env pins.
 * The allowlist itself (`buildChildEnv`, `NEVER_INHERITED`) lives in
 * `@fleet/runtime-provider-sdk`, because every provider that spawns a process needs it
 * and none may import a sibling.
 */

export { buildChildEnv, isNeverInherited, INHERITED_FROM_PARENT, NEVER_INHERITED, type BuiltEnv } from '@fleet/runtime-provider-sdk'

/**
 * The endpoint a child was pointed at, when the spec recorded one. `model()`
 * reports it so an operator can tell two sessions of the same vendor apart
 * (§4, §13); it is never inferred from the parent process.
 */
export const recordedEndpoint = (env: Readonly<Record<string, string>>): string | undefined =>
  env.ANTHROPIC_BASE_URL ?? env.ANTHROPIC_API_URL

/**
 * The model identity a spec's env pins, if any. The SDK's `options.model` is
 * the supported way to choose one; a spec that sets `ANTHROPIC_MODEL` instead
 * is honoured too, and this is what the start check compares against.
 */
export const recordedModel = (env: Readonly<Record<string, string>>): string | undefined => env.ANTHROPIC_MODEL
