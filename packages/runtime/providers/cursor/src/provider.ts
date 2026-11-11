/**
 * cursor as a `Provider` (§4): read-only, plan mode only.
 *
 * `cursor-agent` is a CLI with no server mode and no MCP-free API surface worth
 * wrapping, so this adapter treats it as a process per turn (see `session.ts`).
 * What makes it a fleet peer rather than a shell command is the four things
 * below, each a deliberate refusal rather than a gap nobody noticed:
 *
 * 1. **Read-only, enforced at `start()`.** `capabilities.permissionModes` is
 *    `['plan']` and anything else is refused before a process spawns, so no
 *    profile can give cursor a writing peer. This is §13's rule — a session comes
 *    up in the mode its spec named or it does not come up — and it matters more
 *    here than for the SDK providers, because this CLI has no per-tool-call hook
 *    for a `toolPolicy` to ride on. Plan mode is the whole guarantee.
 * 2. **The model is reported as requested, not confirmed.** The CLI's `init`
 *    line names the model's display name, not its id, so `model()` returns the
 *    id the session was started with (or switched to) and says so. Nothing here
 *    raises `config_mismatch`: there is no observation to compare against, and a
 *    check that always passes is worse than no check.
 * 3. **Usage is a turn-measured proxy.** One process per turn means the only
 *    numbers are that turn's; `usage()` reports the prompt side of the last one
 *    against a configured window. `usageCost` and `structuredOutput` are false —
 *    Cursor bills by subscription, and this CLI takes no schema.
 * 4. **`answer()` and `respond()` reject `unsupported`.**
 *    `capabilities.permissionModes` has no asking mode, so a question or an
 *    approval can never be raised, and a session parked waiting for one would be
 *    a session the supervisor never hears from again.
 */

import { spawnSync } from 'node:child_process'

import { fleetError, systemClock, type Clock, type PeerState, type QuestionId, type TurnId } from '@fleet/foundation-core'
import type {
  ApprovalDecision,
  AttachCommand,
  DisplayLine,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderSessionRef,
  QuestionAnswer,
  SessionHandle,
  SessionSpec,
  Turn,
  Usage,
} from '@fleet/runtime-provider-sdk'

import { buildChildEnv } from '@fleet/runtime-provider-sdk'
import { CursorSession, defaultCursorExecutable } from './session.ts'
import { contextLimitFor } from './usage.ts'

/**
 * What this CLI can do. `resume` is true because a chat is a ref `--resume`
 * takes; `modelSwitch` is true because the next turn's process simply runs a
 * different `--model`; `usageTokens` is true as a proxy (see `usage.ts`), not as
 * a measurement.
 */
export const cursorCapabilities: ProviderCapabilities = Object.freeze({
  resume: true,
  modelSwitch: true,
  usageTokens: true,
  usageCost: false,
  structuredOutput: false,
  // `cursor-agent` has no reasoning-level flag we have measured; a profile that
  // asks for one gets a `fleet up` warning rather than a session that pretends
  // (TASK-12 says false "unless proven").
  effort: false,
  permissionModes: Object.freeze(['plan'] as const),
})

/** The only permission mode a cursor session may come up in (§13). */
export const CURSOR_PERMISSION_MODE = 'plan'

/** The model id that names a choice rather than a model, so `model()` could not report one. */
export const CURSOR_AUTO_MODEL = 'auto'

export interface CursorProviderConfig {
  /** `cursor-agent`, or a path to it — a test's fake binary, for instance. */
  readonly executable?: string
  /** Arguments before the CLI's own. */
  readonly executableArgs?: readonly string[]
  /**
   * Context windows per model id. Required for any model a session names: the
   * CLI reports no window, so there is nothing to fall back to, and a guessed
   * one would purge a session at a fraction of the context it had (§8). A fleet
   * states its windows in its profile; the adapter refuses what it was not told.
   */
  readonly contextLimits?: Readonly<Record<string, number>>
  readonly clock?: Clock
}

