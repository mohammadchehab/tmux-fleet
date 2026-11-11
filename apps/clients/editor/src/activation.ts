/**
 * What the extension does, with the editor behind a port (§12).
 *
 * The shape of this file follows the states a window can be in rather than the
 * features it has, because §7's four states *are* the feature: a window either
 * draws a fleet, or draws the one thing that stands between it and a fleet. Each
 * `render` branch says what a person sees and what the single obvious action is,
 * and none of them is an error dialog. A missing daemon is the normal state of a
 * workspace nobody has started a fleet in.
 *
 * Three rules the code below keeps, and why:
 *
 * - **Nothing heavy runs on the poll path.** Rendering is a `TreeModel.apply`
 *   and a status-bar string. Every editor call the model makes is outside the
 *   poll: a person clicking, or a settings change.
 * - **A takeover is a terminal** (§6). `fleet attach` in an integrated terminal,
 *   named `fleet: <peer>`, is the whole of it — this file does not start
 *   providers, hold sessions or release anything, so a takeover here and one in
 *   a shell are the same operation, run by the same code.
 * - **A destructive action asks first** (§6). Stop is confirmed; start is not,
 *   because starting a peer that is already stopped is not a loss.
 */

import type { DecideParams } from '@fleet/foundation-contracts'

import {
  actionTitle,
  commandFor,
  oneShotActions,
  sendParamsFor,
  standingOf,
  terminalActions,
  actionsFor,
  type PeerAction,
} from './actions.ts'
import { FleetConnection, PROTOCOL_VERSION, type FleetState } from './connection.ts'
import { daemonAt, type FleetDaemon } from './daemon.ts'
import { discover } from './discovery.ts'
import type { Disposable, EditorPort, PickItem } from './port.ts'
import { runningProfiles } from './profiles.ts'
import { countOf, type FleetRows } from './rows.ts'
import { TreeModel, type TreeNotice } from './tree.ts'

/** The setting that says how to run the fleet (§6): `fleet` on an install, a path in a checkout. */
export const CLI_SETTING = 'command'
export const SOCKET_SETTING = 'socket'
export const PROFILE_SETTING = 'profile'

export interface ActivationDeps {
  readonly editor: EditorPort
  /** Overridden in tests; the real one is `daemonAt` (`daemon.ts`). */
  readonly daemonFor?: (socketPath: string) => FleetDaemon
  readonly pollMs?: number
}

export interface Activation extends Disposable {
  readonly model: TreeModel
  readonly connection: FleetConnection
  state(): FleetState
  /** One poll, awaited: tests drive the window instead of waiting on the interval. */
  tick(): Promise<void>
  /** What a person clicking a row's command ends up running. Exposed for the tests and the menus. */
  runAction(peerId: string, action: PeerAction): Promise<void>
  answer(decisionId: string): Promise<void>
}

const NOTICE_STARTING: TreeNotice = {
  label: 'Starting…',
  description: 'looking for a fleet',
  tooltip: 'Reading the settings, then asking the daemon.',
}

const noticeOf = (state: FleetState): TreeNotice | undefined => {
  switch (state.phase) {
    case 'starting':
      return NOTICE_STARTING
    case 'no-fleet':
      return {
        label: 'No fleet is running',
        description: 'start one',
        tooltip: 'Nothing answers under ~/.fleet. Start a fleet in this workspace.',
        commandId: 'fleet.start',
      }
    case 'choose':
      return {
        label: 'Choose a fleet',
        description: `${String(state.profiles.length)} running here`,
        tooltip: `Several profiles are running: ${state.profiles.join(', ')}. Pick one and it is remembered.`,
        commandId: 'fleet.choose-profile',
      }
    case 'disconnected':
      return {
        label: 'Disconnected',
        description: state.reason,
        tooltip: `${state.reason}\n\nThe rows below are the last ones read.`,
        commandId: 'fleet.refresh',
      }
    case 'version-mismatch':
      return {
        label: 'Extension out of date',
        description: `daemon speaks v${String(state.daemonVersion)}`,
        tooltip: `This extension speaks v${String(PROTOCOL_VERSION)}. Reinstall it with \`fleet editor install\`.`,
      }
    case 'problem':
      return {
        label: 'Cannot read the fleet settings',
        description: 'settings',
        tooltip: `${state.reason}\n\nFix the setting and this window asks again.`,
        commandId: 'fleet.refresh',
      }
    case 'connected':
      return undefined
  }
}

const rowsOfState = (state: FleetState): FleetRows | undefined =>
  state.phase === 'connected' || state.phase === 'disconnected' ? state.rows : undefined

