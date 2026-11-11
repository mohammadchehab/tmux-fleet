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

import { randomUUID } from 'node:crypto'

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
import { providerModels } from '@fleet/foundation-contracts'
import { DisplayQueue, displayLineOf } from '@fleet/runtime-provider-sdk'
import type {
  ApprovalDecision,
  DisplayLine,
  ProviderEvent,
  ProviderSessionRef,
  QuestionAnswer,
  SessionSpec,
  Turn,
  TurnSpend,
  Usage,
} from '@fleet/runtime-provider-sdk'

import { buildChildEnv, recordedEndpoint } from './env.ts'
import { isContractEvent, type AdapterEvent, type TurnEndReason } from './events.ts'
import { mapMessage, questionAnswers, readQuestions, summariseToolUse, type TurnState } from './messages.ts'
import { PendingRequests } from './pending.ts'
import { compilePolicy, evaluatePolicy, QUESTION_TOOL, type CompiledToolPolicy } from './policy.ts'
import {
  fallbackTokensFrom,
  noSpend,
  spendFrom,
  usageFrom,
  type ContextLimits,
  type ContextUsageAnswer,
  type SpendTotals,
} from './usage.ts'

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
  /**
   * The fallback for a CLI that does not name the turns a `result` consumed
   * (`user_message_uuids` absent). The CLI runs a message queued behind a running
   * turn *inside* that turn and answers both with one `result`; a current CLI
   * says which messages it consumed and nothing is guessed. Only when it says
   * nothing, and also reports no queued send (`queued_turn_count` 0), are the
   * turns still in flight called folded after this much silence.
   */
  readonly foldQuietMs: number
  readonly clock: Clock
  /**
   * The SDK entry point, `query` itself unless a test sets another. A session
   * that dies before `init` — an expired OAuth token is the one that cost an
   * hour — is only observable by driving the stream, and no CLI is needed to
   * say what this adapter does with one.
   */
  readonly query?: QueryFactory
}

/** What a session starts: the SDK's `query`, with the one parameter the adapter passes. */
export type QueryFactory = (params: Parameters<typeof query>[0]) => Query

export const defaultSessionConfig: ClaudeSessionConfig = {
  providerId: 'claude',
  limits: { byModel: {}, fallback: 200_000 },
  contextDetail: 'full',
  usageCost: true,
  settingSources: [],
  initTimeoutMs: 60_000,
  foldQuietMs: 2_000,
  clock: systemClock,
}

/**
 * The text a `stream_event` carries, when it carries any (§6): a top-level
 * `text_delta`. Thinking deltas are dropped, and so is everything a subagent says —
 * the view shows what the peer said and did.
 */
