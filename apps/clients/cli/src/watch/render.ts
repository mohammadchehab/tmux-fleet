/**
 * The watch's screen, as lines of text (watch-and-attach §7).
 *
 * A pure function from a `WatchState` to the lines to paint. Every line is cut
 * or padded to the terminal width *before* any escape sequence is added, so a
 * colour never changes how much fits, and a test can strip the escapes and
 * assert on columns.
 */

import type { LsResult, Peer, PeerActivity } from '@fleet/foundation-contracts'
import type { PeerState } from '@fleet/foundation-core'

import { needsYou, type Need } from './needs.ts'
import { focusedPeer, selectables, type Menu, type TimelineItem, type WatchState } from './model.ts'
import { fit, stripControl, wrap } from './text.ts'

const marks: Readonly<Record<PeerState, string>> = {
  starting: '…',
  working: '●',
  idle: '○',
  waiting_input: '?',
  held: '◐',
  stopped: '■',
  ended: '·',
  failed: '✕',
}

export const markOf = (state: PeerState): string => marks[state]

const reverse = (text: string): string => `\u001b[7m${text}\u001b[0m`
const dim = (text: string): string => `\u001b[2m${text}\u001b[0m`
const bold = (text: string): string => `\u001b[1m${text}\u001b[0m`

/** Context used as a whole percent, or undefined when the peer has no recorded turn. */
export const contextPercent = (activity: PeerActivity | undefined): number | undefined =>
  activity?.contextTokens === undefined || activity.contextLimit === undefined || activity.contextLimit === 0
    ? undefined
    : Math.round((activity.contextTokens / activity.contextLimit) * 100)

const activityOf = (ls: LsResult, peer: Peer): PeerActivity | undefined => ls.activity.find((row) => row.peerId === peer.peerId)

/** What a peer is doing now, in a few words: its last tool and target when it is working. */
export const doingNow = (peer: Peer, activity: PeerActivity | undefined): string => {
  if (peer.state === 'waiting_input') return 'waiting for an answer'
  if (peer.state === 'held') return 'held — a person has it'
  if (peer.state === 'stopped') return 'stopped'
  if (peer.state === 'failed' || peer.state === 'ended') return peer.state
  if (activity?.lastTool === undefined) return peer.state === 'working' ? 'working' : ''
  return activity.lastTarget === undefined ? activity.lastTool : `${activity.lastTool} ${activity.lastTarget}`
}

