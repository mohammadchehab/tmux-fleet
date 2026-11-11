/**
 * The editor, as `port.ts` declares it. Every method here is a line or two of
 * `vscode`, and there is deliberately no decision in the file: the states, the
 * actions and the rows are all decided elsewhere, where `node --test` can reach
 * them. What is left is the part that only an editor can do — turn a `FleetItem`
 * into a `TreeItem`, a `PeerMark` into a `ThemeIcon`, an argv into a terminal.
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'

import * as vscode from 'vscode'

import type { Disposable, EditorPort, PickItem, Severity, StatusBarLike, TreeProvider, TreeView } from './port.ts'
import type { FleetItem } from './tree.ts'

const ICONS: Readonly<Record<string, string>> = {
  working: 'sync~spin',
  waiting: 'bell-dot',
  idle: 'circle-outline',
  starting: 'play-circle',
  ended: 'check',
  failed: 'error',
  held: 'lock',
  stopped: 'debug-pause',
}

const SEVERITY: Readonly<Record<Severity, (message: string) => Thenable<unknown>>> = {
  info: (message) => vscode.window.showInformationMessage(message),
  warning: (message) => vscode.window.showWarningMessage(message),
  error: (message) => vscode.window.showErrorMessage(message),
}

const toTreeItem = (item: FleetItem): vscode.TreeItem => {
  const collapsible =
    item.section === undefined
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Expanded
  const treeItem = new vscode.TreeItem(item.label, collapsible)

  treeItem.id = item.id
  treeItem.description = item.description
  treeItem.tooltip = item.tooltip === '' ? undefined : item.tooltip
  treeItem.contextValue = item.contextValue
  if (item.mark !== undefined) {
    const icon = ICONS[item.mark]
    if (icon !== undefined) {
      treeItem.iconPath = new vscode.ThemeIcon(icon, item.warning ? new vscode.ThemeColor('problemsWarningIcon.foreground') : undefined)
    }
  }
  if (item.commandId !== undefined) {
    treeItem.command = {
      command: item.commandId,
      title: item.label,
      arguments: item.commandArg === undefined ? [] : [item.commandArg],
    }
  }
  return treeItem
}

/** The extension host's home, which under Remote-SSH is the remote one (§7). */
const hostHome = (): string => process.env['HOME'] ?? process.env['USERPROFILE'] ?? homedir()

/**
 * Settings only the person may set, because the extension runs what they name.
 *
 * `fleet.command` is a program this file hands to `execFile` and to a terminal.
 * It is offered no folder or workspace scope in the manifest, so the editor
 * already refuses a repository's value; this reads the user's own value directly
 * as well, so a manifest edited back to workspace scope is not enough to make a
 * cloned repository name the program that runs here.
 */
const MACHINE_SETTINGS = new Set(['command'])

export const vscodePort = (): EditorPort => {
  const setting = <T>(key: string): T | undefined => {
    const configuration = vscode.workspace.getConfiguration('fleet')
    if (!MACHINE_SETTINGS.has(key)) return configuration.get<T>(key)
    const inspected = configuration.inspect<T>(key)
    return inspected?.globalValue ?? inspected?.defaultValue
  }

  return {
    home: hostHome(),
    env: process.env,
    trusted: vscode.workspace.isTrusted,

    setting,
    setSetting: async (key, value) => {
      await vscode.workspace.getConfiguration('fleet').update(key, value, vscode.ConfigurationTarget.Global)
    },
    onSettingsChanged: (handler) => {
      const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
        const key = [...['socket', 'profile', 'command']].find((name) => event.affectsConfiguration(`fleet.${name}`))
        if (key !== undefined) handler(key)
      })
      return subscription
    },

    createTree: (provider: TreeProvider): TreeView => {
      const emitter = new vscode.EventEmitter<FleetItem | undefined>()
      const dataProvider: vscode.TreeDataProvider<FleetItem> = {
        onDidChangeTreeData: emitter.event,
        // The editor's provider wants a mutable array; the model hands out a
        // readonly one so nothing downstream can reorder the rows behind it.
        getChildren: (element) => [...provider.children(element)],
        getTreeItem: toTreeItem,
      }
      const view = vscode.window.createTreeView('fleet.peers', {
        treeDataProvider: dataProvider,
        showCollapseAll: false,
      })
      return {
        // `undefined` is the whole tree; an item is resolved by identity, which
        // is why the model hands out the same object between polls (§4).
        refresh: (item) => {
          emitter.fire(item)
        },
        setBadge: (count) => {
          view.badge = count > 0 ? { value: count, tooltip: `${String(count)} need you` } : undefined
        },
        dispose: () => {
          view.dispose()
          emitter.dispose()
        },
      }
    },

    createStatusBar: (): StatusBarLike => {
      const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10)
      return {
        set: (text, tooltip, commandId) => {
          item.text = `$(broadcast) ${text}`
          item.tooltip = tooltip
          item.command = commandId
          item.show()
        },
        hide: () => {
          item.hide()
        },
        dispose: () => {
          item.dispose()
        },
      }
    },

    pick: async (items: readonly PickItem[], placeHolder: string) => {
      const chosen = await vscode.window.showQuickPick(
        items.map((entry) => ({ label: entry.label, description: entry.description, value: entry.value })),
        { placeHolder },
      )
      return chosen?.value
    },

    ask: async (prompt: string, value: string) => vscode.window.showInputBox({ prompt, value }),

    notify: (severity, message) => {
      void SEVERITY[severity](message)
    },

    confirm: async (message: string, yes: string) => {
      const chosen = await vscode.window.showWarningMessage(message, { modal: true }, yes)
      return chosen === yes
    },

    openTerminal: (name, argv) => {
      const [command, ...args] = argv
      if (command === undefined) return
      const terminal = vscode.window.createTerminal({ name })
      terminal.show(false)
      terminal.sendText([command, ...args].map(quote).join(' '))
    },

    run: async (argv) => {
      const [command, ...args] = argv
      if (command === undefined) return { ok: false, output: 'nothing to run' }
      return new Promise((resolve) => {
        execFile(command, args, { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, timeout: 30_000 }, (error, stdout, stderr) => {
          const output = `${stdout}${stderr}`
          resolve({ ok: error === null, output: error === null ? output : `${output}${error.message}` })
        })
      })
    },

    registerCommand: (id, handler): Disposable => vscode.commands.registerCommand(id, handler),

    executeCommand: async (id, argument) => {
      await vscode.commands.executeCommand(id, argument)
    },

    log: (line) => {
      console.log(`[fleet] ${line}`)
    },
  }
}

/** One argv element as a shell word. Conservative: quote anything that is not plainly safe. */
const quote = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)
