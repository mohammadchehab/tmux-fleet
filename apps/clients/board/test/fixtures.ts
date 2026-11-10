/**
 * One valid `ls` and `work` answer, for tests that are about rendering and not
 * about the daemon. Values are literal and spelled the way the contract spells
 * them, so a field renamed in `@fleet/foundation-contracts` fails the type check
 * here rather than silently rendering `undefined` on a page.
 */

import type { DaemonStatus, LsResult, Work, WorkState } from '@fleet/foundation-contracts'
import type { PeerId, Repo, WorkId } from '@fleet/foundation-core'

export const statusFixture = (): DaemonStatus => ({
  profile: 'firstrun',
  pid: 4242,
  startedAt: '2026-11-10T08:00:00.000Z',
  socketPath: '/home/someone/.fleet/firstrun/daemon/fleetd.sock',
  storePath: '/home/someone/.fleet/firstrun/store.db',
})

export const lsFixture = (): LsResult => ({
  status: statusFixture(),
  peers: [],
  routines: [],
  decisions: [],
  compactions: [],
  tokens: [],
})

/**
 * A Work row. The id is taken as a plain string and branded here, so a test
 * reads `workFixture({ workId: 'wrk_…' })` rather than casting on every line.
 */
export const workFixture = (overrides: Partial<Omit<Work, 'workId'>> & { readonly workId: string }): Work => {
  const { workId: raw, ...rest } = overrides
  return {
    workId: raw as WorkId,
    title: 'Retarget stacked PRs before merging',
    state: 'proposed' as WorkState,
    dependsOn: [],
    prs: [],
    createdAt: '2026-11-10T09:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
    ...rest,
  }
}

export const PEER = 'engineer-1' as PeerId
export const REPO = 'mohammadchehab/tmux-fleet' as Repo
