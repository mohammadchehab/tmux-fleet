/**
 * The board as HTML (§2, §3): one pure function from two daemon answers to a
 * string, so the page a person sees and the page a test asserts are the same
 * page rather than two renderings that agree by convention.
 *
 * Nothing here fetches, listens or formats a time against the wall clock: the
 * input is the `ls` status and the `work` rows exactly as `fleetd` answered
 * them, and the output is text. A board that showed a `Work` the projection does
 * not have, or hid one it does, would be a second opinion about the fleet (§2),
 * so every row below comes from `work` in the order it arrived — grouping by
 * state is a way of reading that list, never a filter on it.
 *
 * The page carries no script and loads nothing external. A read-only board does
 * not need either, and a board that cannot run code cannot be made to write.
 */

import { isWorkTerminal, workStates } from '@fleet/foundation-contracts'
import type { DaemonStatus, TokenReport, Work, WorkState } from '@fleet/foundation-contracts'

export interface BoardPage {
  readonly status: DaemonStatus
  readonly work: readonly Work[]
  /**
   * §6.2's cost report, as `ls` answered it: a peer's rollup row has no
   * `workId`, and a row that has one is what that Work has cost on that peer.
   * The board folds the per-Work rows together, because a Work with two peers
   * has two of them and the line is about the Work.
   */
  readonly usage: readonly TokenReport[]
  /** Rendered into the footer so a test can assert freshness without a clock. */
  readonly renderedAt: string
}

/** What one Work has spent: every peer's turns for it, added up. */
interface Spend {
  readonly turns: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
}

