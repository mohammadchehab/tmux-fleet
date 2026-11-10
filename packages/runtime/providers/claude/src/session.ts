/**
 * One Claude session: the `query()` call, the input stream, the event pump, and
 * the two maps that decide what the session is doing right now.
 *
 * The shape is forced by the SDK, and the spike measured every part of it
 * (`docs/design/spikes/agent-sdk.md`):
 *
 * - **streaming input** (`prompt: AsyncIterable<SDKUserMessage>`) is not
 *   optional. A string prompt is one turn and closes; multi-turn `send()`,
 *   `interrupt()`, `setPermissionMode()` and `getContextUsage()` all need the
 *   open stream.
 * - the CLI emits nothing until the first user message arrives — not even
 *   `init` — so `start()` delivers the brief as the opening turn (§7) and waits
 *   for the `init` that follows it.
 * - `init` is **re-emitted at the start of every turn**, so the latest one is
 *   the truth about the running process. The launch check uses the first, which
 *   is the only one that describes how the session came up.
 * - `interrupt()` does not throw anything through the iterator: the aborted turn
 *   ends as a `result` with `is_error: true` and `terminal_reason:
 *   'aborted_tools'`, and the session stays usable. So an interrupt is recorded
 *   *before* it happens and read back when the `result` arrives.
 * - `canUseTool` is the one control channel for both an `AskUserQuestion` and a
 *   permission prompt, and the turn blocks on its promise with no deadline:
 *   leaving it unsettled parks the session forever (§4's `waiting_input`).
 * - **`canUseTool` is only consulted in modes that ask.** Under
 *   `bypassPermissions` the SDK shadows it entirely (it warns
 *   `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` on construction), so a peer in that mode
 *   can never report `waiting_input` — its questions are auto-approved with no
 *   answer. A session that must be able to ask its supervisor runs in
 *   `default`, `acceptEdits` or `plan`.
 */

import { query, type Options, type PermissionResult, type Query } from '@anthropic-ai/claude-agent-sdk'
import {
  fleetError,
  isLive,
  newSessionId,
  newTurnId,
  systemClock,
  type Clock,
  type FleetError,
  type PeerState,
  type QuestionId,
  type SessionId,
  type Timestamp,
  type TurnId,
} from '@fleet/foundation-core'
import type {
  ApprovalDecision,
  ProviderEvent,
  ProviderSessionRef,
  QuestionAnswer,
  SessionSpec,
  Turn,
  Usage,
} from '@fleet/runtime-provider-sdk'

import { buildChildEnv, recordedEndpoint } from './env.ts'
import { isContractEvent, type AdapterEvent } from './events.ts'
import { mapMessage, questionAnswers, readQuestions, type TurnState } from './messages.ts'
import { PendingRequests } from './pending.ts'
import { compilePolicy, evaluatePolicy, QUESTION_TOOL, type CompiledToolPolicy } from './policy.ts'
import { fallbackTokensFrom, usageFrom, type ContextLimits } from './usage.ts'

/** Everything about *how* a Claude session runs that is not part of a `SessionSpec`. */
export interface ClaudeSessionConfig {
  readonly providerId: string
  /** Configured context windows; `usage()` never invents a limit (§8). */
  readonly limits: ContextLimits
  /** `full` counts every category through the token API; `summary` is cheap and unreliable on some endpoints. */
  readonly contextDetail: 'full' | 'summary'
  /** Report `costUsd` when the endpoint's numbers are comparable between sessions. */
  readonly usageCost: boolean
  /** SDK setting sources. `[]` is SDK isolation: no user, project or local settings (§5 of the spike). */
  readonly settingSources: readonly ('user' | 'project' | 'local')[]
  /** How long `start()` waits for `init` before calling the session failed. */
  readonly initTimeoutMs: number
  readonly clock: Clock
}

export const defaultSessionConfig: ClaudeSessionConfig = {
  providerId: 'claude',
  limits: { byModel: {}, fallback: 200_000 },
  contextDetail: 'full',
  usageCost: true,
  settingSources: [],
  initTimeoutMs: 60_000,
  clock: systemClock,
}

