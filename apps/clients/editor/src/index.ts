/**
 * What `@fleet/app-editor` is: the extension's logic, minus the editor.
 *
 * Nothing exported from here imports `vscode`. That is what makes the extension
 * testable with `node --test` (§12) and it is also a rule worth keeping as the
 * extension grows: the bundler's entry point is `extension.ts`, which is the
 * only file that pulls the editor API in.
 */

export {
  actionsFor,
  actionTitle,
  commandFor,
  sendParamsFor,
  standingOf,
  terminalActions,
  oneShotActions,
  type PeerAction,
  type PeerStanding,
  type TerminalCommand,
} from './actions.ts'
export { activateWith, CLI_SETTING, PROFILE_SETTING, SOCKET_SETTING, type Activation, type ActivationDeps } from './activation.ts'
export { FleetConnection, POLL_MS, PROTOCOL_VERSION, type ConnectionDeps, type FleetState } from './connection.ts'
export { callDaemon, daemonAt, type FleetDaemon } from './daemon.ts'
export { discover, expandHome, type Discovery, type DiscoveryInput } from './discovery.ts'
export type { Disposable, EditorPort, PickItem, Severity, StatusBarLike, TreeProvider, TreeView } from './port.ts'
export { runningProfiles } from './profiles.ts'
export { countOf, rowsOf, type FleetRows, type NeedYouRow, type PeerMark, type PeerRow } from './rows.ts'
export { reconcile, TreeModel, type FleetItem, type TreeInput, type TreeNotice, type TreeRefresh } from './tree.ts'