/**
 * A chat id: a UUID this CLI prints from `create-chat`. Validated before it is
 * used, because it is handed back as an argv value on every turn.
 */
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class CursorProvider implements Provider {
  readonly id = 'cursor'
  readonly capabilities = cursorCapabilities

  readonly #executable: string
  readonly #executableArgs: readonly string[]
  readonly #limits: Readonly<Record<string, number>>
  readonly #clock: Clock
  readonly #sessions = new Map<string, CursorSession>()

  constructor(config: CursorProviderConfig = {}) {
    this.#executable = config.executable ?? defaultCursorExecutable
    this.#executableArgs = Object.freeze([...(config.executableArgs ?? [])])
    this.#limits = Object.freeze({ ...(config.contextLimits ?? {}) })
    this.#clock = config.clock ?? systemClock
  }

  /**
   * Check the spec, then create a chat and deliver the brief as its first turn.
   *
   * The chat is created before anything is spent: `create-chat` is local, and it
   * is what gives the handle a `sessionRef` that `resume()` can be called with
   * later, whether or not the brief turn ever answers.
   */
  async start(spec: SessionSpec): Promise<SessionHandle> {
    this.#check(spec)
    const chatId = this.#createChat(spec)
    const session = new CursorSession(chatId, spec, this.#config())
    this.#sessions.set(session.sessionId, session)
    session.begin()
    return session.handle()
  }

  /**
   * The person's side of a takeover (watch-and-attach §5): interactive
   * `cursor-agent` on the same chat, in plan mode and on the peer's model —
   * left to itself it opens on its own default model. No `--trust`: a person is
   * there to answer the prompt.
   */
  attachCommand(ref: ProviderSessionRef, spec: SessionSpec): AttachCommand {
    return {
      executable: this.#executable,
      args: [...this.#executableArgs, '--resume', ref, '--mode', CURSOR_PERMISSION_MODE, '--model', spec.model],
    }
  }

  /** Continue an existing chat. The ref is the chat id a previous handle carried. */
  async resume(ref: ProviderSessionRef, spec: SessionSpec): Promise<SessionHandle> {
    this.#check(spec)
    if (!CHAT_ID.test(ref)) {
      throw fleetError('invalid_input', `"${ref}" is not a cursor chat id, so there is nothing to resume`, {
        details: { providerId: this.id, sessionRef: ref },
      })
    }
    const session = new CursorSession(ref, spec, this.#config())
    this.#sessions.set(session.sessionId, session)
    session.begin()
    return session.handle()
  }

  async send(handle: SessionHandle, turn: Turn): Promise<TurnId> {
    return this.#session(handle).send(turn)
  }

  async interrupt(handle: SessionHandle, _turn?: TurnId): Promise<void> {
    await this.#session(handle).interrupt()
  }

  /**
   * `unsupported`, always: plan mode asks nobody for permission, so no
   * `approval.requested` can exist, and a session that could not answer would
   * park forever (§4).
   */
  async respond(_handle: SessionHandle, _requestId: string, _decision: ApprovalDecision): Promise<void> {
    throw unsupported('respond')
  }

  /** `unsupported`, always, for `respond()`'s reason: no `question.asked` can be raised. */
  async answer(_handle: SessionHandle, _questionId: QuestionId, _answer: QuestionAnswer): Promise<void> {
    throw unsupported('answer')
  }

  async stop(handle: SessionHandle): Promise<void> {
    await this.#session(handle).stop()
  }

  async status(handle: SessionHandle): Promise<PeerState> {
    return this.#session(handle).status()
  }

  async usage(handle: SessionHandle): Promise<Usage> {
    return this.#session(handle).usage()
  }

  /** Requested, not confirmed: see the file header. */
  async model(handle: SessionHandle): Promise<{ id: string }> {
    return this.#session(handle).model()
  }

  events(handle: SessionHandle): AsyncIterable<ProviderEvent> {
    return this.#session(handle).events()
  }

  display(handle: SessionHandle): AsyncIterable<DisplayLine> {
    return this.#session(handle).display()
  }

  /** The next turn runs on `model`; confirmation is that turn, so nothing is awaited here. */
  async setModel(handle: SessionHandle, model: string): Promise<void> {
    this.#checkModel(model, 'setModel')
    this.#session(handle).setModel(model)
  }

  // ------------------------------------------------------------------ internals

  #session(handle: SessionHandle): CursorSession {
    const session = this.#sessions.get(handle.sessionId)
    if (session === undefined) {
      throw fleetError('not_found', `no cursor session ${handle.sessionId}; it was never started here`, {
        details: { providerId: this.id, sessionId: handle.sessionId },
      })
    }
    return session
  }

  #config(): { providerId: string; executable: string; executableArgs: readonly string[]; contextLimits: Readonly<Record<string, number>>; clock: Clock } {
    return {
      providerId: this.id,
      executable: this.#executable,
      executableArgs: this.#executableArgs,
      contextLimits: this.#limits,
      clock: this.#clock,
    }
  }

  /**
   * Refuse a spec before anything spawns. The first thing wrong is the one
   * reported: a session in a writing mode is the one that must never be
   * half-started, so it is checked first.
   */
  #check(spec: SessionSpec): void {
    if (spec.permissionMode !== CURSOR_PERMISSION_MODE) {
      throw fleetError(
        'unsupported',
        `cursor sessions are read-only: this one asked for "${spec.permissionMode}" and the only mode it honours is ` +
          `"${CURSOR_PERMISSION_MODE}". Nothing was started — a cursor peer that could write would have no tool policy ` +
          'standing between it and the files, because this CLI offers no per-call hook to enforce one',
        {
          details: {
            providerId: this.id,
            peerId: spec.peerId,
            requested: spec.permissionMode,
            supported: cursorCapabilities.permissionModes,
          },
        },
      )
    }
    this.#checkModel(spec.model, `peer ${spec.peerId}`)
    contextLimitFor(this.#limits, spec.model)
    if (spec.mcp !== undefined && spec.mcp.length > 0) {
      throw fleetError(
        'unsupported',
        `cursor sessions do not wire MCP servers, and peer ${spec.peerId} asked for ${spec.mcp.length}; nothing was started`,
        { details: { providerId: this.id, peerId: spec.peerId, servers: spec.mcp.map((server) => server.id) } },
      )
    }
  }

  #checkModel(model: string, where: string): void {
    if (model.trim() === '') {
      throw fleetError('invalid_input', `${where}: a cursor session needs a model id`, {
        details: { providerId: this.id },
      })
    }
    if (model === CURSOR_AUTO_MODEL) {
      throw fleetError(
        'invalid_input',
        `${where}: "${CURSOR_AUTO_MODEL}" is cursor's own choice of model, not a model; nothing was started. ` +
          'model() has to report the id a session runs, and this CLI reports only a display name — name a model instead',
        { details: { providerId: this.id, model, known: Object.keys(this.#limits) } },
      )
    }
  }

  /** Run `create-chat` and return the id it prints. Local, offline, no model call. */
  #createChat(spec: SessionSpec): ProviderSessionRef {
    const result = spawnSync(this.#executable, [...this.#executableArgs, 'create-chat'], {
      cwd: spec.cwd,
      // The allowlist, not `process.env`: this process is `cursor-agent`, which runs
      // shell tools, and fleetd's own environment may hold keys the peer never asked for.
      env: { ...buildChildEnv(spec).env },
      encoding: 'utf8',
      timeout: 60_000,
    })
    if (result.error !== undefined) {
      throw fleetError('provider_failed', `cursor-agent create-chat could not run: ${result.error.message}`, {
        details: { providerId: this.id, peerId: spec.peerId, executable: this.#executable },
        cause: result.error,
      })
    }
    if (result.status !== 0) {
      // stderr is not quoted: this CLI echoes request detail there and these
      // strings travel into events, which are stored.
      throw fleetError(
        'provider_failed',
        `cursor-agent create-chat exited with code ${String(result.status)}; no chat, so nothing was started`,
        { details: { providerId: this.id, peerId: spec.peerId, executable: this.#executable } },
      )
    }
    const chatId = result.stdout.trim()
    if (!CHAT_ID.test(chatId)) {
      throw fleetError('provider_failed', 'cursor-agent create-chat did not print a chat id', {
        details: { providerId: this.id, peerId: spec.peerId },
      })
    }
    return chatId as ProviderSessionRef
  }
}

const unsupported = (method: string): Error =>
  fleetError(
    'unsupported',
    `cursor cannot ${method}(): a plan-mode session raises no question and no approval, so there is nothing to resolve`,
    { details: { providerId: 'cursor', method, permissionModes: cursorCapabilities.permissionModes } },
  )

/** The package's one export a registry needs: a provider, built from config. */
export const createCursorProvider = (config: CursorProviderConfig = {}): Provider => new CursorProvider(config)
