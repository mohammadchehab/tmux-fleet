/**
 * `standup` (§6): the daily report, on the 09:00 schedule and on request.
 *
 * The PM decides *that* a standup is due and emits `render_standup`; the
 * executor renders it from the projections, with no model call (§5.2), and
 * writes `standup.rendered` — which is also what the `notify` routine reads to
 * put the banner up (§6.1). The routine itself carries no renderer: one way to
 * render is the point, and this is the seam where a second one would sneak in.
 *
 * `request` is why `fleet standup` can produce one on demand without a second
 * path: the CLI asks the scheduler to run this routine, and the run is an event
 * like every other (§6).
 */

import { runTick, type RoutineFactory } from '../routine.ts'

export const standup: RoutineFactory = (deps) => ({
  kind: 'standup',
  run: (context) => runTick(deps, context),
})