/** A session as its provider sees it: identity is a snapshot, state is live. */
export class ClaudeSession {
  readonly sessionId: SessionId
  readonly peerId: string
  readonly providerId: string

  readonly #spec: SessionSpec
  readonly #config: ClaudeSessionConfig
  readonly #input: InputQueue
  readonly #events = new EventQueue()
  readonly #pending: PendingRequests
  /** Compiled at construction: an invalid pattern is a start failure, not a mid-turn one (§4). */
  readonly #policy: CompiledToolPolicy
  readonly #openingTurn: TurnId
  readonly #started = deferred<{ model: string; permissionMode: string }>()
  readonly #query: Query

  #sessionRef: ProviderSessionRef | undefined
  /** The latest `init`'s model; the process's model right now, not the one requested. */
  #observedModel: string | undefined
  /**
   * The model the session is *asked* to run: `spec.model`, until `setModel()`
   * replaces it. Every `init` is compared against this, so a switch that did
   * not take is reported rather than assumed.
   */
  #requestedModel: string
  #observedMode: string | undefined
  #state: PeerState = 'starting'
  #inflight: TurnId[] = []
  #turnState: TurnState = { interrupted: false }
  #lastContextTokens: number | undefined
  #lastCostUsd: number | undefined
  #pump: Promise<void> | undefined

