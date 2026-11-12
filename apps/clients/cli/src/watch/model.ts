/**
 * The watch's state and what a key or a frame does to it (watch-and-attach §7).
 *
 * `reduce` is a pure function: a state and an input in, a state and the effects
 * the IO layer should run out. Nothing here touches a terminal, a socket or a
 * clock, which is what makes the render and the key handling tests with no
 * terminal in them.
 *
 * No key reaches a peer. The only things a key can do are move the selection,
 * open a menu, and ask the daemon to do what the menu says.
 */

import type { DisplayLine, LsResult, Peer, WatchFrame, WatchRow } from '@fleet/foundation-contracts'
import type { DecisionId, PeerId } from '@fleet/foundation-core'

import type { Key } from './keys.ts'
import { needsYou, type Need } from './needs.ts'

/** What the detail pane shows, oldest first: lines the peer said, and the mail that reached it. */
export type TimelineItem =
  | { readonly seq: number; readonly kind: 'line'; readonly line: DisplayLine }
  | {
      readonly seq: number
      readonly kind: 'mail'
      readonly phase: 'sent' | 'delivered'
      readonly from?: string
      readonly mailKind?: string
      readonly text?: string
    }

/** The most items the client keeps per peer; the daemon's own ring is the history. */
export const timelineLimit = 300

export type Selectable =
  | { readonly kind: 'need'; readonly need: Need }
  | { readonly kind: 'peer'; readonly peer: Peer }

/** What a menu item does. Each is one daemon call, run by the IO layer. */
export type Action =
  | { readonly kind: 'attach'; readonly peer: PeerId; readonly now: boolean }
  | { readonly kind: 'interrupt'; readonly peer: PeerId }
  | { readonly kind: 'release'; readonly peer: PeerId }
  | { readonly kind: 'stop'; readonly peer: PeerId; readonly now: boolean }
  | { readonly kind: 'start'; readonly peer: PeerId }
  | { readonly kind: 'compose'; readonly peer: PeerId }
  /** A decision with no options is answered in the person's own words. */
  | { readonly kind: 'compose-decision'; readonly id: DecisionId }
  | { readonly kind: 'decide'; readonly id: DecisionId; readonly option: string }

export interface MenuItem {
  readonly label: string
  readonly action: Action
}

export interface Menu {
  readonly title: string
  readonly items: readonly MenuItem[]
  readonly index: number
}

export interface Compose {
  readonly to: { readonly kind: 'peer'; readonly peer: PeerId } | { readonly kind: 'decision'; readonly id: DecisionId }
  readonly text: string
}

export type Link = 'connecting' | 'live' | 'lost'

export interface WatchState {
  readonly ls: LsResult | undefined
  readonly timelines: ReadonlyMap<PeerId, readonly TimelineItem[]>
  readonly link: Link
  /** The newest seq seen on the stream, for a reconnect's `since`. */
  readonly lastSeq: number
  readonly selected: number
  readonly menu: Menu | undefined
  readonly compose: Compose | undefined
  /** One line of what the last action did, or why it failed. */
  readonly notice: string | undefined
  readonly cols: number
  readonly rows: number
  /** The viewer's offset from UTC in minutes, for the clock. */
  readonly offsetMinutes: number
}

export const initialState = (size: { cols: number; rows: number }, offsetMinutes = 0): WatchState => ({
  ls: undefined,
  timelines: new Map(),
  link: 'connecting',
  lastSeq: 0,
  selected: 0,
  menu: undefined,
  compose: undefined,
  notice: undefined,
  cols: size.cols,
  rows: size.rows,
  offsetMinutes,
})

export type Input =
  | { readonly type: 'snapshot'; readonly ls: LsResult }
  | { readonly type: 'frame'; readonly frame: WatchFrame }
  | { readonly type: 'key'; readonly key: Key }
  | { readonly type: 'link'; readonly link: Link }
  | { readonly type: 'notice'; readonly text: string | undefined }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number }

export type Effect =
  | { readonly kind: 'run'; readonly action: Action }
  | { readonly kind: 'send'; readonly peer: PeerId; readonly body: string }
  /** The fleet changed in a way the snapshot should hear about: re-read `ls`. */
  | { readonly kind: 'refresh' }
  | { readonly kind: 'quit' }

export interface Step {
  readonly state: WatchState
  readonly effects: readonly Effect[]
}

const stay = (state: WatchState): Step => ({ state, effects: [] })

/** The rows the selection moves through: the needs-you strip first, then the peers. */
export const selectables = (state: WatchState): readonly Selectable[] => {
  if (state.ls === undefined) return []
  return [
    ...needsYou(state.ls).map((need): Selectable => ({ kind: 'need', need })),
    ...state.ls.peers.map((peer): Selectable => ({ kind: 'peer', peer })),
  ]
}