const statusOf = (state: FleetState): { readonly text: string; readonly tooltip: string } => {
  switch (state.phase) {
    case 'starting':
      return { text: 'Fleet: starting…', tooltip: 'Looking for a fleet.' }
    case 'no-fleet':
      return { text: 'Fleet: not running', tooltip: 'No daemon answers. Click to start one.' }
    case 'choose':
      return { text: 'Fleet: choose a profile', tooltip: state.profiles.join(', ') }
    case 'disconnected':
      return { text: 'Fleet: disconnected', tooltip: state.reason }
    case 'version-mismatch':
      return { text: 'Fleet: protocol mismatch', tooltip: `daemon v${String(state.daemonVersion)}, extension v${String(PROTOCOL_VERSION)}` }
    case 'problem':
      return { text: 'Fleet: settings problem', tooltip: state.reason }
    case 'connected': {
      const peers = state.rows.peers.length
      const needs = countOf(state.rows)
      const text = needs > 0 ? `Fleet: ${String(peers)} peers · ${String(needs)} need you` : `Fleet: ${String(peers)} peers`
      return { text, tooltip: `${state.profile} · ${state.socketPath}` }
    }
  }
}

export const activateWith = (deps: ActivationDeps): Activation => {
  const { editor } = deps
  const daemonFor = deps.daemonFor ?? daemonAt
  const model = new TreeModel()
  const disposables: Disposable[] = []

  const cli = (): string => {
    const configured = editor.setting<string>(CLI_SETTING)
    return configured === undefined || configured.trim() === '' ? 'fleet' : configured.trim()
  }

  const tree = editor.createTree(model)
  const status = editor.createStatusBar()
  disposables.push(tree, status)

  const render = (state: FleetState): void => {
    const rows = rowsOfState(state)
    const notice = noticeOf(state)
    const refresh = model.apply(notice === undefined ? { rows } : { rows, notice })
    // One event per changed row, and a whole-tree refresh only when the shape
    // moved (§4). This is the branch the spike measured: firing per row is what
    // keeps a 5 Hz tree off the extension host's CPU.
    if (refresh.structural) tree.refresh()
    else for (const item of refresh.changed) tree.refresh(item)

    const needs = state.phase === 'connected' ? countOf(state.rows) : 0
    tree.setBadge(needs)

    const bar = statusOf(state)
    status.set(bar.text, bar.tooltip, state.phase === 'connected' ? 'fleet.peers.focus' : 'fleet.focus')
  }

  const onState = (state: FleetState): void => {
    try {
      render(state)
    } catch (error) {
      // A render that throws must not take the poll loop with it.
      editor.log(`render failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const connection = new FleetConnection({
    discover: async () =>
      discover({
        socket: editor.setting<string>(SOCKET_SETTING),
        profile: editor.setting<string>(PROFILE_SETTING),
        env: editor.env,
        home: editor.home,
        running: await runningProfiles(editor.home),
      }),
    list: (socketPath) => daemonFor(socketPath).ls(),
    onState,
    ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
  })

  /** The daemon this window is talking to, or `undefined` when it is not talking to one. */
  const daemonNow = (): { readonly daemon: FleetDaemon; readonly profile: string } | undefined => {
    const state = connection.current()
    const socketPath = connection.socket()
    if (state.phase !== 'connected' || socketPath === undefined) return undefined
    return { daemon: daemonFor(socketPath), profile: state.profile }
  }

  const requireDaemon = (): { readonly daemon: FleetDaemon; readonly profile: string } | undefined => {
    const daemon = daemonNow()
    if (daemon === undefined) editor.notify('warning', 'No fleet is connected. Start one first.')
    return daemon
  }

  const speak = (error: unknown, what: string): void => {
    editor.notify('error', `${what}: ${error instanceof Error ? error.message : String(error)}`)
    connection.refresh()
  }

  const peerRow = (peerId: string) => {
    const state = connection.current()
    const rows = state.phase === 'connected' ? state.rows : undefined
    return rows?.peers.find((row) => row.peerId === peerId)
  }

  const runAction = async (peerId: string, action: PeerAction): Promise<void> => {
    const target = requireDaemon()
    if (target === undefined) return

    if (action === 'send') {
      const body = await editor.ask(`Message to ${peerId}`, '')
      if (body === undefined || body.trim() === '') return
      try {
        await target.daemon.send(sendParamsFor(peerId, body.trim()))
        editor.notify('info', `Sent to ${peerId}.`)
        connection.refresh()
      } catch (error) {
        speak(error, `Cannot send to ${peerId}`)
      }
      return
    }

    const command = commandFor(cli(), action, peerId)
    if (command === undefined) return

    if (terminalActions.includes(action)) {
      // §6: a takeover *is* a terminal. Not tracked, not awaited — the person
      // closes it, and the next poll notices the peer is held.
      editor.openTerminal(command.name, command.argv)
      return
    }

    if (!oneShotActions.includes(action)) return

    if (action === 'stop') {
      const row = peerRow(peerId)
      const busy = row !== undefined && standingOf(row.state) === 'running'
      if (busy && !(await editor.confirm(`Stop ${peerId}?`, 'Stop'))) return
    }

    const result = await editor.run(command.argv)
    if (result.ok) {
      editor.notify('info', `${actionTitle(action)}: ${peerId}.`)
    } else {
      editor.notify('error', `${actionTitle(action)} failed: ${result.output.trim().split('\n').slice(-3).join(' ')}`)
    }
    connection.refresh()
  }

  const answer = async (decisionId: string): Promise<void> => {
    const target = requireDaemon()
    if (target === undefined) return

    const state = connection.current()
    const rows = state.phase === 'connected' ? state.rows : undefined
    const row = rows?.needsYou.find((candidate) => candidate.decision?.decisionId === decisionId)
    const decision = row?.decision
    if (decision === undefined) {
      // Answered in a terminal while this window was looking at it: re-read
      // rather than telling the person the decision does not exist.
      editor.notify('warning', 'That decision is no longer open.')
      connection.refresh()
      return
    }

    const items: readonly PickItem[] = decision.options.map((option) => ({ label: option, value: option }))
    const choice = await editor.pick(items, decision.question)
    if (choice === undefined) return

    // No note box: a note is `fleet decide --note`, and a second prompt in front
    // of every answer is what makes a person stop reading the first one.
    const params: DecideParams = { id: decision.decisionId, decision: choice }
    try {
      await target.daemon.decide(params)
      editor.notify('info', `Answered ${decision.decisionId}: ${choice}.`)
      connection.refresh()
    } catch (error) {
      speak(error, `Cannot answer ${decision.decisionId}`)
    }
  }

  const chooseProfile = async (): Promise<void> => {
    const state = connection.current()
    const profiles = state.phase === 'choose' ? state.profiles : await runningProfiles(editor.home)
    if (profiles.length === 0) {
      editor.notify('warning', 'No fleet is running. Start one first.')
      return
    }
    const choice = await editor.pick(
      profiles.map((profile) => ({ label: profile, value: profile })),
      'Which fleet should this window show?',
    )
    if (choice === undefined) return
    await editor.setSetting(PROFILE_SETTING, choice)
    connection.refresh()
  }

  const offerActions = async (peerId: string): Promise<void> => {
    const row = peerRow(peerId)
    if (row === undefined) {
      editor.notify('warning', `${peerId} is no longer in this fleet.`)
      connection.refresh()
      return
    }
    const actions = actionsFor(standingOf(row.state))
    const choice = await editor.pick(
      actions.map((action) => ({ label: actionTitle(action), value: action })),
      `${peerId} · ${row.description}`,
    )
    if (choice === undefined) return
    await runAction(peerId, choice as PeerAction)
  }

  const openUp = (): void => {
    editor.openTerminal('fleet: up', [cli(), 'up'])
  }

  const register = (id: string, handler: (argument?: string) => void): void => {
    disposables.push(editor.registerCommand(id, handler))
  }

  register('fleet.refresh', () => connection.refresh())
  register('fleet.start', () => openUp())
  register('fleet.focus', () => {
    void editor.executeCommand('fleet.peers.focus')
  })
  register('fleet.choose-profile', () => {
    void chooseProfile()
  })
  register('fleet.decision.answer', (decisionId) => {
    if (decisionId !== undefined) void answer(decisionId)
  })
  register('fleet.peer.actions', (peerId) => {
    if (peerId !== undefined) void offerActions(peerId)
  })
  register('fleet.peer.takeover', (peerId) => {
    if (peerId !== undefined) void runAction(peerId, 'takeover')
  })
  register('fleet.peer.takeover.now', (peerId) => {
    if (peerId !== undefined) void runAction(peerId, 'takeover-now')
  })
  register('fleet.peer.send', (peerId) => {
    if (peerId !== undefined) void runAction(peerId, 'send')
  })
  register('fleet.peer.stop', (peerId) => {
    if (peerId !== undefined) void runAction(peerId, 'stop')
  })
  register('fleet.peer.start', (peerId) => {
    if (peerId !== undefined) void runAction(peerId, 'start')
  })

  // A changed setting is a changed fleet: `fleet.profile` and `fleet.socket` are
  // read on every poll, so the next one picks the change up.
  disposables.push(
    editor.onSettingsChanged((key) => {
      if (key === SOCKET_SETTING || key === PROFILE_SETTING || key === CLI_SETTING) connection.refresh()
    }),
  )

  const tick = async (): Promise<void> => {
    await connection.poll()
  }

  return {
    model,
    connection,
    state: () => connection.current(),
    tick,
    runAction,
    answer,
    dispose: () => {
      connection.stop()
      for (const disposable of disposables) disposable.dispose()
    },
  }
}