  constructor(spec: SessionSpec, config: ClaudeSessionConfig, resumeRef: ProviderSessionRef | undefined) {
    this.#spec = spec
    this.#config = config
    this.sessionId = newSessionId()
    this.peerId = spec.peerId
    this.providerId = config.providerId
    this.#requestedModel = spec.model
    // `SessionSpec.toolPolicy` is the contract's now; absent means
    // ask-about-everything, which is what §4 did before the field existed. The
    // spec's cwd is what relative path rules are resolved against, so a rule and
    // the tool agree on the file.
    this.#policy = compilePolicy(spec.toolPolicy, { cwd: spec.cwd })
    this.#pending = new PendingRequests(() => config.clock.now())
    this.#input = new InputQueue()

    const { env } = buildChildEnv(spec)
    this.#query = query({
      prompt: this.#input,
      options: this.#options(spec, env, resumeRef),
    })

    this.#openingTurn = newTurnId()
    this.#inflight.push(this.#openingTurn)
    this.#pump = this.#run()
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Wait for `init`, check the session came up as asked, and hand back the handle.
   *
   * A launch that does not match the spec is a failure, not a warning: it rejects
   * with `config_mismatch` / `permission_mode_mismatch` so the supervisor can
   * stop and restart it (§13). `Provider.start()` does the stopping.
   */
  async start(turn: Turn): Promise<ClaudeSession> {
    this.#emit({ type: 'turn.started', turnId: this.#openingTurn, at: this.#now() })
    // The CLI says nothing until the first user message, so the brief goes now.
    this.#input.push(turn.text)

    const init = await this.#whenStarted()
    this.#state = 'idle'

    if (init.model !== this.#requestedModel) {
      throw this.#mismatch('model', this.#requestedModel, init.model)
    }
    if (init.permissionMode !== this.#spec.permissionMode) {
      throw fleetError(
        'permission_mode_mismatch',
        `asked for permissionMode ${this.#spec.permissionMode}, the session came up in ${init.permissionMode}`,
        {
          details: {
            sessionId: this.sessionId,
            peerId: this.peerId,
            expected: this.#spec.permissionMode,
            observed: init.permissionMode,
          },
        },
      )
    }
    return this
  }

  async send(turn: Turn): Promise<TurnId> {
    this.#assertLive()
    const turnId = newTurnId()
    this.#inflight.push(turnId)
    this.#turnState = { ...this.#turnState, interrupted: false }
    this.#state = 'working'
    this.#emit({ type: 'turn.started', turnId, at: this.#now() })
    this.#input.push(turn.text)
    return turnId
  }

  async interrupt(turn?: TurnId): Promise<void> {
    this.#assertLive()
    // Recorded before the call: the abort arrives as an ordinary `result`, and the
    // only thing that distinguishes it from a failure is that we knew it was coming.
    this.#turnState = { ...this.#turnState, interrupted: true }
    for (const abandoned of this.#pending.abandon('interrupted', turn).questions) {
      this.#emit({ type: 'question.abandoned', questionId: abandoned.questionId })
    }
    try {
      await this.#query.interrupt()
    } catch (thrown) {
      this.#turnState = { ...this.#turnState, interrupted: false }
      throw fleetError('provider_failed', `interrupt failed: ${describe(thrown)}`, { cause: thrown })
    }
  }

  async stop(): Promise<void> {
    if (this.#state === 'ended') return
    this.#state = 'ended'
    const { questions } = this.#pending.abandon('ended')
    for (const abandoned of questions) {
      this.#emit({ type: 'question.abandoned', questionId: abandoned.questionId })
    }
    this.#emit({ type: 'session.ended', reason: 'stopped' })
    this.#input.end()
    try {
      this.#query.close()
    } finally {
      this.#events.close()
    }
  }

  // ------------------------------------------------------------ read-only

  get sessionRef(): ProviderSessionRef {
    if (this.#sessionRef === undefined) {
      throw fleetError('provider_failed', `session ${this.sessionId} has no ref: it never reached init`)
    }
    return this.#sessionRef
  }

  /**
   * The model the session is actually on: the latest `init`'s, falling back to
   * what was asked for. After `setModel()` the previous observation is dropped,
   * so this reports the new model rather than the one the session has left; the
   * next turn's `init` confirms it.
   */
  get model(): string {
    return this.#observedModel ?? this.#requestedModel
  }

  get permissionMode(): string {
    return this.#observedMode ?? this.#spec.permissionMode
  }

  /** The endpoint the spec recorded, when it recorded one (§4, §13). Never inferred. */
  get endpoint(): string | undefined {
    return recordedEndpoint(this.#spec.env)
  }

  /**
   * The turn the brief was delivered as — the first turn, which exists only to
   * make the CLI speak (`start()`). `SessionHandle.briefTurnId` carries this.
   */
  get briefTurnId(): TurnId {
    return this.#openingTurn
  }

  status(): PeerState {
    if (this.#pending.blocked && isLive(this.#state)) return 'waiting_input'
    return this.#state
  }

  async usage(): Promise<Usage> {
    const answer = await this.#contextUsage()
    const cost = this.#config.usageCost ? this.#lastCostUsd : undefined
    return usageFrom({
      answer,
      ...(this.#lastContextTokens === undefined ? {} : { fallbackTokens: this.#lastContextTokens }),
      model: this.model,
      limits: this.#config.limits,
      ...(cost === undefined ? {} : { costUsd: cost }),
    })
  }

  /** The ids `answer()` and `respond()` accept; empty unless the peer is blocked. */
  pending(): ReturnType<PendingRequests['snapshot']> {
    return this.#pending.snapshot()
  }

  /**
   * Answering unblocks the turn that asked; it does not start a new one. The id
   * is the one its `question.asked` carried, so a stale answer is `not_found`
   * rather than an answer to somebody else's question.
   */
  answer(questionId: QuestionId, answer: QuestionAnswer): void {
    this.#pending.answer(questionId, answer)
  }

  respond(requestId: string, decision: ApprovalDecision): void {
    this.#pending.respond(requestId, decision)
  }

  /**
   * Change the model on a live session (`capabilities.modelSwitch`). The new
   * model becomes the requested one, so the next `init` echo is checked against
   * it — a switch the CLI ignores surfaces as `config_mismatch`, not silence.
   *
   * The confirmation arrives with the **next turn's** first message, not when
   * this resolves: the control call does not echo synchronously, and a throwaway
   * turn to force one would cost tokens. So a switch on a session that never
   * sends again is unconfirmed — the supervisor holds it as pending, not failed.
   */
  async setModel(model: string): Promise<void> {
    this.#assertLive()
    this.#requestedModel = model
    // What the session was on is no longer what it is on; stop reporting it.
    this.#observedModel = undefined
    try {
      await this.#query.setModel(model)
    } catch (thrown) {
      throw fleetError('provider_failed', `setModel(${model}) failed: ${describe(thrown)}`, { cause: thrown })
    }
  }

  async setPermissionMode(mode: SessionSpec['permissionMode']): Promise<void> {
    this.#assertLive()
    try {
      await this.#query.setPermissionMode(mode)
    } catch (thrown) {
      throw fleetError('provider_failed', `setPermissionMode(${mode}) failed: ${describe(thrown)}`, { cause: thrown })
    }
  }

  /**
   * The contract's event stream: question ids, approvals, the turn's end
   * reason, and the synthesised `session.ended`. The two internal events the
   * contract has no member for yet — `session.started` and `tool.denied` — are
   * filtered out here and stay inside the adapter (§4).
   */
  events(): AsyncIterable<ProviderEvent> {
    return this.#events.filter(isContractEvent)
  }

  // ---------------------------------------------------------------- internals

  #options(spec: SessionSpec, env: Readonly<Record<string, string>>, resumeRef: ProviderSessionRef | undefined): Options {
    const options: Options = {
      cwd: spec.cwd,
      env: { ...env },
      model: spec.model,
      permissionMode: spec.permissionMode,
      settingSources: [...this.#config.settingSources],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(spec.systemPromptAppend === undefined ? {} : { append: spec.systemPromptAppend }),
      },
      canUseTool: (toolName, input, canUseOptions) =>
        this.#canUseTool(toolName, input, canUseOptions as CanUseOptions),
      // Without this the SDK refuses a spec that asks for bypassPermissions.
      ...(spec.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(spec.effort === undefined ? {} : { effort: spec.effort }),
      ...(spec.mcp === undefined ? {} : { mcpServers: mcpServersOf(spec) }),
      // `resume` is the vendor's session id; the SDK loads that history and
      // hands out the same id again, which is what makes `resume()` idempotent (§7).
      ...(resumeRef === undefined ? {} : { resume: resumeRef }),
    }
    return options
  }

  async #run(): Promise<void> {
    try {
      for await (const message of this.#query) this.#onMessage(message)
      this.#finish('exit', undefined)
    } catch (thrown) {
      this.#finish('crash', describe(thrown))
    }
  }

  #onMessage(message: unknown): void {
    const record = message as { type?: unknown; subtype?: unknown; session_id?: unknown }
    this.#lastContextTokens = fallbackTokensFrom((record as { usage?: unknown }).usage) ?? this.#lastContextTokens
    if (record.type === 'result') {
      const cost = (record as { total_cost_usd?: unknown }).total_cost_usd
      if (typeof cost === 'number') this.#lastCostUsd = cost
    }

    const turnId = this.#inflight[0]
    for (const event of mapMessage(message, turnId, this.#turnState, this.#now())) {
      if (event.type === 'session.started') {
        const first = this.#sessionRef === undefined
        this.#sessionRef ??= event.sessionRef
        this.#observedModel = event.model
        this.#observedMode = event.permissionMode
        this.#started.resolve({ model: event.model, permissionMode: event.permissionMode })
        // The launch `init` describes how the session came up; later ones are
        // just this turn's echo and must not re-trigger the launch check. They
        // are where a model switch is confirmed, though, so an echo that still
        // reports the old model is a mismatch — reported as an event, since
        // `start()` has long since handed the session back.
        if (!first && event.model !== this.#requestedModel) {
          this.#reportMismatch('model', this.#requestedModel, event.model)
        }
        continue
      }
      if (event.type === 'turn.ended') {
        this.#inflight = this.#inflight.filter((id) => id !== event.turnId)
        this.#turnState = { interrupted: false }
        this.#state = this.#inflight.length > 0 ? 'working' : 'idle'
      }
      this.#emit(event)
    }
  }

  #canUseTool(toolName: string, input: Record<string, unknown>, options: CanUseOptions): Promise<PermissionResult> {
    const turnId = this.#inflight[0]
    if (turnId === undefined) {
      return Promise.resolve({ behavior: 'deny', message: 'no turn is open for this tool call' })
    }

    const aborted = new Promise<'aborted'>((resolve) => {
      if (options.signal.aborted) resolve('aborted')
      else options.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    })

    if (toolName === QUESTION_TOOL) {
      const questions = readQuestions(input) ?? [{ question: 'The peer asked a question it did not spell out.' }]
      const { open, wait } = this.#pending.ask(turnId, questions)
      this.#state = 'waiting_input'
      this.#emit({ type: 'question.asked', turnId, questionId: open.questionId, questions: open.questions })
      return Promise.race([wait, aborted]).then((answer) => {
        if (answer === 'aborted') return { behavior: 'deny', message: 'the turn was interrupted' } as PermissionResult
        this.#state = 'working'
        return { behavior: 'allow', updatedInput: { ...input, ...answersFor(questions, answer) } }
      })
    }

    // The session's own policy decides first; `ask` is the path every call took
    // before policies existed, so the default changes nothing (§4).
    const action = evaluatePolicy(this.#policy, toolName, input)
    if (action === 'allow') {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    if (action === 'deny') {
      const summary = summarise(input)
      this.#emit({
        type: 'tool.denied',
        turnId,
        tool: toolName,
        ...(summary === undefined ? {} : { summary }),
      })
      // The message reaches the model, so it can change course instead of
      // retrying into the same wall.
      return Promise.resolve({
        behavior: 'deny',
        message: `the session's tool policy denies ${toolName}; choose another approach or ask the supervisor`,
      })
    }

    const summary = summarise(input)
    const { open, wait } = this.#pending.askApproval(turnId, toolName, summary)
    this.#state = 'waiting_input'
    this.#emit({
      type: 'approval.requested',
      turnId,
      requestId: open.requestId,
      tool: toolName,
      ...(summary === undefined ? {} : { summary }),
    })
    return Promise.race([wait, aborted]).then((decision) => {
      if (decision === 'aborted') return { behavior: 'deny', message: 'the turn was interrupted' } as PermissionResult
      this.#state = 'working'
      return decision === 'allow'
        ? ({ behavior: 'allow', updatedInput: input } as PermissionResult)
        : ({ behavior: 'deny', message: 'the supervisor denied this tool call' } as PermissionResult)
    })
  }

  async #whenStarted(): Promise<{ model: string; permissionMode: string }> {
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), this.#config.initTimeoutMs).unref(),
    )
    const first = await Promise.race([this.#started.promise, timeout])
    if (first === 'timeout') {
      throw fleetError('timeout', `session ${this.sessionId} did not initialise in ${this.#config.initTimeoutMs}ms`)
    }
    return first
  }

  async #contextUsage(): Promise<{ totalTokens?: number } | undefined> {
    if (!isLive(this.#state)) return undefined
    try {
      const answer = await this.#query.getContextUsage({ detail: this.#config.contextDetail })
      const total = (answer as { totalTokens?: unknown }).totalTokens
      return typeof total === 'number' ? { totalTokens: total } : undefined
    } catch {
      // The control call needs a live CLI; a session that just exited has no
      // measurement, and the caller's fallback is the last one we saw.
      return undefined
    }
  }

  /**
   * The endpoint and model the session was asked for, against what it reported.
   * At launch this rejects (§13); after launch — a model switch that did not take
   * — it is an event, because `start()` has already handed the session back.
   */
  #mismatch(what: 'model' | 'endpoint', expected: string, observed: string): FleetError {
    return fleetError('config_mismatch', `asked for ${what} ${expected}, the session is running ${observed}`, {
      details: { sessionId: this.sessionId, peerId: this.peerId, what, expected, observed },
    })
  }

  #reportMismatch(what: 'model' | 'endpoint', expected: string, observed: string): void {
    this.#emit({ type: 'error', message: this.#mismatch(what, expected, observed).message, retryable: false })
  }

  /**
   * The session stream ended on its own: the iterator finished (`exit`) or threw
   * (`crash`). A stopped session never reaches here — `stop()` has already set
   * the state and closed the stream. The failure message travels as an `error`
   * event, because `session.ended` only names why the stream ended (§4).
   */
  #finish(reason: 'exit' | 'crash', error: string | undefined): void {
    if (this.#state === 'ended') return
    this.#state = reason === 'crash' ? 'failed' : 'ended'
    const { questions } = this.#pending.abandon('ended')
    for (const abandoned of questions) {
      this.#emit({ type: 'question.abandoned', questionId: abandoned.questionId })
    }
    if (error !== undefined) this.#emit({ type: 'error', message: error, retryable: reason === 'crash' })
    this.#emit({ type: 'session.ended', reason })
    this.#events.close()
  }

  #assertLive(): void {
    if (!isLive(this.#state)) {
      throw fleetError('provider_failed', `session ${this.sessionId} is ${this.#state}`)
    }
  }

  #emit(event: AdapterEvent): void {
    this.#events.push(event)
  }

  #now(): Timestamp {
    return this.#config.clock.now()
  }
}

