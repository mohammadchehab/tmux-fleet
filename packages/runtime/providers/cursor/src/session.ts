/**
 * One cursor session: a chat id, and one `cursor-agent` process per turn (§4).
 *
 * The CLI's shape forces almost all of this, and it is a different shape from
 * the SDK-backed providers next to it:
 *
 * - **`-p` is one prompt per process.** There is no streaming input, so `send()`
 *   spawns a process rather than pushing into an open one. The cheaper of the
 *   two ways to keep a conversation is `--resume <chatId>`, so the session's
 *   identity is the chat id and each turn is a fresh process that continues it.
 *   That is also why `interrupt()` kills a process instead of aborting a turn.
 * - **`create-chat` gives the handle a real ref before anything runs.** It is
 *   local, takes no model call, and prints the id `--resume` takes, so `start()`
 *   has a `ProviderSessionRef` before the brief turn spends a token.
 * - **The process exiting is not the session ending.** A turn's process exits
 *   normally after every turn; treating that as `session.ended` would have the
 *   supervisor restarting a healthy session after each message. So a turn's
 *   exit ends the *turn*, and only `stop()` ends the session — or an executable
 *   that could not be run at all, which is a session that cannot continue.
 * - **One turn at a time.** The chat store is a single file per chat, so two
 *   concurrent processes on one chat id would interleave. A `send()` while a
 *   turn is live is refused `conflict` rather than queued: the supervisor sends
 *   one turn at a time, and a queue here would hide a caller that does not.
 * - **Read-only is enforced at `start()`, not negotiated.** `--mode plan` is the
 *   guarantee (§13); this adapter refuses any other permission mode, and refuses
 *   a session with MCP servers it cannot wire. A `toolPolicy` cannot be
 *   honoured — this CLI has no per-call hook — so it is accepted and ignored,
 *   and plan mode is what makes that safe.
 * - **stderr is not surfaced.** The CLI echoes request detail there, and these
 *   strings become stored events; a failure is reported by exit code instead.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

import {
  fleetError,
  newSessionId,
  newTurnId,
  systemClock,
  type Clock,
  type PeerState,
  type SessionId,
  type Timestamp,
  type TurnId,
} from '@fleet/foundation-core'
import type {
  ProviderEvent,
  ProviderSessionRef,
  SessionSpec,
  Turn,
  TurnEndReason,
  Usage,
} from '@fleet/runtime-provider-sdk'
import { buildChildEnv } from '@fleet/runtime-provider-sdk'

import { openingMessage } from './brief.ts'
import { parseLines, type CursorTurnUsage } from './stream.ts'
import { usageOf } from './usage.ts'

/** Everything about *how* a cursor session runs that is not part of a `SessionSpec`. */
export interface CursorSessionConfig {
  readonly providerId: string
  /** `cursor-agent`, or a path to it. */
  readonly executable: string
  /** Arguments before the CLI's own — a test's fake binary needs them; a real one does not. */
  readonly executableArgs: readonly string[]
  /** Configured context windows per model id; `usage()` has no other source (§8). */
  readonly contextLimits: Readonly<Record<string, number>>
  readonly clock: Clock
}

/** What the adapter spawns, and how it says so. */
const MODE_ARGUMENTS = ['--mode', 'plan'] as const

/** The turn's process: stdin closed, both output pipes read. */
type TurnProcess = ChildProcessByStdio<null, Readable, Readable>

interface LiveTurn {
  readonly turnId: TurnId
  readonly child: TurnProcess
  readonly at: Timestamp
  interrupted: boolean
  ended: boolean
  usage: CursorTurnUsage | undefined
}

/** A session as its provider sees it: identity is a snapshot, state is live. */
export class CursorSession {
  readonly sessionId: SessionId = newSessionId()
  readonly peerId: string
  readonly providerId: string
  /** The chat this session continues, from `create-chat` or from the ref it resumed. */
  readonly chatId: ProviderSessionRef
  readonly briefTurnId: TurnId = newTurnId()
  readonly permissionMode = 'plan'

  readonly #spec: SessionSpec
  readonly #config: CursorSessionConfig
  readonly #events = new EventQueue()
  #model: string
  #state: PeerState = 'starting'
  #live: LiveTurn | undefined
  #turnTokens: CursorTurnUsage | undefined
  #ended = false

  constructor(chatId: ProviderSessionRef, spec: SessionSpec, config: CursorSessionConfig) {
    this.peerId = spec.peerId
    this.providerId = config.providerId
    this.chatId = chatId
    this.#spec = spec
    this.#config = config
    this.#model = spec.model
  }

