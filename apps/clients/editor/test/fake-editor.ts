/**
 * The editor, faked (§12): every call the extension can make, recorded.
 *
 * The tests assert on three things, and this file is those three things: what
 * was drawn (`refresh` calls, the badge, the status bar), what was run (a
 * terminal's argv, a one-shot command, a daemon call) and what was asked (a pick,
 * an input box, a confirmation). Answers are queued, so a test says what the
 * person would have clicked before it clicks.
 */

import type { Disposable, EditorPort, PickItem, Severity, StatusBarLike, TreeProvider, TreeView } from '../src/port.ts'
import type { FleetItem } from '../src/tree.ts'

export interface Notification {
  readonly severity: Severity
  readonly message: string
}

export interface FakeEditor extends EditorPort {
  /** Every `refresh` the model asked for: an item is one row, `undefined` is the whole tree. */
  readonly refreshes: (FleetItem | undefined)[]
  readonly terminals: { readonly name: string; readonly argv: readonly string[] }[]
  readonly runs: (readonly string[])[]
  readonly notifications: Notification[]
  readonly statuses: { readonly text: string; readonly tooltip: string }[]
  readonly commandIds: string[]
  readonly settings: Record<string, unknown>
  /** What the next `pick` returns; a queue, so a test can script a sequence. */
  readonly picks: (string | undefined)[]
  readonly asks: (string | undefined)[]
  readonly confirms: boolean[]
  readonly handlers: Map<string, (argument?: string) => void>
  badge: number
  status: string
  /** What the extension registered as its tree provider, so a test can read the rows it draws. */
  provider?: TreeProvider
  /** Called after activation registered its commands, to simulate a menu click. */
  click(id: string, argument?: string): Promise<void>
  /** A settings change, as VS Code would report it. */
  changeSetting(key: string, value: unknown): Promise<void>
}

const noop = (): void => undefined

export interface FakeOptions {
  readonly home?: string
  readonly env?: Record<string, string | undefined>
  readonly trusted?: boolean
  readonly settings?: Record<string, unknown>
}

export const fakeEditor = (options: FakeOptions = {}): FakeEditor => {
  const refreshes: (FleetItem | undefined)[] = []
  const terminals: { name: string; argv: readonly string[] }[] = []
  const runs: (readonly string[])[] = []
  const notifications: Notification[] = []
  const statuses: { text: string; tooltip: string }[] = []
  const commandIds: string[] = []
  const handlers = new Map<string, (argument?: string) => void>()
  const settingsChangeHandlers: ((key: string) => void)[] = []
  const picks: (string | undefined)[] = []
  const asks: (string | undefined)[] = []
  const confirms: boolean[] = []

  const editor: FakeEditor = {
    home: options.home ?? '/home/tester',
    env: options.env ?? {},
    trusted: options.trusted ?? true,
    settings: { ...options.settings },
    refreshes,
    terminals,
    runs,
    notifications,
    statuses,
    commandIds,
    picks,
    asks,
    confirms,
    handlers,
    badge: 0,
    status: '',

    setting<T>(key: string): T | undefined {
      return editor.settings[key] as T | undefined
    },
    setSetting: async (key, value) => {
      editor.settings[key] = value
    },
    onSettingsChanged: (handler) => {
      settingsChangeHandlers.push(handler)
      return { dispose: noop }
    },

    createTree: (provider: TreeProvider): TreeView => {
      editor.provider = provider
      return {
        refresh: (item) => refreshes.push(item),
        setBadge: (count) => {
          editor.badge = count
        },
        dispose: noop,
      }
    },

    createStatusBar: (): StatusBarLike => ({
      set: (text, tooltip) => {
        editor.status = text
        statuses.push({ text, tooltip })
      },
      hide: noop,
      dispose: noop,
    }),

    pick: async (items: readonly PickItem[]) => {
      const answer = picks.shift()
      // A test that queues a value it did not offer is a test bug, and it is
      // worth failing here rather than in an assertion three lines later.
      if (answer !== undefined && !items.some((item) => item.value === answer)) {
        throw new Error(`pick: "${answer}" is not one of ${items.map((item) => item.value).join(', ')}`)
      }
      return answer
    },
    ask: async () => asks.shift(),
    notify: (severity, message) => {
      notifications.push({ severity, message })
    },
    confirm: async () => confirms.shift() ?? false,

    openTerminal: (name, argv) => {
      terminals.push({ name, argv })
    },
    run: async (argv) => {
      runs.push(argv)
      return { ok: true, output: '' }
    },

    registerCommand: (id, handler): Disposable => {
      commandIds.push(id)
      handlers.set(id, handler)
      return { dispose: noop }
    },
    executeCommand: async (id, argument) => {
      handlers.get(id)?.(argument)
    },
    log: noop,

    async click(id, argument) {
      const handler = handlers.get(id)
      if (handler === undefined) throw new Error(`no command ${id} was registered`)
      handler(argument)
      // The handlers are `void`-returning by the port's shape; give their
      // promises a turn to settle so a test can assert on the result.
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
    },

    async changeSetting(key, value) {
      editor.settings[key] = value
      for (const handler of settingsChangeHandlers) handler(key)
    },
  }

  return editor
}
