// tests/architecture/dependency-rules.test.ts — the build fails when an import breaks §1.1 of
// docs/design/fleet-v2-architecture.md. One test over the real tree, plus a test per rule against synthetic edges
// so a rule cannot quietly stop firing, plus a temp workspace for the two escapes a package-name check cannot see.
//
// Run: node --test tests/   (task test at the repo root runs this and the v1 suite)

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  appKind,
  checkEdge,
  checkEvalTooling,
  checkPackageShape,
  checkWorkspace,
  formatViolation,
  locate,
  PACKAGE_ORDER,
  type ImportEdge,
  type PackageRef,
  type Violation,
} from './rules.ts'
import { readEdges, readManifests, readPackages, REPO_ROOT, specifiersOf } from './workspace.ts'

function pkg(name: string, dir: string): PackageRef {
  const where = locate(dir)
  assert.ok(where, `${dir} is not in the §1.1 layout`)
  return { name, dir, group: where.group, key: where.key }
}

function edge(from: string, to: string): ImportEdge {
  return { from, to, file: 'test.ts', line: 1, specifier: to }
}

const WORKSPACE = [
  pkg('@fleet/foundation-core', 'packages/foundation/core'),
  pkg('@fleet/foundation-contracts', 'packages/foundation/contracts'),
  pkg('@fleet/foundation-store', 'packages/foundation/store'),
  pkg('@fleet/runtime-provider-sdk', 'packages/runtime/providers/sdk'),
  pkg('@fleet/runtime-providers-claude', 'packages/runtime/providers/claude'),
  pkg('@fleet/runtime-provider-deepinfra', 'packages/runtime/providers/deepinfra'),
  pkg('@fleet/runtime-supervisor', 'packages/runtime/supervisor'),
  pkg('@fleet/runtime-mailbox', 'packages/runtime/mailbox'),
  pkg('@fleet/orchestration-pm', 'packages/orchestration/pm'),
  pkg('@fleet/orchestration-routines', 'packages/orchestration/routines'),
  pkg('@fleet/orchestration-gate', 'packages/orchestration/gate'),
  pkg('@fleet/orchestration-judge', 'packages/orchestration/judge'),
  pkg('@fleet/integrations-github', 'packages/integrations/github'),
  pkg('@fleet/notify-core', 'packages/notify/core'),
  pkg('@fleet/notify-macos', 'packages/notify/channels/macos'),
  pkg('@fleet/evals-adapter', 'packages/evals/adapter'),
  pkg('@fleet/evals-suites-judge', 'packages/evals/suites/judge'),
  pkg('@fleet/daemon', 'apps/daemon'),
  pkg('@fleet/cli', 'apps/clients/cli'),
  pkg('@fleet/tool-guard', 'apps/hooks/tool-guard'),
]

const BY_NAME = new Map(WORKSPACE.map((p) => [p.name, p]))

function denies(from: string, to: string): string {
  const reason = checkEdge(edge(from, to), BY_NAME)
  assert.ok(reason !== null, `${from} -> ${to} should be refused, but the rule allowed it`)
  return reason
}

function allows(from: string, to: string): void {
  assert.equal(checkEdge(edge(from, to), BY_NAME), null, `${from} -> ${to} should be allowed`)
}

test('the workspace as it stands obeys §1.1', async () => {
  const packages = await readPackages(REPO_ROOT)
  assert.ok(packages.length > 0, 'no packages found; the scan is broken, not the tree')

  const byName = new Map(packages.map((p) => [p.name, p]))
  const edges: ImportEdge[] = []
  const escapes: Violation[] = []
  for (const p of packages) {
    const read = await readEdges(REPO_ROOT, p, byName)
    edges.push(...read.edges)
    escapes.push(...read.escapes)
  }

  const violations = [...checkWorkspace(packages, edges), ...escapes]
  const report = violations.map(formatViolation).join('\n')
  assert.equal(report, '', `\n${report}\n\nEach line above breaks the dependency rules of §1.1.`)
})

test('every package in the tree is one of the packages §1.1 lists', async () => {
  // PACKAGE_ORDER is the allowed set, so a package added somewhere new fails here until the rule table is updated
  // — which is the point: the layout is a decision, not an accident.
  const packages = await readPackages(REPO_ROOT)
  const shape = packages
    .map((p) => checkPackageShape(p))
    .filter((m): m is string => m !== null)
  assert.equal(shape.join('\n'), '', `\n${shape.join('\n')}`)
})

test('foundation never imports up into a group', () => {
  assert.match(denies('@fleet/foundation-core', '@fleet/runtime-provider-sdk'), /foundation imports runtime/)
  assert.match(denies('@fleet/foundation-contracts', '@fleet/orchestration-pm'), /foundation imports orchestration/)
})

test('a group may import foundation', () => {
  allows('@fleet/orchestration-pm', '@fleet/foundation-core')
  allows('@fleet/orchestration-pm', '@fleet/foundation-contracts')
  allows('@fleet/runtime-supervisor', '@fleet/foundation-store')
  allows('@fleet/integrations-github', '@fleet/foundation-contracts')
})