interface CanUseOptions {
  readonly signal: AbortSignal
  readonly suggestions?: unknown
  readonly toolUseID?: string
  readonly title?: string
  readonly displayName?: string
}

const mcpServersOf = (spec: SessionSpec): NonNullable<Options['mcpServers']> => {
  const servers: NonNullable<Options['mcpServers']> = {}
  for (const server of spec.mcp ?? []) {
    servers[server.id] = {
      type: 'stdio',
      command: server.command,
      ...(server.args === undefined ? {} : { args: [...server.args] }),
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
    }
  }
  return servers
}

/** A short, already-redacted description of a blocked tool call (§4). */
const summarise = (input: Record<string, unknown>): string | undefined => {
  const value = input.command ?? input.file_path ?? input.url ?? input.query
  return typeof value === 'string' && value.length > 0 ? (value.length > 200 ? `${value.slice(0, 199)}…` : value) : undefined
}

const answersFor = (
  questions: readonly { readonly question: string }[],
  answer: readonly string[],
): { answers: Record<string, string> } => ({ answers: questionAnswers(questions, answer) })

const describe = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown))

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** The streaming-input queue: `send()` pushes, `stop()` ends, the CLI pulls. */
type UserMessage = { type: 'user'; message: { role: 'user'; content: string }; parent_tool_use_id: null }

