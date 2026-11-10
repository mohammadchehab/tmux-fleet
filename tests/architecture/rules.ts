// tests/architecture/rules.ts — the dependency-direction rules of docs/design/fleet-v2-architecture.md §1.1,
// as data plus a pure check. No filesystem access here, so the rules themselves are unit-testable; workspace.ts
// reads the tree and dependency-rules.test.ts joins the two.
//
// The shape of the rule set (§1.1 "Dependency direction, by group"):
//   foundation   <-  runtime, orchestration, workspace, security, notify, integrations
//   apps/daemon  <-  all groups                  (the only wiring point)
//   apps/clients, apps/hooks -> foundation types, and the daemon API over its socket
//   groups never import each other sideways; they declare a port in foundation/contracts and the daemon injects it.

/** A package of the workspace, identified by its package.json name and its directory. */
export type PackageRef = {
  /** The package.json name, e.g. `@fleet/foundation-core`. */
  readonly name: string
  /** Path from the repo root, POSIX separators, e.g. `packages/runtime/providers/sdk`. */
  readonly dir: string
  /** `foundation | runtime | orchestration | workspace | security | notify | integrations | apps`. */
  readonly group: string
  /** Path inside the group: `core`, `providers/sdk`, `daemon`, `clients/cli`. */
  readonly key: string
}

/** One resolved import: `from` imports `to` at `line` of `file`. */
export type ImportEdge = {
  readonly from: string
  readonly to: string
  readonly file: string
  readonly line: number
  readonly specifier: string
}

export type Violation = {
  readonly file: string
  readonly line: number
  readonly package: string
  readonly message: string
}

/**
 * The order of packages inside each group. A package may import an *earlier* package of its own group and no
 * later one, which is the doc's "only the earlier-listed siblings they need" (§1.1).
 *
 * Two notes on the order:
 * - `security` is listed as findings-then-scanners even though §1.1 prints `{scanners, findings}`, because the doc
 *   states the edge the other way round: "scanners imports findings types".
 * - `foundation` gives contracts -> core and store -> {core, contracts}, which is exactly the earlier-only rule.
 */
export const PACKAGE_ORDER: Readonly<Record<string, readonly string[]>> = {
  foundation: ['core', 'contracts', 'store'],
  runtime: [
    'providers/sdk',
    'providers/claude',
    'providers/deepinfra',
    'providers/opencode',
    'providers/cursor',
    'supervisor',
    'mailbox',
  ],
  orchestration: ['pm', 'routines', 'briefs', 'gate', 'ledger'],
  workspace: ['worktree', 'codegraph'],
  security: ['findings', 'scanners'],
  notify: ['core', 'channels/macos'],
  integrations: ['github', 'trackers'],
}

export const APP_KINDS = ['daemon', 'clients', 'hooks'] as const
export type AppKind = (typeof APP_KINDS)[number]

/** `@fleet/foundation-core` -> `{ group: 'foundation', key: 'core' }`; null when the directory is not in the layout. */
export function locate(dir: string): { group: string; key: string } | null {
  const parts = dir.split('/')
  if (parts[0] === 'packages' && parts.length >= 3) {
    const [, group, ...rest] = parts
    return { group: group as string, key: rest.join('/') }
  }
  if (parts[0] === 'apps' && parts.length >= 2) {
    return { group: 'apps', key: parts.slice(1).join('/') }
  }
  return null
}

export function appKind(pkg: PackageRef): AppKind | null {
  if (pkg.group !== 'apps') return null
  const head = pkg.key.split('/')[0]
  return (APP_KINDS as readonly string[]).includes(head ?? '') ? (head as AppKind) : null
}

// `providers/sdk` counts: it is the surface a provider is written against, so it gets the same ban on the store
// that §1.1 puts on every provider.
export function isProvider(pkg: PackageRef): boolean {
  return pkg.group === 'runtime' && pkg.key.startsWith('providers/')
}

function orderOf(pkg: PackageRef): number {
  return PACKAGE_ORDER[pkg.group]?.indexOf(pkg.key) ?? -1
}

/**
 * Check one resolved edge. Returns null when the import is allowed, else the reason it is not.
 * Exported so the test can prove every rule fires, without a tree that actually breaks it.
 */