test('groups never import each other sideways', () => {
  assert.match(denies('@fleet/orchestration-pm', '@fleet/integrations-github'), /never import each other sideways/)
  assert.match(denies('@fleet/runtime-supervisor', '@fleet/orchestration-pm'), /never import each other sideways/)
  assert.match(denies('@fleet/notify-core', '@fleet/runtime-provider-sdk'), /never import each other sideways/)
})

test('a provider never imports the store', () => {
  assert.match(
    denies('@fleet/runtime-providers-claude', '@fleet/foundation-store'),
    /a provider never imports the store/,
  )
  // the sdk is what a provider is written against, so it is held to the same ban
  assert.match(denies('@fleet/runtime-provider-sdk', '@fleet/foundation-store'), /a provider never imports the store/)
  // and the supervisor, which does own the adaptation, may
  allows('@fleet/runtime-supervisor', '@fleet/foundation-store')
})

test('the packages that speak to a provider import the sdk, never a concrete one', () => {
  // the order rule alone would let supervisor and mailbox name claude or deepinfra; #30 closes that
  for (const speaker of ['@fleet/runtime-supervisor', '@fleet/runtime-mailbox']) {
    assert.match(denies(speaker, '@fleet/runtime-providers-claude'), /may import @fleet\/runtime-provider-sdk only/)
    allows(speaker, '@fleet/runtime-provider-sdk')
  }
  // routines may not name one either: the shared types it needs are foundation's (§4). A sideways import of the
  // sdk itself is still refused, which is what makes the rule about *which* provider, not *whether*.
  assert.match(denies('@fleet/orchestration-routines', '@fleet/runtime-providers-claude'), /may import @fleet\/runtime-provider-sdk only/)
  assert.match(denies('@fleet/orchestration-routines', '@fleet/runtime-provider-sdk'), /never import each other sideways/)
  // a provider importing its siblings stays allowed: that is what the sdk is for
  allows('@fleet/runtime-providers-claude', '@fleet/runtime-provider-sdk')
})

test('inside a group a package imports only the earlier-listed siblings', () => {
  allows('@fleet/runtime-providers-claude', '@fleet/runtime-provider-sdk')
  allows('@fleet/runtime-supervisor', '@fleet/runtime-provider-sdk')
  allows('@fleet/notify-macos', '@fleet/notify-core')
  allows('@fleet/orchestration-routines', '@fleet/orchestration-pm')
  // later or unordered is out
  assert.match(
    denies('@fleet/runtime-provider-sdk', '@fleet/runtime-supervisor'),
    /only the earlier-listed siblings/,
  )
  assert.match(
    denies('@fleet/orchestration-pm', '@fleet/orchestration-routines'),
    /only the earlier-listed siblings/,
  )
})

test('pm stays pure: foundation only', () => {
  allows('@fleet/orchestration-pm', '@fleet/foundation-core')
  assert.ok(checkEdge(edge('@fleet/orchestration-pm', '@fleet/orchestration-gate'), BY_NAME) !== null)
})

test('the daemon is the only wiring point', () => {
  // evals is the other package §17 lets reach across groups, so it is excluded here rather than allowed twice
  for (const p of WORKSPACE.filter((p) => p.group !== 'apps' && p.group !== 'evals')) {
    allows('@fleet/daemon', p.name)
  }
  allows('@fleet/daemon', '@fleet/foundation-store')
})

test('evals is a leaf consumer: it imports any group, and nothing imports evals', () => {
  // §17: a suite calls the real Judge and Provider path, which crosses groups on purpose
  allows('@fleet/evals-suites-judge', '@fleet/orchestration-judge')
  allows('@fleet/evals-suites-judge', '@fleet/runtime-providers-claude')
  allows('@fleet/evals-suites-judge', '@fleet/runtime-provider-deepinfra')
  allows('@fleet/evals-suites-judge', '@fleet/evals-adapter')
  allows('@fleet/evals-adapter', '@fleet/foundation-contracts')
  // and the edge back is refused: a product package that imported a suite would ship the eval harness to a peer
  assert.match(denies('@fleet/runtime-supervisor', '@fleet/evals-adapter'), /nothing imports evals/)
  assert.match(denies('@fleet/orchestration-judge', '@fleet/evals-suites-judge'), /nothing imports evals/)
  assert.match(denies('@fleet/daemon', '@fleet/evals-adapter'), /nothing imports evals/)
})

test('the eval tools are dev dependencies of packages/evals and of nothing else (§17)', async () => {
  const manifests = await readManifests(REPO_ROOT)
  assert.ok(manifests.length > 0, 'no manifests found; the scan is broken, not the tree')
  const problems = manifests.flatMap(({ pkg: manifestPkg, manifest }) => checkEvalTooling(manifestPkg, manifest))
  assert.equal(
    problems.join('\n'),
    '',
    `\n${problems.join('\n')}\n\n§17: promptfoo and the openevals libraries are dev tooling under packages/evals only.`,
  )
})