const spendByWork = (usage: readonly TokenReport[]): ReadonlyMap<string, Spend> => {
  const totals = new Map<string, Spend>()
  for (const report of usage) {
    if (report.workId === undefined) continue
    const current = totals.get(report.workId) ?? { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    totals.set(report.workId, {
      turns: current.turns + report.turns,
      inputTokens: current.inputTokens + report.inputTokens,
      outputTokens: current.outputTokens + report.outputTokens,
      costUsd: current.costUsd + report.costUsd,
    })
  }
  return totals
}

/** The fleet's bill, from the rollup rows only: the per-Work rows are their breakdown. */
const fleetSpend = (usage: readonly TokenReport[]): number =>
  usage.filter((report) => report.workId === undefined).reduce((sum, report) => sum + report.costUsd, 0)

/** Every string below is a value the store held, so every one of them is escaped. */
const escape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const link = (href: string, text: string): string =>
  // Only an absolute http(s) URL becomes an anchor: the href comes from a
  // tracker or a PR ref, and `javascript:` in an href would be an executable
  // board, which is the one thing this page must not be.
  /^https?:\/\//.test(href)
    ? `<a href="${escape(href)}">${escape(text)}</a>`
    : `<span>${escape(text)}</span>`

const prLabel = (pr: Work['prs'][number]): string => `${pr.repo}#${String(pr.number)}`

const row = (item: Work, spend: Spend | undefined): string => {
  const facts: string[] = []
  if (item.assignee !== undefined) facts.push(`<span class="who">${escape(item.assignee)}</span>`)
  if (item.role !== undefined) facts.push(`<span class="role">${escape(item.role)}</span>`)
  for (const pr of item.prs) {
    const url = `https://github.com/${pr.repo}/pull/${String(pr.number)}`
    facts.push(link(url, prLabel(pr)))
  }
  if (item.external !== undefined) {
    const label = `${item.external.system}:${item.external.key}`
    facts.push(item.external.url === undefined ? `<span>${escape(label)}</span>` : link(item.external.url, label))
  }
  const blocked = item.blockedReason === undefined ? '' : `<p class="why">${escape(item.blockedReason)}</p>`
  // What this Work has cost so far, as the report measured it. A Work with no
  // turn gets no line: `$0.00` would claim a Work that was free rather than one
  // nothing has been recorded against (§6.2).
  const cost =
    spend === undefined
      ? ''
      : `<p class="cost">${escape(
          `${String(spend.turns)} turns · in ${String(spend.inputTokens)} out ${String(spend.outputTokens)} · $${spend.costUsd.toFixed(2)}`,
        )}</p>`
  return [
    '<li class="work">',
    `<span class="id">${escape(item.workId)}</span>`,
    `<span class="title">${escape(item.title)}</span>`,
    facts.length === 0 ? '' : `<span class="facts">${facts.join(' ')}</span>`,
    blocked,
    cost,
    '</li>',
  ].join('')
}

const column = (state: WorkState, items: readonly Work[], spend: ReadonlyMap<string, Spend>): string => {
  const rows = items.map((item) => row(item, spend.get(item.workId))).join('\n')
  return [
    `<section class="state ${isWorkTerminal(state) ? 'done' : 'open'}">`,
    `<h2>${escape(state)}<span class="count">${String(items.length)}</span></h2>`,
    `<ul>${rows}</ul>`,
    '</section>',
  ].join('')
}

/**
 * The whole page. States with no Work are left out rather than shown empty: a
 * board's columns are the states the fleet is actually in, and eleven empty
 * columns would make `blocked` — the one worth noticing — easy to miss.
 */
export const renderBoard = (page: BoardPage): string => {
  const spend = spendByWork(page.usage)
  const columns = workStates
    .map((state) => ({ state, items: page.work.filter((item) => item.state === state) }))
    .filter((group) => group.items.length > 0)
    .map((group) => column(group.state, group.items, spend))
    .join('\n')

  const body =
    page.work.length === 0
      ? '<p class="empty">No Work yet. The board shows what the projection holds; it does not invent a row.</p>'
      : `<div class="board">\n${columns}\n</div>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fleet ${escape(page.status.profile)}</title>
<style>
:root { color-scheme: light dark; --bg: #fbfaf8; --fg: #1d1c1a; --muted: #6b6862; --line: #ddd9d2; --open: #2f6f4f; --done: #8a8781; }
@media (prefers-color-scheme: dark) { :root { --bg: #1a1918; --fg: #ece9e4; --muted: #9c9891; --line: #34312d; --open: #7dc4a0; --done: #6f6c67; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 1.5rem; background: var(--bg); color: var(--fg); font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
header { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; align-items: baseline; padding-bottom: 1rem; border-bottom: 1px solid var(--line); }
h1 { margin: 0; font-size: 1.1rem; }
header .meta { color: var(--muted); font-size: 0.85rem; }
.board { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; padding-top: 1rem; align-items: start; }
.state h2 { display: flex; justify-content: space-between; margin: 0 0 0.5rem; font-size: 0.8rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--open); }
.state.done h2 { color: var(--done); }
.count { color: var(--muted); font-variant-numeric: tabular-nums; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
.work { display: grid; gap: 0.15rem; padding: 0.6rem 0.7rem; border: 1px solid var(--line); border-radius: 6px; }
.id { color: var(--muted); font: 11px ui-monospace, monospace; }
.title { font-weight: 600; }
.facts { display: flex; flex-wrap: wrap; gap: 0.5rem; color: var(--muted); font-size: 0.85rem; }
.facts a { color: inherit; }
.why { margin: 0.25rem 0 0; color: var(--muted); font-size: 0.85rem; font-style: italic; }
.cost { margin: 0.25rem 0 0; color: var(--muted); font-size: 0.8rem; font-variant-numeric: tabular-nums; }
.empty { padding: 2rem 0; color: var(--muted); }
footer { margin-top: 1.5rem; padding-top: 0.75rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.8rem; }
</style>
</head>
<body>
<header>
<h1>fleet ${escape(page.status.profile)}</h1>
<span class="meta">${String(page.work.length)} work item${page.work.length === 1 ? '' : 's'}</span>
<span class="meta">$${fleetSpend(page.usage).toFixed(2)} spent</span>
<span class="meta">fleetd ${escape(String(page.status.pid))}</span>
</header>
${body}
<footer>read ${escape(page.renderedAt)} from ${escape(page.status.socketPath)}; this page is a read of the log, not a view of its own</footer>
</body>
</html>
`
}

/** The same page when there is no daemon to read: the board says so instead of failing to load. */
export const renderUnreachable = (socketPath: string, problem: string, renderedAt: string): string =>
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>fleet board: no daemon</title></head>
<body style="font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; padding: 1.5rem">
<h1>No fleetd answering</h1>
<p>${escape(problem)}</p>
<p style="color: #6b6862">Looked for the socket at ${escape(socketPath)}.</p>
<p style="color: #6b6862">Read at ${escape(renderedAt)}. Reload once the daemon is up.</p>
</body>
</html>
`