/** Age as `12s`, `4m`, `3h`, `2d`; the viewer reads "how long", not a timestamp. */
export const ageOf = (iso: string, nowMs: number): string => {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return '-'
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}h`
  return `${String(Math.floor(seconds / 86_400))}d`
}

const needLine = (need: Need, nowMs: number): string =>
  need.kind === 'decision'
    ? `! ${need.decision.question}  (${String(need.decision.options.length)} options, ${ageOf(need.since, nowMs)})`
    : `? ${need.peer.peerId} is waiting for an answer  (${ageOf(need.since, nowMs)})`

const peerLine = (ls: LsResult, peer: Peer, width: number): string => {
  const percent = contextPercent(activityOf(ls, peer))
  const hot = percent !== undefined && percent / 100 >= ls.status.purgeContextRatio
  const ctx = percent === undefined ? '' : `${String(percent)}%${hot ? '!' : ''}`
  const head = `${markOf(peer.state)} ${peer.peerId}`
  const tail = ctx
  const middle = width - [...head].length - [...tail].length - 2
  const doing = middle > 4 ? fit(doingNow(peer, activityOf(ls, peer)), middle) : ''
  return fit(`${head} ${doing} ${tail}`.trimEnd(), width)
}

const timelineLine = (item: TimelineItem): string => {
  if (item.kind === 'mail') return `✉ mail ${item.phase}${item.from === undefined ? '' : ` from ${item.from}`}`
  const line = item.line
  switch (line.kind) {
    case 'text':
      return line.text
    case 'tool':
      return `⚙ ${line.tool}${line.summary === undefined ? '' : ` ${line.summary}`}`
    case 'turn':
      return line.phase === 'started' ? '— turn started —' : `— turn ended${line.reason === undefined ? '' : ` (${line.reason})`} —`
  }
}

/** The newest `height` wrapped lines of a peer's timeline. */
export const detailLines = (items: readonly TimelineItem[], width: number, height: number): readonly string[] => {
  const wrapped = items.flatMap((item) => wrap(timelineLine(item), width))
  return wrapped.slice(Math.max(0, wrapped.length - height))
}

const menuLines = (menu: Menu, width: number): readonly string[] => [
  bold(fit(menu.title, width)),
  ...menu.items.map((item, index) => {
    const text = fit(`${index === menu.index ? '>' : ' '} ${item.label}`, width)
    return index === menu.index ? reverse(text) : text
  }),
  dim(fit('enter choose · esc back', width)),
]

const hints = 'j/k move · enter act · r refresh · q quit'

/** Everything the screen shows, as exactly `rows` lines of `cols` columns (plus escapes). */
export const render = (state: WatchState, nowMs: number): readonly string[] => {
  const { cols, rows } = state
  const out: string[] = []
  const link = state.link === 'live' ? 'live' : state.link === 'connecting' ? 'connecting…' : 'link lost — retrying'
  out.push(bold(fit(`fleet watch · ${link}`, cols)))

  if (state.ls === undefined) {
    out.push(fit('waiting for fleetd…', cols))
  } else {
    const ls = state.ls
    const needs = needsYou(ls)
    const selection = selectables(state)
    out.push(fit(`NEEDS YOU (${String(needs.length)})`, cols))
    if (needs.length === 0) out.push(dim(fit('  nothing waits on you', cols)))
    needs.forEach((need, index) => {
      const text = fit(`  ${needLine(need, nowMs)}`, cols)
      out.push(selection[state.selected]?.kind === 'need' && state.selected === index ? reverse(text) : text)
    })
    out.push(fit(`PEERS (${String(ls.peers.length)})`, cols))

    const listWidth = Math.min(40, Math.max(24, Math.floor(cols * 0.4)))
    const detailWidth = Math.max(0, cols - listWidth - 3)
    // Rows left for the body: the screen less what is drawn above, the footer, and the notice.
    const bodyHeight = Math.max(3, rows - out.length - 2)
    const peer = focusedPeer(state)
    const detail: readonly string[] =
      state.menu !== undefined
        ? menuLines(state.menu, detailWidth)
        : peer === undefined
          ? []
          : [dim(fit(`${peer.peerId} · ${peer.role} · ${peer.providerId}/${peer.model}`, detailWidth)), ...detailLines(state.timelines.get(peer.peerId) ?? [], detailWidth, bodyHeight - 1)]
    for (let row = 0; row < bodyHeight; row += 1) {
      const peerRow = ls.peers[row]
      const left =
        peerRow === undefined
          ? ' '.repeat(listWidth)
          : (() => {
              const text = peerLine(ls, peerRow, listWidth)
              const index = needs.length + row
              return state.selected === index ? reverse(text) : text
            })()
      out.push(`${left} │ ${detail[row] ?? ''}`)
    }
  }

  // Pad so the footer is the last line, whatever the body used.
  while (out.length < rows - 1) out.push('')
  if (state.compose !== undefined) {
    out.push(fit(`${state.compose.to.kind === 'peer' ? `to ${state.compose.to.peer}` : 'answer'}: ${state.compose.text}▌`, cols))
  } else {
    out.push(dim(fit(state.notice ?? hints, cols)))
  }
  return out.slice(0, rows)
}

/**
 * `fleet watch --once`: the strip and the table, with no selection, no detail
 * and no escapes — what a script or a transcript can read.
 *
 * It lays out no colours of its own, so it never passes through `fit`, and a
 * line of it is exactly the peer's words with nothing added: every line is
 * stripped whole rather than field by field, which is the one place a field
 * could be missed (TASK-105).
 */
export const renderOnce = (ls: LsResult, nowMs: number): readonly string[] => {
  const needs = needsYou(ls)
  const out: string[] = [`NEEDS YOU (${String(needs.length)})`]
  if (needs.length === 0) out.push('  nothing waits on you')
  for (const need of needs) out.push(stripControl(`  ${needLine(need, nowMs)}`))
  out.push(`PEERS (${String(ls.peers.length)})`)
  // The column is as wide as the id *looks*, not as wide as the bytes it took,
  // or one peer's escapes would misalign every row under it.
  const names = new Map(ls.peers.map((peer) => [peer.peerId, stripControl(peer.peerId)]))
  const width = Math.max(0, ...[...names.values()].map((name) => name.length))
  for (const peer of ls.peers) {
    const activity = activityOf(ls, peer)
    const percent = contextPercent(activity)
    const hot = percent !== undefined && percent / 100 >= ls.status.purgeContextRatio
    const id = names.get(peer.peerId) ?? ''
    out.push(
      stripControl(
        `  ${markOf(peer.state)} ${id.padEnd(width)}  ${peer.state.padEnd(13)}  ${percent === undefined ? '-' : `${String(percent)}%${hot ? '!' : ''}`}  ${doingNow(peer, activity)}`.trimEnd(),
      ),
    )
  }
  return out
}