class InputQueue implements AsyncIterable<UserMessage> {
  readonly #pending: UserMessage[] = []
  #wake: ((result: IteratorResult<UserMessage>) => void) | undefined
  #ended = false

  push(text: string): void {
    const message: UserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
    const wake = this.#wake
    if (wake !== undefined) {
      this.#wake = undefined
      wake({ value: message, done: false })
    } else {
      this.#pending.push(message)
    }
  }

  end(): void {
    this.#ended = true
    const wake = this.#wake
    this.#wake = undefined
    wake?.({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<UserMessage> {
    return {
      next: (): Promise<IteratorResult<UserMessage>> => {
        const queued = this.#pending.shift()
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
        if (this.#ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.#wake = resolve
        })
      },
      return: (): Promise<IteratorResult<UserMessage>> => {
        this.#ended = true
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

/** An unbounded queue of events with one consumer; closed when the session ends. */
class EventQueue implements AsyncIterable<AdapterEvent> {
  readonly #queued: AdapterEvent[] = []
  #wake: (() => void) | undefined
  #closed = false

  push(event: AdapterEvent): void {
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

  async *[Symbol.asyncIterator](): AsyncGenerator<AdapterEvent> {
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

  /** The same queue, narrowed to the events `keep` admits — the contract's view (§4). */
  async *filter<T extends AdapterEvent>(keep: (event: AdapterEvent) => event is T): AsyncGenerator<T> {
    for await (const event of this) {
      if (keep(event)) yield event
    }
  }
}
