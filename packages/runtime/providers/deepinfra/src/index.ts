/**
 * `@fleet/runtime-provider-deepinfra`: DeepInfra behind §4's `Provider`.
 *
 * Same implementation as `@fleet/runtime-provider-claude` — DeepInfra speaks the
 * Anthropic wire protocol — with the endpoint, the context window and the cost
 * capability taken from config rather than from an SDK that guesses all three
 * (`docs/design/spikes/agent-sdk.md`).
 */

export * from './provider.ts'