test('the eval tooling rule fires in both directions', () => {
  const suite = pkg('@fleet/evals-suites-judge', 'packages/evals/suites/judge')
  const runtime = pkg('@fleet/runtime-supervisor', 'packages/runtime/supervisor')
  // a suite may install it, as a dev dependency
  assert.deepEqual(checkEvalTooling(suite, { devDependencies: { promptfoo: '^0.125.1' } }), [])
  // never at runtime, not even in evals
  assert.match(
    checkEvalTooling(suite, { dependencies: { promptfoo: '^0.125.1' } }).join('\n'),
    /is a runtime dependency/,
  )
  // and not at all outside evals
  assert.match(
    checkEvalTooling(runtime, { devDependencies: { openevals: '^0.1.0' } }).join('\n'),
    /dev dependency outside packages\/evals/,
  )
  // an ordinary dev dependency is none of this rule's business
  assert.deepEqual(checkEvalTooling(runtime, { devDependencies: { typescript: '^5.9.3' } }), [])
})

test('clients and hooks reach foundation only, and apps never import apps', () => {
  allows('@fleet/cli', '@fleet/foundation-contracts')
  assert.match(denies('@fleet/cli', '@fleet/runtime-provider-sdk'), /foundation types only/)
  assert.match(denies('@fleet/tool-guard', '@fleet/foundation-store'), /foundation types only/)
  assert.match(denies('@fleet/cli', '@fleet/daemon'), /apps never import each other/)
  assert.match(denies('@fleet/tool-guard', '@fleet/cli'), /apps never import each other/)
})

test('nothing imports an app', () => {
  assert.match(denies('@fleet/runtime-supervisor', '@fleet/daemon'), /nothing imports an app/)
  assert.match(denies('@fleet/foundation-core', '@fleet/cli'), /nothing imports an app/)
})

test('an import of an unknown package is refused', () => {
  const reason = checkEdge(edge('@fleet/orchestration-pm', '@fleet/does-not-exist'), BY_NAME)
  assert.ok(reason !== null)
  assert.match(reason, /no package of this workspace/)
})

test('a package outside the §1.1 layout is refused', () => {
  assert.match(
    checkPackageShape(pkg('@fleet/random', 'packages/random/thing')) ?? '',
    /is not one of the groups of §1.1/,
  )
  assert.match(
    checkPackageShape(pkg('@fleet/stray', 'packages/orchestration/stray')) ?? '',
    /is not a package of orchestration/,
  )
  assert.match(checkPackageShape(pkg('@fleet/odd', 'apps/odd/app')) ?? '', /an app lives under apps\//)
})

test('the layout tables cover every group §1.1 names', () => {
  assert.deepEqual(Object.keys(PACKAGE_ORDER), [
    'foundation',
    'runtime',
    'orchestration',
    'workspace',
    'security',
    'notify',
    'integrations',
    'evals',
  ])
  assert.equal(appKind(pkg('@fleet/daemon', 'apps/daemon')), 'daemon')
  assert.equal(appKind(pkg('@fleet/cli', 'apps/clients/cli')), 'clients')
  assert.equal(appKind(pkg('@fleet/tool-guard', 'apps/hooks/tool-guard')), 'hooks')
})

test('a commented-out import is not an import', () => {
  const source = [
    "// import { a } from '@fleet/foundation-store'",
    " * import { b } from '@fleet/foundation-store'",
    "import { c } from './local.ts'",
    "export { d } from '@fleet/foundation-core'",
    "const lazy = await import('@fleet/foundation-contracts')",
  ].join('\n')
  assert.deepEqual(
    specifiersOf(source).map((s) => s.specifier),
    ['./local.ts', '@fleet/foundation-core', '@fleet/foundation-contracts'],
  )
})

test('a relative import that climbs out of its package, and a deep import, are both refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-arch-'))
  try {
    const a = join(root, 'packages/foundation/core')
    const b = join(root, 'packages/foundation/contracts')
    await mkdir(join(a, 'src'), { recursive: true })
    await mkdir(join(b, 'src'), { recursive: true })
    await writeFile(join(a, 'package.json'), JSON.stringify({ name: '@fleet/foundation-core' }))
    await writeFile(join(b, 'package.json'), JSON.stringify({ name: '@fleet/foundation-contracts' }))
    await writeFile(
      join(a, 'src/index.ts'),
      [
        "export * from '../../contracts/src/index.ts'",
        "export * from '@fleet/foundation-contracts/src/index.ts'",
        "export * from '@fleet/foundation-contracts'",
      ].join('\n'),
    )

    const packages = await readPackages(root)
    const byName = new Map(packages.map((p) => [p.name, p]))
    const core = byName.get('@fleet/foundation-core')
    assert.ok(core)
    const { edges, escapes } = await readEdges(root, core, byName)

    assert.equal(edges.length, 1, 'only the bare package import is an edge')
    assert.equal(escapes.length, 2)
    assert.match(escapes[0]?.message ?? '', /climbs out of its own package/)
    assert.match(escapes[1]?.message ?? '', /deep import/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