export const textDeltaOf = (message: unknown): string | undefined => {
  if (typeof message !== 'object' || message === null) return undefined
  const record = message as { type?: unknown; parent_tool_use_id?: unknown; event?: unknown }
  if (record.type !== 'stream_event' || (record.parent_tool_use_id !== undefined && record.parent_tool_use_id !== null)) return undefined
  const event = record.event as { type?: unknown; delta?: { type?: unknown; text?: unknown } } | undefined
  if (event?.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') return undefined
  return typeof event.delta.text === 'string' && event.delta.text.length > 0 ? event.delta.text : undefined
}

/**
 * The tools that reach another Claude Code session on this machine
 * (`SendMessage`, and `ListAgents` to find one). A peer talks to the fleet only
 * through its mailbox: found live, a headless peer introduced itself to the
 * operator's own session over the local peer socket and reported to it. Denied
 * outright, in every permission mode.
 */
export const crossSessionTools: readonly string[] = Object.freeze(['SendMessage', 'ListAgents'])

/**
 * The system prompt a session asks the SDK for: Claude Code's own, plus whatever
 * the spec appends. That is where a peer's standards ride (§12.1) — with
 * `settingSources: []` it reads no `AGENTS.md` or `CLAUDE.md` itself, so this is
 * the only way its repo's rules reach it.
 */
export const systemPromptOf = (
  spec: Pick<SessionSpec, 'systemPromptAppend'>,
): { readonly type: 'preset'; readonly preset: 'claude_code'; readonly append?: string } => ({
  type: 'preset',
  preset: 'claude_code',
  ...(spec.systemPromptAppend === undefined ? {} : { append: spec.systemPromptAppend }),
})

/**
 * What to add to a model mismatch, when the id asked for is one this repo does
 * not know.
 *
 * The usual cause is a name typed from memory — `sonnet` is how people say it,
 * not an id the CLI accepts — and the launch is the only moment the real ids
 * are worth printing: the session has not started, so the person is still
 * looking at their profile. A known id gets no hint, because a mismatch then is
 * a different problem and the list would be noise.
 */
export const modelHint = (expected: string): string =>
  providerModels.claude.includes(expected)
    ? ''
    : `; the claude ids this repo knows are ${providerModels.claude.join(', ')}`

/** A session as its provider sees it: identity is a snapshot, state is live. */
export class ClaudeSession {
  readonly sessionId: SessionId
  readonly peerId: string
  readonly providerId: string

  readonly #spec: SessionSpec
  readonly #config: ClaudeSessionConfig
  readonly #input: InputQueue
  readonly #events = new EventQueue()
  readonly #display = new DisplayQueue()
  readonly #pending: PendingRequests
  /** Compiled at construction: an invalid pattern is a start failure, not a mid-turn one (§4). */
  readonly #policy: CompiledToolPolicy
  readonly #openingTurn: TurnId
  readonly #started = deferred<{ model: string; permissionMode: string }>()
  /**
   * Resolved when the stream ends, whichever way it did. `start()` races it
   * against `init`: a session that dies first has already said why, and waiting
   * out `initTimeoutMs` reported a timeout for a cause the provider had named.
   */
  readonly #ended = deferred<void>()
  readonly #query: Query

  /**
   * The last thing the provider said went wrong, in its own words (`§4`'s
   * `error` event or a failed turn's `error`). Carried into a start failure so
   * `peer.failed` reads "OAuth token has expired" and not "did not initialise".
   */
  #lastError: string | undefined

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
  /** The uuid each in-flight turn's user message carries, so a `result` can name the turns it consumed (TASK-103). */
  readonly #uuids = new Map<TurnId, Uuid>()
  #turnState: TurnState = { interrupted: false }
  #lastContextTokens: number | undefined
  #lastCostUsd: number | undefined
  /**
   * The running totals the boundary message reports, carried from one `result`
   * to the next: `modelUsage` and `total_cost_usd` are cumulative over the whole
   * query, so the turn's own spend is the difference. Kept separate from
   * `#lastCostUsd`, which is what `usage()` reports and stays cumulative.
   */
  #reported: SpendTotals = noSpend
  #spent: TurnSpend | undefined
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
    const start = config.query ?? query
    this.#query = start({
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
    this.#input.push(turn.text, this.#mint(this.#openingTurn))

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
    // A send is a turn in flight: a fallback timer armed for the turns before it must not end it.
    this.#disarmFold()
    const turnId = newTurnId()
    this.#inflight.push(turnId)
    this.#turnState = { ...this.#turnState, interrupted: false }
    this.#state = 'working'
    this.#emit({ type: 'turn.started', turnId, at: this.#now() })
    this.#input.push(turn.text, this.#mint(turnId))
    return turnId
  }

  async interrupt(turn?: TurnId): Promise<void> {
    this.#assertLive()
    // Recorded before the call: the abort arrives as an ordinary `result`, and the
    // only thing that distinguishes it from a failure is that we knew it was coming.
    this.#turnState = { ...this.#turnState, interrupted: true }
    const interrupted = this.#pending.abandon('interrupted', turn)
    for (const abandoned of interrupted.questions) {
      this.#emit({ type: 'question.abandoned', questionId: abandoned.questionId })
    }
    for (const abandoned of interrupted.approvals) {
      this.#emit({ type: 'approval.abandoned', requestId: abandoned.requestId })
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
    this.#disarmFold()
    this.#state = 'ended'
    const { questions, approvals } = this.#pending.abandon('ended')
    for (const abandoned of questions) {
      this.#emit({ type: 'question.abandoned', questionId: abandoned.questionId })
    }
    for (const abandoned of approvals) {
      this.#emit({ type: 'approval.abandoned', requestId: abandoned.requestId })
    }
    this.#emit({ type: 'session.ended', reason: 'stopped' })
    this.#input.end()
    try {
      this.#query.close()
    } finally {
      this.#events.close()
      this.#display.close()
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

  /**
   * The turn that just ended, measured at its boundary message (§6.2).
   *
   * Synchronous on purpose: the numbers arrived on the stream, so this answers
   * without a control call — including for a session whose CLI has already
   * exited, where `usage()`'s control call has nothing to ask.
   */
  turnSpend(): TurnSpend | undefined {
    return this.#spent
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
   * What the peer says and does, for `fleet watch` (watch-and-attach §6): text from
   * the partial-message deltas, a line per tool use, a `turn` line per boundary.
   * Thinking is left out. Display data only — the contract events are unchanged.
   */
  display(): AsyncIterable<DisplayLine> {
    return this.#display
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
      systemPrompt: systemPromptOf(spec),
      // Removed from the model's context, so it holds in every permission mode —
      // `bypassPermissions` never consults `canUseTool`.
      disallowedTools: [...crossSessionTools],
      // Adds `stream_event` messages carrying text deltas for the display feed and
      // changes nothing else: `assistant`, `result` and `init` arrive as before.
      includePartialMessages: true,
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

  #mint(turnId: TurnId): Uuid {
    const uuid = randomUUID()
    this.#uuids.set(turnId, uuid)
    return uuid
  }

  /**
   * The in-flight turns this `result` consumed, by the uuids the CLI echoes in
   * `user_message_uuids` — the message that started the turn and any queued one
   * it folded in between tool rounds (TASK-103). Empty when the CLI names none,
   * which leaves the caller on the first-in-first-out answer it always had.
   */
  #consumedBy(message: unknown): TurnId[] {
    const named = (message as { user_message_uuids?: unknown }).user_message_uuids
    if (!Array.isArray(named)) return []
    return this.#inflight.filter((id) => {
      const uuid = this.#uuids.get(id)
      return uuid !== undefined && named.includes(uuid)
    })
  }

  /** Armed only for a `result` that names no consumed message and reports no queued send; see `foldQuietMs`. */
  #foldTimer: ReturnType<typeof setTimeout> | undefined

  #disarmFold(): void {
    if (this.#foldTimer !== undefined) clearTimeout(this.#foldTimer)
    this.#foldTimer = undefined
  }

  /**
   * The ids are the ones in flight *now*, snapshotted: a turn sent after this
   * arms is its own, and `send()` disarms besides. The turns end the way the
   * result that left them did — an error or an interrupt is not 'completed'.
   */
  #armFold(reason: TurnEndReason, error: string | undefined): void {
    this.#disarmFold()
    const folded = [...this.#inflight]
    if (folded.length === 0) return
    this.#foldTimer = setTimeout(() => {
      this.#foldTimer = undefined
      if (!isLive(this.#state)) return
      const ended = folded.filter((id) => this.#inflight.includes(id))
      this.#inflight = this.#inflight.filter((id) => !ended.includes(id))
      this.#turnState = { interrupted: false }
      this.#state = this.#inflight.length > 0 ? 'working' : 'idle'
      for (const turnId of ended) {
        this.#uuids.delete(turnId)
        this.#emit({ type: 'turn.ended', turnId, at: this.#now(), reason, ...(error === undefined ? {} : { error }) })
      }
    }, this.#config.foldQuietMs)
    this.#foldTimer.unref()
  }

  #onMessage(message: unknown): void {
    this.#disarmFold()
    const record = message as { type?: unknown; subtype?: unknown; session_id?: unknown }
    this.#lastContextTokens = fallbackTokensFrom((record as { usage?: unknown }).usage) ?? this.#lastContextTokens
    if (record.type === 'result') {
      const cost = (record as { total_cost_usd?: unknown }).total_cost_usd
      if (typeof cost === 'number') this.#lastCostUsd = cost
      // The boundary is where a turn's spend becomes knowable: the counters are
      // cumulative over the query, so the turn's own is the difference from the
      // previous boundary (subagents and sidechains included — §6.2).
      const measured = spendFrom(record, this.#reported)
      this.#reported = measured.totals
      this.#spent = measured.spend
    }

    const delta = textDeltaOf(message)
    if (delta !== undefined) this.#display.push({ kind: 'text', text: delta })

    const consumed = record.type === 'result' ? this.#consumedBy(message) : []
    const turnId = consumed[0] ?? this.#inflight[0]
    let resultEnd: { reason: TurnEndReason; error: string | undefined } | undefined
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
        if (event.reason === 'failed' && event.error !== undefined) this.#lastError = event.error
        const ending = new Set([event.turnId, ...consumed])
        this.#inflight = this.#inflight.filter((id) => !ending.has(id))
        for (const id of ending) this.#uuids.delete(id)
        this.#turnState = { interrupted: false }
        this.#state = this.#inflight.length > 0 ? 'working' : 'idle'
        resultEnd = { reason: event.reason, error: event.error }
        this.#emit(event)
        // The other turns this result consumed end the way it did.
        for (const id of consumed) {
          if (id !== event.turnId) this.#emit({ ...event, turnId: id })
        }
        continue
      }
      if (event.type === 'error') this.#lastError = event.message
      this.#emit(event)
    }
    // A CLI that names nothing and queues nothing has no result still to come for what is left (see `foldQuietMs`).
    const unnamed = !Array.isArray((message as { user_message_uuids?: unknown }).user_message_uuids)
    if (resultEnd !== undefined && unnamed && (message as { queued_turn_count?: unknown }).queued_turn_count === 0) {
      this.#armFold(resultEnd.reason, resultEnd.error)
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
      const summary = summariseToolUse(toolName, input)
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

    // The same default-deny summary as `peer.tool_used` (§4): an approval is
    // stored like any other event, so a command, a URL or a brief cannot ride
    // along in it. What the call would do is the model's to explain, not the
    // log's to keep.
    const summary = summariseToolUse(toolName, input)
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
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.#config.initTimeoutMs)
      timer.unref()
    })
    // The stream ending before `init` is the provider saying no: an expired
    // OAuth token ends the query rather than answering, and the cause is in its
    // last error. Racing the timeout meant `peer.failed` carried the 60 s we
    // waited and not the sentence a person needed.
    const ended = this.#ended.promise.then((): 'ended' => 'ended')
    const first = await Promise.race([this.#started.promise, timeout, ended]).finally(() => clearTimeout(timer))
    if (first === 'timeout') {
      throw fleetError('timeout', `session ${this.sessionId} did not initialise in ${this.#config.initTimeoutMs}ms`)
    }
    if (first === 'ended') {
      throw fleetError(
        'provider_failed',
        `session ${this.sessionId} ended before it initialised${this.#lastError === undefined ? '' : `: ${this.#lastError}`}`,
        {
          details: {
            sessionId: this.sessionId,
            peerId: this.peerId,
            ...(this.#lastError === undefined ? {} : { providerError: this.#lastError }),
          },
        },
      )
    }
    return first
  }

  async #contextUsage(): Promise<ContextUsageAnswer | undefined> {
    if (!isLive(this.#state)) return undefined
    try {
      const answer = await this.#query.getContextUsage({ detail: this.#config.contextDetail })
      const record = answer as {
        totalTokens?: unknown
        rawMaxTokens?: unknown
        autoCompactThreshold?: unknown
        isAutoCompactEnabled?: unknown
        categories?: readonly { id?: unknown; tokens?: unknown }[]
      }
      const total = typeof record.totalTokens === 'number' ? record.totalTokens : undefined
      const window = typeof record.rawMaxTokens === 'number' ? record.rawMaxTokens : undefined
      const threshold = typeof record.autoCompactThreshold === 'number' ? record.autoCompactThreshold : undefined
      const categories = Array.isArray(record.categories)
        ? record.categories.map((row) => ({
            ...(typeof row?.id === 'string' ? { id: row.id } : {}),
            ...(typeof row?.tokens === 'number' ? { tokens: row.tokens } : {}),
          }))
        : undefined
      return {
        ...(total === undefined ? {} : { totalTokens: total }),
        ...(window === undefined ? {} : { rawMaxTokens: window }),
        ...(threshold === undefined ? {} : { autoCompactThreshold: threshold }),
        ...(typeof record.isAutoCompactEnabled === 'boolean'
          ? { autoCompactEnabled: record.isAutoCompactEnabled }
          : {}),
        ...(categories === undefined ? {} : { categories }),
      }
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
   *
   * A model mismatch names the ids this repo knows, because the usual cause is a
   * name typed from memory: `sonnet` is not an id, and the error is the only
   * place the real ones appear before a session starts.
   */
  #mismatch(what: 'model' | 'endpoint', expected: string, observed: string): FleetError {
    const hint = what === 'model' ? modelHint(expected) : ''
    return fleetError('config_mismatch', `asked for ${what} ${expected}, the session is running ${observed}${hint}`, {
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
    this.#disarmFold()
    this.#state = reason === 'crash' ? 'failed' : 'ended'
    if (error !== undefined) this.#lastError = error
    // Before the events close: `start()` may be waiting on this to read the
    // provider's own words for why the session never came up.
    this.#ended.resolve()
    const { questions, approvals } = this.#pending.abandon('ended')
    for (const abandoned of questions) {
      this.#emit({ type: 'question.abandoned', questionId: abandoned.questionId })
    }
    for (const abandoned of approvals) {
      this.#emit({ type: 'approval.abandoned', requestId: abandoned.requestId })
    }
    if (error !== undefined) this.#emit({ type: 'error', message: error, retryable: reason === 'crash' })
    this.#emit({ type: 'session.ended', reason })
    this.#events.close()
    this.#display.close()
  }

  #assertLive(): void {
    if (!isLive(this.#state)) {
      throw fleetError('provider_failed', `session ${this.sessionId} is ${this.#state}`)
    }
  }

  #emit(event: AdapterEvent): void {
    this.#events.push(event)
    const line = displayLineOf(event)
    if (line !== undefined) this.#display.push(line)
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

/** What the SDK types a message uuid as. */
type Uuid = ReturnType<typeof randomUUID>

/** The streaming-input queue: `send()` pushes, `stop()` ends, the CLI pulls. */
type UserMessage = { type: 'user'; uuid: Uuid; message: { role: 'user'; content: string }; parent_tool_use_id: null }

class InputQueue implements AsyncIterable<UserMessage> {
  readonly #pending: UserMessage[] = []
  #wake: ((result: IteratorResult<UserMessage>) => void) | undefined
  #ended = false

  push(text: string, uuid: Uuid): void {
    const message: UserMessage = { type: 'user', uuid, message: { role: 'user', content: text }, parent_tool_use_id: null }
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