export function checkEdge(edge: ImportEdge, packages: ReadonlyMap<string, PackageRef>): string | null {
  const from = packages.get(edge.from)
  const to = packages.get(edge.to)
  if (!from) return `importer ${edge.from} is not a workspace package`
  if (!to) {
    return `imports ${edge.to}, which is no package of this workspace (a typo, or a package.json is missing)`
  }

  // Nothing may import an app. The daemon is started, not linked. Checked before every other rule so the message
  // is always about the app, whatever the importer is.
  if (from.group === 'apps' && to.group === 'apps') {
    return `app imports app ${to.name}; apps never import each other — clients talk to the daemon over its socket (§1.1)`
  }
  if (to.group === 'apps') {
    return `imports the app ${to.name}; nothing imports an app (§1.1)`
  }

  // foundation is the floor: it may not reach up into a group.
  if (from.group === 'foundation' && to.group !== 'foundation') {
    return `foundation imports ${to.group}; foundation is what everything else may import, never the reverse`
  }

  if (from.group === 'apps') {
    const kind = appKind(from)
    if (kind === 'daemon') return null // the only wiring point: daemon may import every group
    // clients and hooks get foundation types and ports; the store is the supervisor's alone, so it stays out of reach
    if (to.group === 'foundation' && to.key !== 'store') return null
    return `an app of kind '${kind}' imports ${to.group}; clients and hooks use foundation types only and reach the daemon over its socket (§1.1)`
  }

  // A provider never imports the store; the supervisor adapts its events into the store (§1.1).
  if (isProvider(from) && to.group === 'foundation' && to.key === 'store') {
    return `provider imports @fleet/foundation-store; a provider never imports the store — the supervisor adapts its events (§1.1)`
  }

  if (to.group === 'foundation') return null // every package may import foundation

  // From here on `to` is inside a group. Sideways is out; same-group must respect the order.
  if (to.group !== from.group) {
    return `${from.group} imports ${to.group}; groups never import each other sideways — declare the port in @fleet/foundation-contracts and let apps/daemon inject it (§1.1)`
  }

  const fromOrder = orderOf(from)
  const toOrder = orderOf(to)
  if (toOrder < 0 || fromOrder < 0) {
    return `${from.key} or ${to.key} is not in the ${from.group} order of §1.1; add it to PACKAGE_ORDER in tests/architecture/rules.ts`
  }
  if (toOrder >= fromOrder) {
    return `${from.group}/${from.key} imports its sibling ${from.group}/${to.key}; inside a group a package imports only the earlier-listed siblings it needs (§1.1)`
  }
  return null
}

/** A package whose directory is not a place §1.1 allows. Returned as a violation, not thrown, so the report is whole. */
export function checkPackageShape(pkg: PackageRef): string | null {
  if (pkg.group === 'apps') {
    const kind = appKind(pkg)
    if (!kind) return `apps/${pkg.key}: an app lives under apps/{${APP_KINDS.join('|')}}/ (§1.1)`
    return null
  }
  if (!Object.hasOwn(PACKAGE_ORDER, pkg.group)) {
    return `${pkg.dir}: '${pkg.group}' is not one of the groups of §1.1 (${Object.keys(PACKAGE_ORDER).join(', ')})`
  }
  const order = PACKAGE_ORDER[pkg.group]
  if (!order?.includes(pkg.key)) {
    return `${pkg.dir}: ${pkg.key} is not a package of ${pkg.group} in §1.1; add it to PACKAGE_ORDER in tests/architecture/rules.ts`
  }
  return null
}

export function formatViolation(v: Violation): string {
  return `${v.file}:${v.line}  ${v.message}`
}

/** Check every edge and every package shape. Empty array means the tree obeys §1.1. */
export function checkWorkspace(
  packages: readonly PackageRef[],
  edges: readonly ImportEdge[],
): Violation[] {
  const byName = new Map(packages.map((p) => [p.name, p]))
  const violations: Violation[] = []
  for (const pkg of packages) {
    const shape = checkPackageShape(pkg)
    if (shape) violations.push({ file: pkg.dir, line: 1, package: pkg.name, message: shape })
  }
  for (const edge of edges) {
    const message = checkEdge(edge, byName)
    if (message) {
      violations.push({ file: edge.file, line: edge.line, package: edge.from, message })
    }
  }
  return violations
}
