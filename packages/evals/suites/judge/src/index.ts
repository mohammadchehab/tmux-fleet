/**
 * `@fleet/evals-suites-judge`: the `judge` eval suite (§17), first slice.
 *
 * A suite is dev tooling, not a package anything ships: it may import the real Judge and a real provider (that is the
 * point), and nothing imports it (`tests/architecture` refuses the edge back). What it exposes is the pieces the
 * promptfoo config needs — a case loader, the provider that runs the real path, and the test generator — so the
 * promptfoo side is two thin `.mjs` files that hand Node the modules and contain no logic.
 */

export * from './case.ts'
export * from './cases.ts'
export * from './decision.ts'
export * from './judge-provider.ts'
export * from './promptfoo-tests.ts'
export * from './run.ts'
