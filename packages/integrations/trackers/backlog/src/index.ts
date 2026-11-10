/**
 * `@fleet/integrations-trackers-backlog`: Backlog.md as a `Tracker`, behind the
 * contract's port (architecture §3).
 *
 * The board is a **source and a sink**, never the state of the fleet: a card's
 * key travels in `Work.external`, `tracker-sync` reads cards into `work.proposed`
 * and writes the Work's own transitions back out, and nothing else in the fleet
 * knows the CLI exists. `apps/daemon` is the only thing that builds this, and it
 * is the only thing that may name it (§1.1).
 */

export * from './cli.ts'
export * from './observe.ts'
export * from './tracker.ts'