/** The peer the detail pane is about: the selected peer, or the peer a selected need is about. */
export const focusedPeer = (state: WatchState): Peer | undefined => {
  const row = selectables(state)[state.selected]
  if (row === undefined) return undefined
  if (row.kind === 'peer') return row.peer
  return row.need.kind === 'peer' ? row.need.peer : undefined
}

const clamp = (state: WatchState): WatchState => {
  const count = selectables(state).length
  const selected = count === 0 ? 0 : Math.min(Math.max(state.selected, 0), count - 1)
  return selected === state.selected ? state : { ...state, selected }
}

/** What a person can do to a peer, by where it is. Take over comes first. */
export const peerMenu = (peer: Peer): Menu => {
  const id = peer.peerId
  const running = peer.state === 'working' || peer.state === 'idle' || peer.state === 'waiting_input' || peer.state === 'starting'
  const items: MenuItem[] =
    peer.state === 'held'
      ? [
          { label: 'Reopen the native session', action: { kind: 'attach', peer: id, now: false } },
          { label: 'Release back to fleetd', action: { kind: 'release', peer: id } },
        ]
      : peer.state === 'stopped'
        ? [{ label: 'Start this peer', action: { kind: 'start', peer: id } }]
        : running
          ? [
              { label: 'Take over when this turn ends', action: { kind: 'attach', peer: id, now: false } },
              { label: 'Take over now', action: { kind: 'attach', peer: id, now: true } },
              { label: 'Interrupt the turn, stay headless', action: { kind: 'interrupt', peer: id } },
              { label: 'Send a message', action: { kind: 'compose', peer: id } },
              { label: 'Stop this peer', action: { kind: 'stop', peer: id, now: false } },
            ]
          : []
  // A peer that failed or ended has no session to take over; a message is still how a person reaches it.
  if (items.length === 0) items.push({ label: 'Send a message', action: { kind: 'compose', peer: id } })
  return { title: `${id} — ${peer.state}`, items, index: 0 }
}

/** The options of a decision, and nothing else: choosing one is the `decide` call. */
export const decisionMenu = (need: Extract<Need, { kind: 'decision' }>): Menu => ({
  title: need.decision.question,
  items:
    need.decision.options.length === 0
      ? [{ label: 'Answer in your own words', action: { kind: 'compose-decision', id: need.decision.decisionId } }]
      : need.decision.options.map((option): MenuItem => ({ label: option, action: { kind: 'decide', id: need.decision.decisionId, option } })),
  index: 0,
})

const menuFor = (row: Selectable | undefined): Menu | undefined => {
  if (row === undefined) return undefined
  if (row.kind === 'peer') return peerMenu(row.peer)
  if (row.need.kind === 'peer') return peerMenu(row.need.peer)
  return decisionMenu(row.need)
}

const keepNewest = (items: readonly TimelineItem[], item: TimelineItem): readonly TimelineItem[] =>
  items.length >= timelineLimit ? [...items.slice(items.length - timelineLimit + 1), item] : [...items, item]

const withTimeline = (state: WatchState, peer: PeerId, item: TimelineItem): WatchState => {
  const timelines = new Map(state.timelines)
  timelines.set(peer, keepNewest(timelines.get(peer) ?? [], item))
  return { ...state, timelines }
}

const applyRow = (state: WatchState, seq: number, row: WatchRow): Step => {
  switch (row.kind) {
    case 'mail':
      return {
        state: withTimeline(state, row.to, {
          seq,
          kind: 'mail',
          phase: row.phase,
          ...(row.from === undefined ? {} : { from: row.from }),
          ...(row.mailKind === undefined ? {} : { mailKind: row.mailKind }),
          ...(row.text === undefined ? {} : { text: row.text }),
        }),
        // Mail does not change what the list shows; a state or a decision does.
        effects: [],
      }
    case 'state':
    case 'decision':
      return { state, effects: [{ kind: 'refresh' }] }
  }
}

const applyFrame = (state: WatchState, frame: WatchFrame): Step => {
  switch (frame.stream) {
    case 'line':
      return stay({ ...withTimeline(state, frame.peerId, { seq: frame.seq, kind: 'line', line: frame.line }), lastSeq: Math.max(state.lastSeq, frame.seq) })
    case 'row': {
      const step = applyRow({ ...state, lastSeq: Math.max(state.lastSeq, frame.seq) }, frame.seq, frame.row)
      return step
    }
    case 'ready':
      return { state: { ...state, link: 'live', lastSeq: Math.max(state.lastSeq, frame.seq) }, effects: [{ kind: 'refresh' }] }
    case 'end':
      return stay({ ...state, link: 'lost' })
  }
}

