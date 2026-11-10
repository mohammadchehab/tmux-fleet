/**
 * `@fleet/orchestration-pm`: the deterministic project manager (architecture §5.2, §5.4).
 *
 * One export matters to the rest of the fleet — `decide`, and the `ProjectManager` port it satisfies. The rules
 * are exported too, because the rule table *is* the design, and a test that names one rule reads better than a test
 * that proves a negative from an empty action list (§5.2).
 */

export * from './digest.ts'
export * from './options.ts'
export * from './state.ts'
export * from './brief.ts'
export * from './decide.ts'
export * from './rules/index.ts'
