/**
 * Everything the wiring needs from the editor, as interfaces (§12).
 *
 * The extension's logic is in `activation.ts` and it does not import `vscode`.
 * It takes an `EditorPort` instead, so `node --test` can drive the whole thing —
 * activation, a poll, a row changing, a decision being answered, a takeover
 * opening a terminal — without an editor, and the one file that does import
 * `vscode` (`vscode-port.ts`) has no decisions in it to get wrong.
 *
 * The port is deliberately shaped like the editor API rather than like this
 * extension: `createTree` takes a provider with `children`, `notify` takes a
 * severity. Every method is one line in the adapter, and the reason is that a
 * port that invents its own vocabulary needs a translation layer nobody tests.
 */

import type { FleetItem } from './tree.ts'

export interface Disposable {
  dispose(): void
}

/** What a tree renders: the rows a section has, by element. */
export interface TreeProvider {
  children(element: FleetItem | undefined): readonly FleetItem[]
}

export interface TreeView extends Disposable {
  /** One row, by element identity — the whole point of §4's stable elements. */
  refresh(item?: FleetItem): void
  /** The count on the activity-bar container. Zero hides it. */
  setBadge(count: number): void
}

export type Severity = 'info' | 'warning' | 'error'

export interface PickItem {
  readonly label: string
  readonly description?: string
  /** What `pick` resolves to. The label is for the person, this is for the code. */
  readonly value: string
}

export interface StatusBarLike extends Disposable {
  set(text: string, tooltip: string, commandId?: string): void
  hide(): void
}

export interface EditorPort {
  /** The extension host's home: the local one, or the remote one under Remote-SSH (§7). */
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * Workspace trust (§9). Read once at activation; the manifest also declares
   * `untrustedWorkspaces.supported: false`, so this is the second gate, not the
   * only one — an editor that activated us anyway still runs nothing here.
   */
  readonly trusted: boolean

  setting<T>(key: string): T | undefined
  setSetting(key: string, value: unknown): Promise<void>
  onSettingsChanged(handler: (key: string) => void): Disposable

  createTree(provider: TreeProvider): TreeView
  createStatusBar(): StatusBarLike

  /** A list to choose from; `undefined` when the person dismissed it. */
  pick(items: readonly PickItem[], placeHolder: string): Promise<string | undefined>
  /** A free-text answer; `undefined` when dismissed. */
  ask(prompt: string, value: string): Promise<string | undefined>
  notify(severity: Severity, message: string): void
  /** A yes/no the destructive paths ask before they run (§6). */
  confirm(message: string, yes: string): Promise<boolean>

  /** An integrated terminal that runs a command and stays open (§6: a takeover *is* a terminal). */
  openTerminal(name: string, argv: readonly string[]): void
  /** A command that runs and exits; its output is the notification's detail. */
  run(argv: readonly string[]): Promise<{ readonly ok: boolean; readonly output: string }>

  registerCommand(id: string, handler: (argument?: string) => void): Disposable
  executeCommand(id: string, argument?: string): Promise<void>
  log(line: string): void
}
