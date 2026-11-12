/**
 * The tree, as data (§4).
 *
 * Two facts about this file are the whole point of it:
 *
 * - **The elements are stable.** A row is one object for as long as its peer
 *   exists, and a poll mutates that object. VS Code resolves
 *   `onDidChangeTreeData.fire(element)` by *identity*, so a model that handed
 *   out a fresh object per poll would make every single-row refresh a silent
 *   no-op — the tree would still look right, because a structural refresh would
 *   happen on the next add or remove, and nobody would find it in review. (The
 *   spike's probe measured exactly this: 8 `getTreeItem` calls for 99 refreshes
 *   with copies, 107 with stable objects.)
 * - **A poll says what changed.** `apply` returns the items whose words moved
 *   and whether the tree's *shape* moved. The editor layer fires one event per
 *   changed row and a full refresh only when a row appeared or left (§4: "by
 *   refreshing single items and not the whole tree").
 *
 * Nothing here imports the editor API: the shape the editor layer renders
 * (`FleetItem`) is plain data, which is what lets `node --test` cover it (§12).
 */

import type { Decision } from '@fleet/foundation-contracts'
import type { PeerId, PeerState } from '@fleet/foundation-core'

import { standingOf, type PeerAction } from './actions.ts'
import type { NeedYouRow, PeerMark, PeerRow } from './rows.ts'

/** One rendered row. Plain data on purpose: the editor layer turns it into a `TreeItem`. */
export interface FleetItem {
  /** Stable for the life of the row: `peer:<id>`, `need-you:<id>`, `section:peers`, `notice`. */
  readonly id: string
  readonly kind: 'section' | 'need-you' | 'peer' | 'notice'
  label: string
  description: string
  tooltip: string
  mark?: PeerMark
  state?: PeerState
  peerId?: PeerId
  decision?: Decision
  actions?: readonly PeerAction[]
  warning: boolean
  /** Set on the two section rows, which are the only items with children. */
  section?: 'needs-you' | 'peers'
  /** What VS Code's `viewItem` clauses match on, e.g. `peer.running`. */
  contextValue: string
  /** What clicking does, when it does something: a command id and its argument. */
  commandId?: string
  commandArg?: string
}

export interface TreeNotice {
  readonly label: string
  readonly description: string
  readonly tooltip: string
  readonly commandId?: string
  readonly commandArg?: string
}

export interface TreeInput {
  /** The rows, or `undefined` when there are none to draw (no fleet yet, or a fleet that cannot be read). */
  readonly rows:
    | { readonly needsYou: readonly NeedYouRow[]; readonly peers: readonly PeerRow[] }
    | undefined
  /**
   * A line above the rows — "disconnected", say. It is a row of its own rather
   * than something that replaces the tree, because a window that lost the daemon
   * keeps showing what it last knew: an empty tree and a lost daemon must not
   * look the same (§7).
   */
  readonly notice?: TreeNotice
}

export interface TreeRefresh {
  /** The shape changed: a row appeared or left, so the whole tree is re-read. */
  readonly structural: boolean
  /** Rows whose own text changed, to be refreshed one at a time (§4). */
  readonly changed: readonly FleetItem[]
}

const NEEDS_YOU_ID = 'section:needs-you'
const PEERS_ID = 'section:peers'
const NOTICE_ID = 'notice'

const section = (id: string, sectionName: 'needs-you' | 'peers', label: string): FleetItem => ({
  id,
  kind: 'section',
  label,
  description: '',
  tooltip: '',
  warning: false,
  section: sectionName,
  contextValue: 'section',
})

/** Fields whose change means the row must be redrawn. Anything else is invisible. */
const DIFF_FIELDS = ['label', 'description', 'tooltip', 'mark', 'state', 'warning', 'actions', 'contextValue'] as const

const sameRow = (a: FleetItem, b: FleetItem): boolean =>
  DIFF_FIELDS.every((field) => JSON.stringify(a[field]) === JSON.stringify(b[field])) &&
  a.commandId === b.commandId &&
  a.commandArg === b.commandArg

const copyInto = (target: FleetItem, source: FleetItem): void => {
  target.label = source.label
  target.description = source.description
  target.tooltip = source.tooltip
  target.mark = source.mark
  target.state = source.state
  target.peerId = source.peerId
  target.decision = source.decision
  target.actions = source.actions
  target.warning = source.warning
  target.commandId = source.commandId
  target.commandArg = source.commandArg
}

const peerItem = (row: PeerRow): FleetItem => ({
  id: `peer:${row.id}`,
  kind: 'peer',
  label: row.label,
  description: row.description,
  tooltip: row.tooltip,
  mark: row.mark,
  state: row.state,
  peerId: row.peerId,
  actions: row.actions,
  warning: row.warning,
  contextValue: `peer.${standingOf(row.state)}`,
  // §5: the click opens the peer's live output; its actions are the context menu
  // and the inline button.
  commandId: 'fleet.peer.output',
  commandArg: row.peerId,
})