  /** The handle the provider hands out; a snapshot of identity, not of state. */
  handle(): {
    readonly sessionId: SessionId
    readonly sessionRef: ProviderSessionRef
    readonly peerId: string
    readonly providerId: string
    readonly model: string
    readonly permissionMode: string
    readonly briefTurnId: TurnId
  } {
    return {
      sessionId: this.sessionId,
      sessionRef: this.chatId,
      peerId: this.peerId,
      providerId: this.providerId,
      model: this.#model,
      permissionMode: this.permissionMode,
      briefTurnId: this.briefTurnId,
    }
  }

  /**
   * Deliver the brief as the opening turn (§7). Not awaited: a turn takes as long
   * as the model takes, and `start()` returning means the session exists, not
   * that its first answer has arrived — the same bargain the SDK-backed
   * providers make.
   */
  begin(): void {
    this.#open(this.briefTurnId, openingMessage(this.#spec))
  }

  /** A turn, never keystrokes (§7). Refused while another turn is live. */
  send(turn: Turn): TurnId {
    if (this.#ended) {
      throw fleetError('conflict', `cursor session ${this.sessionId} has ended; nothing was sent`)
    }
    if (this.#live !== undefined) {
      throw fleetError(
        'conflict',
        `cursor session ${this.sessionId} is still running turn ${this.#live.turnId}; ` +
          'a cursor chat takes one turn at a time, and the message was not sent',
        { details: { sessionId: this.sessionId, turnId: this.#live.turnId } },
      )
    }
    const turnId = newTurnId()
    this.#open(turnId, turn)
    return turnId
  }

  /**
   * Stop the live turn. The process is killed and the turn is reported
   * `interrupted` when it exits; the session stays usable, because the chat it
   * resumes from is a file the killed process was the only writer of.
   */
  async interrupt(): Promise<void> {
    const live = this.#live
    if (live === undefined || live.ended) return
    live.interrupted = true
    live.child.kill('SIGTERM')
  }

  async stop(): Promise<void> {
    if (this.#ended) return
    const live = this.#live
    if (live !== undefined && !live.ended) {
      live.interrupted = true
      live.child.kill('SIGTERM')
      this.#endTurn(live, live.usage)
    }
    this.#ended = true
    this.#state = 'ended'
    this.#emit({ type: 'session.ended', reason: 'stopped' })
    this.#events.close()
  }

  status(): PeerState {
    return this.#state
  }

  /**
   * The turn-measured proxy for context, against the configured window (§8).
   * See `usage.ts` for why each half comes from where it does.
   */
  usage(): Usage {
    return usageOf({
      turn: this.#turnTokens,
      previousTokens: 0,
      model: this.#model,
      limits: this.#config.contextLimits,
    })
  }

  /**
   * The id the session was *asked* to run — "requested, not confirmed". The CLI
   * reports a display name in its `init` line and nothing else that names the
   * model, so the requested id is the only honest answer, and `start()` refuses
   * `auto` rather than report a name that describes a choice this adapter did not
   * make.
   */
  model(): { id: string } {
    return { id: this.#model }
  }

  /** The model the next turn runs. Confirmation is the turn itself; see `model()`. */
  setModel(model: string): void {
    this.#model = model
  }

  events(): AsyncIterable<ProviderEvent> {
    return this.#events
  }

  // ------------------------------------------------------------------ turns

  /** Spawn the process for one turn and start reading it. */
  #open(turnId: TurnId, turn: Turn): void {
    const at = this.#config.clock.now()
    this.#emit({ type: 'turn.started', turnId, at })
    this.#state = 'working'

    const args = [
      ...this.#config.executableArgs,
      '-p',
      '--output-format',
      'stream-json',
      ...MODE_ARGUMENTS,
      '--model',
      this.#model,
      '--resume',
      this.chatId,
      turn.text,
    ]
    let child: TurnProcess
    try {
      child = spawn(this.#config.executable, args, {
        cwd: this.#spec.cwd,
        // The spec's env is this one process's environment, which is what removes
        // v1's shared-tmux env drift (§4, §13, §14.1) — on top of an allowlist of
        // process variables, never `process.env`, so fleetd's keys stay in fleetd.
        env: { ...buildChildEnv(this.#spec).env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as TurnProcess
    } catch (thrown) {
      this.#state = 'idle'
      this.#emit({ type: 'turn.ended', turnId, at, reason: 'failed', error: describe(thrown) })
      this.#emit({ type: 'session.ended', reason: 'crash' })
      this.#ended = true
      this.#events.close()
      return
    }

    const live: LiveTurn = { turnId, child, at, interrupted: false, ended: false, usage: undefined }
    this.#live = live
    this.#pump(live)
  }

  /** Read the turn's stdout, and finish the turn when the process is done. */
  #pump(live: LiveTurn): void {
    let buffered = ''
    live.child.stdout.setEncoding('utf8')
    live.child.stdout.on('data', (chunk: string) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of parseLines(lines.join('\n'))) this.#line(live, line)
    })

    live.child.on('error', (thrown: unknown) => {
      // The executable could not be run at all: no turn, and no session either.
      if (live.ended) return
      live.ended = true
      this.#live = undefined
      this.#state = 'failed'
      this.#ended = true
      this.#emit({ type: 'turn.ended', turnId: live.turnId, at: this.#config.clock.now(), reason: 'failed', error: describe(thrown) })
      this.#emit({ type: 'error', message: describe(thrown), retryable: false })
      this.#emit({ type: 'session.ended', reason: 'crash' })
      this.#events.close()
    })

    live.child.on('close', (code: number | null, signal: string | null) => {
      if (live.ended) {
        if (this.#live === live) this.#live = undefined
        return
      }
      // A last line without a trailing newline: the result may be in it.
      for (const line of parseLines(buffered)) this.#line(live, line)
      buffered = ''
      if (live.ended) return
      live.ended = true
      if (this.#live === live) this.#live = undefined
      const at = this.#config.clock.now()
      if (live.interrupted) {
        this.#emit({ type: 'turn.ended', turnId: live.turnId, at, reason: 'interrupted', ...usageField(live.usage, this.#config.contextLimits, this.#model) })
      } else {
        this.#emit({
          type: 'turn.ended',
          turnId: live.turnId,
          at,
          reason: 'failed',
          error: `cursor-agent exited with ${code === null ? `signal ${String(signal)}` : `code ${String(code)}`} without reporting a result`,
          ...usageField(live.usage, this.#config.contextLimits, this.#model),
        })
      }
      if (!this.#ended) this.#state = 'idle'
    })
  }

  /** Act on one parsed line. */
  #line(live: LiveTurn, line: ReturnType<typeof parseLines>[number]): void {
    if (live.ended) return
    switch (line.kind) {
      case 'tool':
        // Only the start of a call is a `tool.use`; the completion would double
        // every tool in the ledger.
        if (line.phase === 'started') this.#emit({ type: 'tool.use', turnId: live.turnId, tool: line.tool })
        return
      case 'result': {
        live.usage = line.usage
        this.#turnTokens = line.usage
        const reason: TurnEndReason = live.interrupted ? 'interrupted' : line.failed ? 'failed' : 'completed'
        this.#endTurn(live, line.usage, line.error)
        if (reason === 'failed') {
          this.#emit({ type: 'error', message: line.error ?? 'cursor-agent reported a failed turn', retryable: true })
        }
        return
      }
      // `init` names a display model and its own permission vocabulary, and the
      // assistant's prose has no contract event; neither decides anything here.
      case 'init':
      case 'assistant':
      case 'other':
        return
    }
  }

  #endTurn(live: LiveTurn, usage: CursorTurnUsage | undefined, error?: string): void {
    if (live.ended) return
    live.ended = true
    const at = this.#config.clock.now()
    this.#emit({
      type: 'turn.ended',
      turnId: live.turnId,
      at,
      reason: live.interrupted ? 'interrupted' : error === undefined ? 'completed' : 'failed',
      ...(error === undefined ? {} : { error }),
      ...usageField(usage, this.#config.contextLimits, this.#model),
    })
    if (this.#live === live) this.#live = undefined
    if (!this.#ended) this.#state = 'idle'
  }

  #emit(event: ProviderEvent): void {
    this.#events.push(event)
  }
}

/** `turn.ended`'s usage, when the turn measured one and the model has a window. */
const usageField = (
  usage: CursorTurnUsage | undefined,
  limits: Readonly<Record<string, number>>,
  model: string,
): { usage?: Usage } => {
  if (usage === undefined) return {}
  try {
    return { usage: usageOf({ turn: usage, previousTokens: 0, model, limits }) }
  } catch {
    // A model whose window disappeared between turns: the turn still ended, and
    // reporting no usage is better than failing the event that says so.
    return {}
  }
}

const describe = (thrown: unknown): string =>
  thrown instanceof Error ? thrown.message : typeof thrown === 'string' ? thrown : 'cursor-agent failed to start'

/** An unbounded queue of events with one consumer; closed when the session ends. */
class EventQueue implements AsyncIterable<ProviderEvent> {
  readonly #queued: ProviderEvent[] = []
  #wake: (() => void) | undefined
  #closed = false

  push(event: ProviderEvent): void {
    if (this.#closed) return
    this.#queued.push(event)
    const wake = this.#wake
    this.#wake = undefined
    wake?.()
  }

  close(): void {
    this.#closed = true
    const wake = this.#wake
    this.#wake = undefined
    wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
    for (;;) {
      const next = this.#queued.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.#closed) return
      await new Promise<void>((resolve) => {
        this.#wake = resolve
      })
    }
  }
}

/** The default executable, and the clock a session runs by. */
export const defaultCursorExecutable = 'cursor-agent'
export const defaultCursorClock = systemClock
