/**
 * The extension's entry point, and the one place the editor API is wired to the
 * logic. `activateWith` is what the tests drive; this file is what VS Code
 * calls, and its whole job is choosing the real port and starting the poll.
 *
 * §9's workspace-trust rule is enforced in two places on purpose. The manifest
 * declares `untrustedWorkspaces.supported: false`, which is the editor's own
 * gate; this checks it again, because an extension that ran anyway would start
 * a CLI in a folder the person has not vouched for.
 */

import * as vscode from 'vscode'

import { activateWith, type Activation } from './activation.ts'
import { vscodePort } from './vscode-port.ts'

let running: Activation | undefined

export const activate = (context: vscode.ExtensionContext): void => {
  const port = vscodePort()

  if (!port.trusted) {
    port.log('workspace is not trusted: the extension stays inactive')
    return
  }

  running = activateWith({ editor: port })
  running.connection.start()

  context.subscriptions.push({
    dispose: () => {
      running?.dispose()
      running = undefined
    },
  })
}

export const deactivate = (): void => {
  running?.dispose()
  running = undefined
}
