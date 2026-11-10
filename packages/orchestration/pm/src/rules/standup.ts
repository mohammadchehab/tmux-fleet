/**
 * §6, §6.1 — the standup routine's half of the tick.
 *
 * The PM decides *that* today's standup is due; the renderer and `standup.rendered` belong to the executor, which is
 * where the projections are formatted and the peers counted (§6.1: "no model call"). Splitting it this way keeps a
 * schedule out of `decide`'s inputs — the tick says which routine asked and when — and lets a replay re-derive the
 * same `date` from the same clock.
 *
 * "Once a day" is read off the notification projection: `standup.rendered` opens the `standup:<date>` key, and a
 * key that already exists means today's report has been rendered. That is a rule over events like any other, so a
 * second schedule tick in the same day is a no-op rather than a second standup (§6.1).
 */

import { standupNotificationKey } from '@fleet/foundation-core'
import { draft, type Draft, type Rule } from './context.ts'

export const renderStandupDue: Rule = (ctx) => {
  const tick = ctx.tick
  if (tick === undefined || tick.kind !== 'standup') return []

  // the local day the tick is for, in the same `YYYY-MM-DD` shape `standup.rendered` carries
  const date = tick.at.slice(0, 10)
  if (ctx.state.notifications.some((row) => row.key === standupNotificationKey(date))) return []

  return [draft(`standup:${date}`, { kind: 'render_standup', causedBy: ctx.causedBy, date })]
}
