/**
 * A scripted peer, for the integration tests that drive the real daemon.
 *
 * The daemon, the store, the supervisor, the purge and the socket are the
 * production ones; only the *agent* is scripted, because the model's part of a
 * lifecycle test (it takes turns, it writes a state file when asked, it dies
 * when the test kills it) is the one part that is neither deterministic nor
 * free. §15's exit test asks the same thing of a real peer later; this is the
 * half of it that belongs in CI.
 *
 * Everything a test needs to see is recorded: every `start` spec (so the brief,
 * the state file and the cwd can be asserted), every turn handed to the peer,
 * and every session the fake minted. A provider here never reaches the network
 * and never reads a key.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// `tests/` is not a workspace package (§1.1 ships `packages/**` and `apps/**`), so
// these reach the sources by path rather than by package name. The daemon files
// this harness loads do use their own package names, which resolve through
// `apps/daemon/node_modules` as they do in production.
import type {
  PeerId,
  ProviderSessionRef,
  QuestionId,
  TurnId,
} from '../../../packages/foundation/core/src/index.ts'
import type {
  ProviderEvent,
  QuestionAnswer,
  SessionSpec,
  Turn,
  Usage,
} from '../../../packages/foundation/contracts/src/index.ts'
import type {
  ApprovalDecision,
  Provider,
  SessionHandle,
} from '../../../packages/runtime/providers/sdk/src/index.ts'

/** A stream a test pushes into, so the supervisor never waits on a real process. */
class Feed {
  readonly #queue: ProviderEvent[] = []
  #waiter: ((result: IteratorResult<ProviderEvent>) => void) | undefined
  #failure: unknown
  #closed = false

  push(...events: readonly ProviderEvent[]): void {
    for (const event of events) {
      if (this.#waiter !== undefined) {
        const waiter = this.#waiter
        this.#waiter = undefined
        waiter({ value: event, done: false })
      } else {
        this.#queue.push(event)
      }
    }
  }

  /** The provider died: the stream throws, which is what a killed process looks like to the supervisor. */
  fail(error: unknown): void {
    this.#failure = error
    if (this.#waiter !== undefined) {
      const waiter = this.#waiter
      this.#waiter = undefined
      // The waiter closure turns this wake-up into a rejection; the value is
      // never read once `#failure` is set.
      waiter({ value: undefined, done: true })
    }
  }

