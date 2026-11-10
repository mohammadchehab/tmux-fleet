/**
 * The projection registry (architecture §3). Every read model the clients see
 * is one of these, mapped to its schema; a golden fixture exists for each
 * entry, the same way `EVENT_SCHEMAS` works for events.
 *
 * The builders in `./work.ts` and its siblings are factories, so the registry
 * materialises them once here rather than exposing functions a caller must
 * remember to call. Nothing imported by a projection module imports this file,
 * so building them at module load is safe.
 */

import type { Infer, Schema } from '@fleet/foundation-core'
import { brief, contract, contractVersionRef, work } from './work.ts'
import { peer, peerCompactions, session } from './peers.ts'
import { build, holder, pullRequest, worktree } from './delivery.ts'
import { message } from './mailbox.ts'
import { decision, finding, notification, routine, tokenReport } from './ops.ts'
import { evalCase, evalRun } from './evals.ts'

export const PROJECTION_SCHEMAS = {
  peer: peer(),
  peerCompactions: peerCompactions(),
  session: session(),
  work: work(),
  contract: contract(),
  contractVersionRef: contractVersionRef(),
  brief: brief(),
  worktree: worktree(),
  holder: holder(),
  pullRequest: pullRequest(),
  build: build(),
  message: message(),
  decision: decision(),
  routine: routine(),
  notification: notification(),
  finding: finding(),
  tokenReport: tokenReport(),
  evalRun: evalRun(),
  evalCase: evalCase(),
} as const

export type ProjectionName = keyof typeof PROJECTION_SCHEMAS

/** Any projection row, as a union. A reader switches on which shape it holds. */
export type Projection = Infer<(typeof PROJECTION_SCHEMAS)[ProjectionName]>

export const projectionNames = Object.keys(PROJECTION_SCHEMAS) as readonly ProjectionName[]

export const projectionSchemaFor = <N extends ProjectionName>(name: N): (typeof PROJECTION_SCHEMAS)[N] =>
  PROJECTION_SCHEMAS[name]

/** The schema as a plain `Schema<unknown>`, for a test that reads fixtures by name. */
export const projectionSchema = (name: string): Schema<Projection> | undefined =>
  Object.hasOwn(PROJECTION_SCHEMAS, name)
    ? (PROJECTION_SCHEMAS[name as ProjectionName] as unknown as Schema<Projection>)
    : undefined