const onMenuKey = (state: WatchState, menu: Menu, key: Key): Step => {
  switch (key.kind) {
    case 'up':
      return stay({ ...state, menu: { ...menu, index: Math.max(0, menu.index - 1) } })
    case 'down':
      return stay({ ...state, menu: { ...menu, index: Math.min(menu.items.length - 1, menu.index + 1) } })
    case 'escape':
    case 'ctrl-c':
      return stay({ ...state, menu: undefined })
    case 'enter': {
      const item = menu.items[menu.index]
      if (item === undefined) return stay({ ...state, menu: undefined })
      if (item.action.kind === 'compose') return stay({ ...state, menu: undefined, compose: { to: { kind: 'peer', peer: item.action.peer }, text: '' } })
      if (item.action.kind === 'compose-decision') return stay({ ...state, menu: undefined, compose: { to: { kind: 'decision', id: item.action.id }, text: '' } })
      return { state: { ...state, menu: undefined, notice: undefined }, effects: [{ kind: 'run', action: item.action }] }
    }
    default:
      return stay(state)
  }
}

const onComposeKey = (state: WatchState, compose: Compose, key: Key): Step => {
  switch (key.kind) {
    case 'escape':
    case 'ctrl-c':
      return stay({ ...state, compose: undefined })
    case 'backspace':
      return stay({ ...state, compose: { ...compose, text: [...compose.text].slice(0, -1).join('') } })
    case 'char':
      return stay({ ...state, compose: { ...compose, text: compose.text + key.char } })
    case 'enter': {
      const body = compose.text.trim()
      if (body === '') return stay({ ...state, compose: undefined })
      return {
        state: { ...state, compose: undefined, notice: undefined },
        effects:
          compose.to.kind === 'peer'
            ? [{ kind: 'send', peer: compose.to.peer, body }]
            : [{ kind: 'run', action: { kind: 'decide', id: compose.to.id, option: body } }],
      }
    }
    default:
      return stay(state)
  }
}

const onKey = (state: WatchState, key: Key): Step => {
  if (state.compose !== undefined) return onComposeKey(state, state.compose, key)
  if (state.menu !== undefined) return onMenuKey(state, state.menu, key)
  switch (key.kind) {
    case 'up':
      return stay(clamp({ ...state, selected: state.selected - 1 }))
    case 'down':
      return stay(clamp({ ...state, selected: state.selected + 1 }))
    case 'enter': {
      const menu = menuFor(selectables(state)[state.selected])
      return stay(menu === undefined ? state : { ...state, menu, notice: undefined })
    }
    case 'ctrl-c':
    case 'ctrl-d':
      return { state, effects: [{ kind: 'quit' }] }
    case 'char':
      if (key.char === 'q') return { state, effects: [{ kind: 'quit' }] }
      if (key.char === 'k') return stay(clamp({ ...state, selected: state.selected - 1 }))
      if (key.char === 'j') return stay(clamp({ ...state, selected: state.selected + 1 }))
      if (key.char === 'r') return { state, effects: [{ kind: 'refresh' }] }
      return stay(state)
    default:
      return stay(state)
  }
}

export const reduce = (state: WatchState, input: Input): Step => {
  switch (input.type) {
    case 'snapshot': {
      // The selection follows the row it was on, not the index: a decision answered above it
      // must not slide the cursor onto another peer.
      const before = selectables(state)[state.selected]
      const next: WatchState = { ...state, ls: input.ls }
      const rows = selectables(next)
      const same = before === undefined ? -1 : rows.findIndex((row) => sameRow(row, before))
      return stay(clamp(same === -1 ? next : { ...next, selected: same }))
    }
    case 'frame':
      return applyFrame(state, input.frame)
    case 'key':
      return onKey(state, input.key)
    case 'link':
      return stay({ ...state, link: input.link })
    case 'notice':
      return stay({ ...state, notice: input.text })
    case 'resize':
      return stay({ ...state, cols: input.cols, rows: input.rows })
  }
}

const sameRow = (a: Selectable, b: Selectable): boolean => {
  if (a.kind === 'peer' && b.kind === 'peer') return a.peer.peerId === b.peer.peerId
  if (a.kind === 'need' && b.kind === 'need') {
    if (a.need.kind === 'decision' && b.need.kind === 'decision') return a.need.decision.decisionId === b.need.decision.decisionId
    if (a.need.kind === 'peer' && b.need.kind === 'peer') return a.need.peer.peerId === b.need.peer.peerId
  }
  return false
}
