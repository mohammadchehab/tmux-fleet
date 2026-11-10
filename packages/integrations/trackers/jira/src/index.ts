/**
 * `@fleet/integrations-trackers-jira`: Jira as a `Tracker`, behind the
 * contract's port (architecture §3).
 *
 * The board is a **source and a sink**, never the state of the fleet: an
 * issue's key travels in `Work.external`, `tracker-sync` reads issues into
 * `work.proposed` and writes the Work's own transitions back out, and nothing
 * else in the fleet knows Jira exists. `apps/daemon` is the only thing that
 * builds this, and it is the only thing that may name it (§1.1).
 *
 * Both deployment shapes authenticate from the profile, and a test injects
 * `fetch`: building and proving this adapter needs no site, no login and no URL
 * that resolves.
 */

export * from './adf.ts'
export * from './auth.ts'
export * from './client.ts'
export * from './observe.ts'
export * from './tracker.ts'