const needYouItem = (row: NeedYouRow): FleetItem => ({
  id: `need-you:${row.id}`,
  kind: 'need-you',
  label: row.label,
  description: row.description,
  tooltip: row.tooltip,
  warning: false,
  contextValue: `need-you.${row.kind}`,
  ...(row.decision === undefined ? {} : { decision: row.decision }),
  ...(row.peerId === undefined ? {} : { peerId: row.peerId }),
  commandId: row.kind === 'decision' ? 'fleet.decision.answer' : 'fleet.peer.actions',
  ...(row.kind === 'decision'
    ? { commandArg: row.decision?.decisionId ?? '' }
    : { commandArg: row.peerId ?? '' }),
})

const noticeItem = (notice: TreeNotice): FleetItem => ({
  id: NOTICE_ID,
  kind: 'notice',
  label: notice.label,
  description: notice.description,
  tooltip: notice.tooltip,
  warning: false,
  contextValue: 'notice',
  ...(notice.commandId === undefined ? {} : { commandId: notice.commandId }),
  ...(notice.commandArg === undefined ? {} : { commandArg: notice.commandArg }),
})

/**
 * Keep the elements that are still there, in the new order, mutating them.
 *
 * `next` is already in the order the tree should show, so this is a lookup per
 * row rather than a diff: the sets are tiny (a fleet is tens of peers) and an
 * order-independent algorithm would have to say which of two orders wins.
 */
export const reconcile = (
  current: readonly FleetItem[],
  next: readonly FleetItem[],
): { readonly items: readonly FleetItem[]; readonly changed: readonly FleetItem[]; readonly structural: boolean } => {
  const byId = new Map(current.map((item) => [item.id, item]))
  const changed: FleetItem[] = []
  const items: FleetItem[] = []
  const sameOrder =
    current.length === next.length &&
    current.every((item, index) => item.id === next[index]?.id)
  let structural = !sameOrder

  for (const desired of next) {
    const existing = byId.get(desired.id)
    if (existing === undefined) {
      // A row we have never drawn: nothing to keep, and the tree must re-read.
      items.push(desired)
      continue
    }
    if (!sameRow(existing, desired)) {
      copyInto(existing, desired)
      changed.push(existing)
    }
    items.push(existing)
  }

  return { items, changed, structural }
}

/**
 * The two sections and their rows, kept between polls so their elements keep
 * their identity. One model per window.
 */
export class TreeModel {
  private readonly needsYouSection: FleetItem = section(NEEDS_YOU_ID, 'needs-you', 'Needs you')
  private readonly peersSection: FleetItem = section(PEERS_ID, 'peers', 'Peers')
  private notice: FleetItem | undefined
  /** Whether the two sections are on screen at all: they are hidden when there is nothing to put under them. */
  private sectionsShown = false
  private needsYou: readonly FleetItem[] = []
  private peers: readonly FleetItem[] = []

  root(): readonly FleetItem[] {
    const sections = this.sectionsShown ? [this.needsYouSection, this.peersSection] : []
    return this.notice === undefined ? sections : [this.notice, ...sections]
  }

  children(element: FleetItem | undefined): readonly FleetItem[] {
    if (element === undefined) return this.root()
    if (element.section === 'needs-you') return this.needsYou
    if (element.section === 'peers') return this.peers
    return []
  }

  /**
   * Take a new snapshot and say what moved. Rows that stayed are mutated in
   * place and reported; rows that appeared or left make the result structural.
   */
  apply(input: TreeInput): TreeRefresh {
    const changed: FleetItem[] = []

    // The notice, kept as one element so a changing reason refreshes one row.
    const hadNotice = this.notice !== undefined
    const hasNotice = input.notice !== undefined
    if (input.notice !== undefined) {
      const desired = noticeItem(input.notice)
      if (this.notice === undefined) {
        this.notice = desired
      } else if (!sameRow(this.notice, desired)) {
        copyInto(this.notice, desired)
        changed.push(this.notice)
      }
    } else {
      this.notice = undefined
    }

    // Showing or hiding the sections changes the root's shape.
    const sectionsShown = input.rows !== undefined
    let structural = hadNotice !== hasNotice || sectionsShown !== this.sectionsShown
    this.sectionsShown = sectionsShown

    const needsYouLabel = `Needs you (${String(input.rows?.needsYou.length ?? 0)})`
    if (this.needsYouSection.label !== needsYouLabel) {
      this.needsYouSection.label = needsYouLabel
      changed.push(this.needsYouSection)
    }

    const needsYouResult = reconcile(this.needsYou, (input.rows?.needsYou ?? []).map(needYouItem))
    const peersResult = reconcile(this.peers, (input.rows?.peers ?? []).map(peerItem))

    this.needsYou = needsYouResult.items
    this.peers = peersResult.items
    structural = structural || needsYouResult.structural || peersResult.structural
    changed.push(...needsYouResult.changed, ...peersResult.changed)

    return { structural, changed }
  }
}