  close(): void {
    this.#closed = true
    if (this.#waiter !== undefined) {
      const waiter = this.#waiter
      this.#waiter = undefined
      waiter({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    return {
      next: (): Promise<IteratorResult<ProviderEvent>> => {
        // Queued events are handed over before a failure is reported: a turn
        // that started before the process died did start, and the pump must see
        // it to know the session was mid-turn.
        const queued = this.#queue.shift()
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
        if (this.#failure !== undefined) return Promise.reject(this.#failure)
        if (this.#closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => {
          this.#waiter = (result) => {
            if (this.#failure !== undefined) {
              reject(this.#failure)
              return
            }
            resolve(result)
          }
        })
      },
      return: () => Promise.resolve({ value: undefined, done: true }),
    }
  }
}

export interface ScriptedSession {
  readonly index: number
  readonly handle: SessionHandle
  readonly spec: SessionSpec
  readonly feed: Feed
}

export interface ScriptedOptions {
  /** The provider id the profile names. Defaults to `claude`. */
  readonly id?: string
  /**
   * What `usage()` reports for the session this index started, so a test can
   * put the first session past the purge limit and keep the next one under it.
   */
  readonly usage?: (index: number) => Usage
  /**
   * The window this provider claims for a model, as `Provider.contextLimit`
   * answers it (§8, §6.2). Defaults to the same 1 000 `usage()` reports, so the
   * env a session is started with and the number it later reports agree —
   * which is the property `FLEET_CONTEXT_LIMIT` exists to keep.
   */
  readonly contextLimit?: (model: string) => number | undefined
  /**
   * Where a peer's state file goes, by peer id. The purge asks for one and then
   * reads the file at this path, so the scripted peer writes there when asked —
   * which is exactly what a real peer's Write tool does.
   */
  readonly stateFile?: (peerId: PeerId) => string
  /** The state file the peer writes when the purge asks. Defaults to a valid one for the peer. */
  readonly stateFileFor?: (spec: SessionSpec) => string
  /**
   * Leave `info`/`answer` turns open until the test ends them, so a session can
   * be killed *mid-turn* — which is what §15's exit test kills.
   */
  readonly holdWork?: boolean
}

export interface ScriptedProvider {
  readonly provider: Provider
  /** Every session started, oldest first — `[0]` is the one `up` started. */
  readonly sessions: readonly ScriptedSession[]
  /** Every turn handed to a peer, with the session it went to. */
  readonly turns: { readonly sessionId: string; readonly text: string; readonly kind: string }[]
  /** The session with this id, or `undefined`. */
  session(id: string): ScriptedSession | undefined
  /** Kill one session's process mid-stream: the pump's stream throws. */
  crash(id: string): void
  /** A clean end the provider reports itself (`session.ended`), not a crash. */
  end(id: string, code?: number): void
  /** Stop handing back events for a session without reporting anything. */
  quiet(id: string): void
  /** Is a `holdWork` turn open on this session right now? */
  openTurn(id: string): boolean
  /** End a turn `holdWork` left open. */
  endTurn(id: string, reason?: 'completed' | 'failed'): void
}

const hex = (value: number): string => value.toString(16).padStart(16, '0')
const sessionIdOf = (index: number): string => `ses_${hex(0x5e5 + index)}`
const turnIdOf = (index: number, turn: number): TurnId => `trn_${hex(index * 1000 + turn)}` as TurnId

const defaultStateFile = (spec: SessionSpec): string =>
  ['```json', JSON.stringify({ peerId: spec.peerId, goal: `finish ${spec.role} work`, done: [], inFlight: [], next: [], decisions: [], openQuestions: [], briefVersion: spec.brief.version }, null, 2), '```'].join('\n')

export const createScriptedProvider = (options: ScriptedOptions = {}): ScriptedProvider => {
  const id = options.id ?? 'claude'
  const sessions: ScriptedSession[] = []
  const turns: { sessionId: string; text: string; kind: string }[] = []
  const byId = new Map<string, ScriptedSession>()
  /** Turns `holdWork` left open, by session id. */
  const open = new Map<string, { readonly turnId: TurnId; readonly at: string }>()
  const usage = options.usage ?? (() => ({ contextTokens: 10, contextLimit: 1_000 }))

  const writeStateFile = async (spec: SessionSpec): Promise<void> => {
    const path = options.stateFile?.(spec.peerId)
    if (path === undefined) return
    const text = options.stateFileFor?.(spec) ?? defaultStateFile(spec)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
  }

  /**
   * One turn, start to end, on the next microtask so the caller has the turn id
   * before anything reaches the stream — which is how a real provider behaves.
   */
  const runTurn = (session: ScriptedSession, turn: Turn): TurnId => {
    const turnId = turnIdOf(session.index, turns.length + 1)
    const at = new Date().toISOString()
    setImmediate(() => {
      session.feed.push({ type: 'turn.started', turnId, at })
      // The purge's ask is the one turn whose answer is a file, not text (§8),
      // and it always ends: the purge is waiting for exactly that boundary.
      if (turn.kind === 'nudge') {
        void (async () => {
          if (turn.text.includes('state file')) await writeStateFile(session.spec)
          session.feed.push({ type: 'turn.ended', turnId, at: new Date().toISOString(), reason: 'completed' })
        })()
        return
      }
      if (options.holdWork === true) {
        open.set(session.handle.sessionId, { turnId, at })
        return
      }
      session.feed.push({ type: 'turn.ended', turnId, at: new Date().toISOString(), reason: 'completed' })
    })
    return turnId
  }

  const provider: Provider = {
    id,
    capabilities: Object.freeze({
      resume: true,
      modelSwitch: true,
      usageTokens: true,
      usageCost: false,
      structuredOutput: true,
      permissionModes: Object.freeze(['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const),
    }),

    async start(spec: SessionSpec): Promise<SessionHandle> {
      const index = sessions.length
      const handle: SessionHandle = {
        sessionId: sessionIdOf(index),
        sessionRef: `ref-${String(index)}` as ProviderSessionRef,
        peerId: String(spec.peerId),
        providerId: id,
        model: spec.model,
        permissionMode: spec.permissionMode,
        briefTurnId: turnIdOf(index, 0),
      }
      const session: ScriptedSession = { index, handle, spec, feed: new Feed() }
      sessions.push(session)
      byId.set(handle.sessionId, session)
      // A real provider starts the brief as a turn; the first `turn.started`
      // refers to `briefTurnId` (§4), so the pump sees a session that works.
      setImmediate(() => {
        session.feed.push({ type: 'turn.started', turnId: handle.briefTurnId, at: new Date().toISOString() })
        session.feed.push({
          type: 'turn.ended',
          turnId: handle.briefTurnId,
          at: new Date().toISOString(),
          reason: 'completed',
        })
      })
      return handle
    },

    async send(handle: SessionHandle, turn: Turn): Promise<TurnId> {
      const session = byId.get(handle.sessionId)
      if (session === undefined) throw new Error(`no scripted session ${handle.sessionId}`)
      turns.push({ sessionId: handle.sessionId, text: turn.text, kind: turn.kind })
      return runTurn(session, turn)
    },

    async interrupt(): Promise<void> {},
    async answer(_handle: SessionHandle, _questionId: QuestionId, _answer: QuestionAnswer): Promise<void> {},
    async respond(_handle: SessionHandle, _requestId: string, _decision: ApprovalDecision): Promise<void> {},
    async setModel(): Promise<void> {},

    async stop(handle: SessionHandle): Promise<void> {
      const session = byId.get(handle.sessionId)
      // The adapter synthesises `session.ended` when we stop it (§4).
      session?.feed.push({ type: 'session.ended', reason: 'stopped' })
      session?.feed.close()
    },

    async status(handle: SessionHandle) {
      return byId.has(handle.sessionId) ? ('idle' as const) : ('ended' as const)
    },

    async usage(handle: SessionHandle): Promise<Usage> {
      const session = byId.get(handle.sessionId)
      return usage(session?.index ?? 0)
    },

    // The number the supervisor puts in a session's env, so a test can assert
    // that a composed session is one the Stop hook would accept (§6.2, §8).
    contextLimit(model: string): number | undefined {
      return options.contextLimit?.(model) ?? usage(0).contextLimit
    },

    async model(handle: SessionHandle) {
      return { id: handle.model }
    },

    events: (handle: SessionHandle): AsyncIterable<ProviderEvent> => {
      const session = byId.get(handle.sessionId)
      if (session === undefined) throw new Error(`no scripted session ${handle.sessionId}`)
      return session.feed
    },

    async resume(_ref: ProviderSessionRef, spec: SessionSpec): Promise<SessionHandle> {
      return provider.start(spec)
    },
  }

  return {
    provider,
    sessions,
    turns,
    session: (sessionId) => byId.get(sessionId),
    crash: (sessionId) => {
      byId.get(sessionId)?.feed.fail(new Error(`the process for ${sessionId} was killed mid-turn`))
    },
    end: (sessionId, code) => {
      const session = byId.get(sessionId)
      session?.feed.push({ type: 'session.ended', reason: code === 0 || code === undefined ? 'exit' : 'crash', ...(code === undefined ? {} : { code }) })
      session?.feed.close()
    },
    quiet: (sessionId) => {
      byId.get(sessionId)?.feed.close()
    },
    openTurn: (sessionId) => open.has(sessionId),
    endTurn: (sessionId, reason = 'completed') => {
      const session = byId.get(sessionId)
      const turn = open.get(sessionId)
      if (session === undefined || turn === undefined) return
      open.delete(sessionId)
      session.feed.push({ type: 'turn.ended', turnId: turn.turnId, at: new Date().toISOString(), reason })
    },
  }
}
