/**
 * The types exchanged with a provider, and the vocabulary the session wrapper
 * speaks (architecture §4, §8). `@fleet/runtime-provider-sdk` declares the
 * `Provider` interface over these; defining them here keeps `foundation`
 * dependency-free and lets the supervisor, the PM and the store share one
 * shape without importing a vendor package.
 *
 * There is deliberately no method that returns text meant to be parsed (§4):
 * every provider signal below is a typed event.
 */

import { array, boolean, count, literal, number, object, objectAs, oneOf, optional, positiveInt, record, refine, string, text, union, unionAs, type Schema } from '@fleet/foundation-core'
import {
  briefId,
  contractId,
  peerId,
  providerSessionRef,
  questionId,
  turnId,
  type BriefId,
  type ContractId,
  type PeerId,
  type ProviderSessionRef,
  type QuestionId,
  type SessionId,
  type TurnId,
  type WorkId,
} from '@fleet/foundation-core'
import type { PeerState } from '@fleet/foundation-core'

/** The providers a profile can name today (§4). A profile names one per peer. */
export const profileProviders = ['claude', 'deepinfra', 'cursor'] as const
export type ProfileProvider = (typeof profileProviders)[number]

/**
 * The model ids each provider is known to serve — a hint, never a gate.
 *
 * Nothing validates a profile's `model` against this: DeepInfra and proxied
 * endpoints serve ids this repo has never heard of, and a new model needs no
 * fleet commit to be usable. The list is what a mismatch error quotes back and
 * what `fleet init` writes into a starter profile, so a person who typed a
 * model name from memory sees the one they meant (§13).
 */
export const providerModels: Readonly<Record<ProfileProvider, readonly string[]>> = {
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1'],
  deepinfra: ['anthropic/claude-sonnet-5-5'],
  // A hint, and a shorter one than the CLI serves: `cursor-agent models` lists
  // them and changes without a fleet commit. `auto` is deliberately absent —
  // cursor resolves it itself, so a session started with it could not say what
  // model it runs and the adapter refuses it.
  cursor: ['composer-2.5', 'claude-4.5-sonnet', 'gpt-5.2'],
}

/** The permission modes a session can come up in. A provider declares a subset (§4). */
export const permissionModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const
export type PermissionMode = (typeof permissionModes)[number]
export const permissionMode = (): Schema<PermissionMode> => oneOf(permissionModes)

/** How much of a turn a provider can run without being trusted to behave. */
export const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof effortLevels)[number]
export const effort = (): Schema<Effort> => oneOf(effortLevels)

/**
 * What a provider can actually do (§4, §16). The supervisor adapts to this
 * instead of guessing: a provider without `usageTokens` purges by turn count
 * and wall clock (§8).
 */
export interface ProviderCapabilities {
  /** A stopped session can be resumed from its `ProviderSessionRef`. */
  readonly resume: boolean
  /** The model can be changed on a live session rather than by restarting it. */
  readonly modelSwitch: boolean
  /** `usage()` reports real context tokens, so the self-purge trigger is measurable. */
  readonly usageTokens: boolean
  /**
   * `usage()` reports a real `costUsd`. When false the spend ledger records
   * null rather than a number the vendor priced at someone else's rates (§4, §11).
   */
  readonly usageCost: boolean
  /** The provider can answer a `Judge`-style call against a schema. */
  readonly structuredOutput: boolean
  /**
   * `SessionSpec.effort` reaches the model as a reasoning level. When false the
   * spec's effort is a request the provider cannot honour, so `fleet up` says so
   * rather than starting a session whose effort is quietly not what the profile
   * asked for (TASK-12).
   */
  readonly effort: boolean
  /** The permission modes this provider honours; `SessionSpec.permissionMode` must be one. */
  readonly permissionModes: readonly PermissionMode[]
}

export const providerCapabilities = (): Schema<ProviderCapabilities> =>
  objectAs<ProviderCapabilities>()({
    resume: boolean(),
    modelSwitch: boolean(),
    effort: boolean(),
    usageTokens: boolean(),
    usageCost: boolean(),
    structuredOutput: boolean(),
    permissionModes: array(permissionMode(), { maxItems: permissionModes.length }),
  })

/**
 * The part of a provider anything outside `runtime` may see: its id and what it
 * can do. `Provider` (in the SDK) extends this with the session methods, so a
 * registry can be typed in `contracts` without `contracts` importing `runtime`.
 */
export interface ProviderHandle {
  readonly id: string
  readonly capabilities: ProviderCapabilities
}

export const providerId = (): Schema<string> =>
  refine(string({ pattern: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/ }), (v) => v.length <= 40, 'a provider id')

// ------------------------------------------------------------------ sessions

/** An MCP server the session wrapper wires into a session (§6.2 codegraph). */
export interface McpServer {
  readonly id: string
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

export const mcpServer = (): Schema<McpServer> =>
  objectAs<McpServer>()({
    id: string({ minLength: 1, maxLength: 80 }),
    command: string({ minLength: 1 }),
    args: optional(array(string())),
    env: optional(record(string())),
  })

/** The brief a session starts from, resolved from the store at start (§7, §12). */
export interface BriefHandoff {
  readonly briefId: BriefId
  readonly version: number
  /** The contract versions the brief was written against; a newer contract supersedes it (§12). */
  readonly contractVersions: readonly { readonly contractId: ContractId; readonly version: number }[]
  readonly text: string
}

export const briefHandoff = (): Schema<BriefHandoff> =>
  objectAs<BriefHandoff>()({
    briefId: briefId(),
    version: positiveInt(),
    contractVersions: array(object({ contractId: contractId(), version: positiveInt() })),
    text: text(),
  })

/**
 * A peer's typed handoff across a purge (§8). It is the single thing carried
 * into the fresh session, together with the role and the re-resolved brief.
 */
export interface StateFile {
  readonly peerId: PeerId
  readonly goal: string
  readonly done: readonly string[]
  readonly inFlight: readonly string[]
  readonly next: readonly string[]
  readonly decisions: readonly string[]
  readonly openQuestions: readonly string[]
  readonly briefVersion: number
}

export const stateFile = (): Schema<StateFile> =>
  objectAs<StateFile>()({
    peerId: peerId(),
    goal: text(),
    done: array(text()),
    inFlight: array(text()),
    next: array(text()),
    decisions: array(text()),
    openQuestions: array(text()),
    briefVersion: positiveInt(),
  })

/** What a tool-policy rule does with a tool call (§4). */
export const toolActions = ['allow', 'ask', 'deny'] as const
export type ToolAction = (typeof toolActions)[number]

/**
 * One rule of a session's tool policy. `tool` is a tool name or `*`; `pattern`
 * is a JS RegExp source tested against the tool's primary string (Bash: the
 * command; Read/Write/Edit: the resolved path; any other tool: its input as
 * JSON). Without a pattern the rule matches every call of the tool.
 */
export interface ToolPolicyRule {
  readonly tool: string
  readonly pattern?: string
  readonly action: ToolAction
}

/**
 * Which tool calls a peer may make without asking (§4). Peers run in the
 * provider's `default` permission mode and this policy stands in for
 * `bypassPermissions`, which would shadow the approval path and leave the
 * decision inbox blind. Rules are evaluated in order and the first match wins;
 * no match means `defaultAction`. `AskUserQuestion` is never evaluated: a
 * question always reaches a human.
 *
 * Authoring rules the adapter enforces: an `allow` rule's pattern must cover the
 * whole subject (it is matched as `^(?:pattern)$`), so `^echo ` allows nothing
 * and `^echo .*$` is what to write; `ask` and `deny` patterns stay unanchored
 * searches, so a deny still matches inside a longer command. A Bash command
 * with a control construct (`;` `&` `|` backtick `$(` `<` `>` or a newline) is
 * never covered by an `allow` rule, and a subject over 64 KB is not examined at
 * all: both go to a person.
 *
 * This is a guard rail, not a sandbox. "No production" (fleet rule 2) is
 * enforced by what is in the peer's environment, never by a deny pattern.
 */
export interface ToolPolicy {
  readonly defaultAction: ToolAction
  readonly rules: readonly ToolPolicyRule[]
}

/** What a spec without a `toolPolicy` gets: everything asks. */
export const defaultToolPolicy: ToolPolicy = Object.freeze({
  defaultAction: 'ask',
  rules: Object.freeze([]),
})

export const toolPolicy = (): Schema<ToolPolicy> =>
  objectAs<ToolPolicy>()({
    defaultAction: oneOf(toolActions),
    rules: array(
      objectAs<ToolPolicyRule>()({
        tool: string({ minLength: 1, maxLength: 80 }),
        pattern: optional(string({ minLength: 1, maxLength: 500 })),
        action: oneOf(toolActions),
      }),
      { maxItems: 200 },
    ),
  })

/**
 * Everything a provider needs to start one session. Env and permission mode
 * are here, in the spec of *that one process*, which is what removes v1's
 * shared-tmux-server env drift and the wrong-mode session (§4, §13, §14.1).
 */
export interface SessionSpec {
  readonly peerId: PeerId
  /** The role name; the role's brief text is in `brief`, its policy in the profile. */
  readonly role: string
  readonly cwd: string
  readonly model: string
  readonly effort?: Effort
  readonly permissionMode: PermissionMode
  readonly env: Readonly<Record<string, string>>
  readonly brief: BriefHandoff
  /** Present on a purge resume: what the previous session knew (§8). */
  readonly stateFile?: StateFile
  readonly mcp?: readonly McpServer[]
  /** Where to resume from, when the supervisor restarts a dead session (§7). */
  readonly resumeRef?: ProviderSessionRef
  /** Appended to the provider's system prompt; the codegraph guard policy, for instance (§6.2). */
  readonly systemPromptAppend?: string
  /** Which tool calls run without asking; absent means `defaultToolPolicy` (§4). */
  readonly toolPolicy?: ToolPolicy
  /**
   * The first message of a resumed session, in place of the brief
   * (watch-and-attach §4). A release after a takeover, or a start after a stop,
   * carries a short handback note: re-sending the brief would cost a turn and
   * re-brief the peer over what the person just told it. A first message cannot
   * be dropped, because the Claude SDK's streaming input needs one.
   */
  readonly opening?: string
}

/**
 * How a person opens a session in the provider's own CLI (watch-and-attach §5):
 * the executable and its arguments, built by the provider that knows them, so a
 * client never needs to.
 */
export interface AttachCommand {
  readonly executable: string
  readonly args: readonly string[]
}

export const attachCommand = (): Schema<AttachCommand> =>
  objectAs<AttachCommand>()({ executable: string({ minLength: 1, maxLength: 500 }), args: array(string({ maxLength: 2000 })) })

export const sessionSpec = (): Schema<SessionSpec> =>
  objectAs<SessionSpec>()({
    peerId: peerId(),
    role: string({ minLength: 1, maxLength: 80 }),
    cwd: string({ minLength: 1 }),
    model: string({ minLength: 1 }),
    effort: optional(effort()),
    permissionMode: permissionMode(),
    env: record(string()),
    brief: briefHandoff(),
    stateFile: optional(stateFile()),
    mcp: optional(array(mcpServer())),
    resumeRef: optional(providerSessionRef()),
    systemPromptAppend: optional(text()),
    toolPolicy: optional(toolPolicy()),
    opening: optional(text()),
  })

/** The kinds of message a turn can carry; they match `Message.kind` (§3, §7). */
export const turnKinds = ['brief', 'answer', 'nudge', 'info'] as const
export type TurnKind = (typeof turnKinds)[number]

/** One send to a session — a message, never keystrokes (§4, §7). */
export interface Turn {
  readonly text: string
  readonly kind: TurnKind
  /** The brief the turn was written against; a stale reply is rejected by the Mailbox (§7). */
  readonly briefVersion: number
}

export const turn = (): Schema<Turn> =>
  objectAs<Turn>()({ text: text(), kind: oneOf(turnKinds), briefVersion: positiveInt() })

/**
 * What `Provider.usage` reports; the self-purge trigger reads `contextTokens`
 * (§8). The three numbers fail independently, so they are sourced independently.
 */
export interface Usage {
  readonly contextTokens: number
  /**
   * Always from config (`config/policies/limits`, per provider and model),
   * never from the SDK: an SDK that guesses the window would purge a large
   * model at a fifth of its real context (§4, §8).
   */
  readonly contextLimit: number
  /** Present only when `capabilities.usageCost` is true; null-equivalent otherwise (§4, §11). */
  readonly costUsd?: number
  /**
   * The token count at which the provider compacts on its own, when it will and
   * says so (§8). A second, different question from `contextLimit`: the limit is
   * what the model can hold (configured, because a vendor's SDK guesses), while
   * this is when *the running process* gives up and summarizes — which can be
   * well below the window (a 1M-window model with a 200K compaction policy), and
   * is the number a purge has to beat. Absent when the provider does not compact
   * or does not say.
   */
  readonly autoCompactAt?: number
}

export const usage = (): Schema<Usage> =>
  objectAs<Usage>()({
    contextTokens: count(),
    contextLimit: positiveInt(),
    costUsd: optional(number({ min: 0 })),
    autoCompactAt: optional(positiveInt()),
  })

/** Why a turn ended. Only `failed` may raise a `peer.failed` (§6.1); an interrupt notifies nobody. */
export const turnEndReasons = ['completed', 'interrupted', 'failed'] as const
export type TurnEndReason = (typeof turnEndReasons)[number]

/**
 * What asked for a compaction (§8). `auto` is the provider's own threshold and
 * `manual` is a person typing `/compact`; `unknown` is a provider whose stream
 * says it compacted but not why, and is kept separate rather than folded into
 * `auto`, because the two mean different things to whoever reads the bill.
 */
export const compactionTriggers = ['auto', 'manual', 'unknown'] as const
export type CompactionTrigger = (typeof compactionTriggers)[number]

/**
 * Why a provider's session stream ended. The adapter synthesises
 * `session.ended` — no SDK here emits one — from the iterator finishing or
 * throwing, or from the process exiting (§4). `stopped` is a stop we asked for.
 */
export const providerSessionEndReasons = ['exit', 'crash', 'stopped'] as const
export type ProviderSessionEndReason = (typeof providerSessionEndReasons)[number]

/** One question in a `question.asked`, shaped like the SDK's `AskUserQuestion`. */
export interface ProviderQuestion {
  readonly question: string
  readonly header?: string
  readonly multiSelect?: boolean
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
}

/** The labels chosen, one per question, in the order the questions were asked. */
export type QuestionAnswer = readonly string[]

/**
 * The stream a provider pushes (§4): plain data, never text meant to be parsed.
 * `waiting_input` is derived from an unanswered `question.asked` or
 * `approval.requested`, not from a regex on `?`; a turn boundary is where the
 * self-purge trigger is evaluated (§8).
 *
 * `question.asked` and `approval.requested` carry the id the decision inbox
 * answers through `answer()`/`respond()`; an event is stored and replayed, so
 * it never carries the answer itself.
 */
export type ProviderEvent =
  | { readonly type: 'turn.started'; readonly turnId: TurnId; readonly at: string }
  | {
      readonly type: 'turn.ended'
      readonly turnId: TurnId
      readonly at: string
      readonly reason: TurnEndReason
      /** Why it failed; present with `reason: 'failed'`. */
      readonly error?: string
      readonly usage?: Usage
    }
  | {
      readonly type: 'tool.use'
      readonly turnId: TurnId
      readonly tool: string
      /** A short, already-redacted summary; never the full tool input. */
      readonly summary?: string
    }
  | {
      readonly type: 'question.asked'
      readonly turnId: TurnId
      readonly questionId: QuestionId
      readonly questions: readonly ProviderQuestion[]
    }
  /** The pending question died with its session and will never be answered (§4). */
  | { readonly type: 'question.abandoned'; readonly questionId: QuestionId }
  | {
      readonly type: 'approval.requested'
      readonly turnId: TurnId
      readonly requestId: string
      readonly tool: string
      /** A short, already-redacted summary of what the tool would do. */
      readonly summary?: string
    }
  /** The pending approval died with its session and will never be answered (§4). */
  | { readonly type: 'approval.abandoned'; readonly requestId: string }
  /** The session's tool policy denied a call; nothing was run and nobody was asked (§4). */
  | {
      readonly type: 'tool.denied'
      readonly turnId: TurnId
      readonly tool: string
      /** A short, already-redacted summary of what the tool would have done. */
      readonly summary?: string
    }
  | {
      readonly type: 'session.ended'
      readonly reason: ProviderSessionEndReason
      /** The provider process's exit code; absent for an in-process provider. */
      readonly code?: number
    }
  | { readonly type: 'error'; readonly message: string; readonly retryable: boolean }
  | {
      type: 'compaction'
      /**
       * The turn it happened in, when one was open. A compaction is *not* an
       * intra-turn event: an auto-compaction can fire between turns, and a
       * person's `/compact` always does — and that is the compaction that costs
       * a peer its context without anybody noticing (§8).
       */
      readonly turnId?: TurnId
      /** What asked for it: the provider's own threshold, a person, or a provider that does not say. */
      readonly trigger: CompactionTrigger
      readonly contextTokensBefore: number
      /** What the window held afterwards; absent when the provider did not report it. */
      readonly contextTokensAfter?: number
    }

const isoInstant = (): Schema<string> =>
  refine(string({ minLength: 20, maxLength: 30 }), (v) => !Number.isNaN(Date.parse(v)), 'an ISO 8601 timestamp')

const providerQuestion = (): Schema<ProviderQuestion> =>
  objectAs<ProviderQuestion>()({
    question: text(),
    header: optional(string({ maxLength: 80 })),
    multiSelect: optional(boolean()),
    options: optional(array(object({ label: string({ minLength: 1, maxLength: 200 }), description: optional(text()) }))),
  })

/**
 * One line of what a peer said or did, for a person watching (watch-and-attach §6).
 *
 * Display data, not a fact: it is never stored, and nothing decides on it. A
 * `text` line is a chunk of what the peer said, a `tool` line carries the same
 * redacted summary `tool.use` does, and a `turn` line marks a boundary.
 */
export type DisplayLine =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly tool: string; readonly summary?: string }
  | { readonly kind: 'turn'; readonly phase: 'started' | 'ended'; readonly reason?: TurnEndReason }

/** The longest `text` or `summary` a display line carries; the feed cuts to this before it buffers (§6). */
export const displayLineMaxChars = 400

export const displayLine = (): Schema<DisplayLine> =>
  unionAs<DisplayLine>()([
    object({ kind: literal('text'), text: string({ maxLength: displayLineMaxChars + 1 }) }),
    object({
      kind: literal('tool'),
      tool: string({ minLength: 1 }),
      summary: optional(string({ maxLength: displayLineMaxChars + 1 })),
    }),
    object({
      kind: literal('turn'),
      phase: oneOf(['started', 'ended'] as const),
      reason: optional(oneOf(turnEndReasons)),
    }),
  ])

export const providerEvent = (): Schema<ProviderEvent> =>
  unionAs<ProviderEvent>()([
    object({ type: literal('turn.started'), turnId: turnId(), at: isoInstant() }),
    object({
      type: literal('turn.ended'),
      turnId: turnId(),
      at: isoInstant(),
      reason: oneOf(turnEndReasons),
      error: optional(text()),
      usage: optional(usage()),
    }),
    object({
      type: literal('tool.use'),
      turnId: turnId(),
      tool: string({ minLength: 1 }),
      summary: optional(string({ maxLength: 500 })),
    }),
    object({
      type: literal('question.asked'),
      turnId: turnId(),
      questionId: questionId(),
      questions: refine(array(providerQuestion()), (v) => v.length > 0, 'at least one question'),
    }),
    object({ type: literal('question.abandoned'), questionId: questionId() }),
    object({
      type: literal('approval.requested'),
      turnId: turnId(),
      requestId: string({ minLength: 1, maxLength: 80 }),
      tool: string({ minLength: 1 }),
      summary: optional(string({ maxLength: 500 })),
    }),
    object({ type: literal('approval.abandoned'), requestId: string({ minLength: 1, maxLength: 80 }) }),
    object({
      type: literal('tool.denied'),
      turnId: turnId(),
      tool: string({ minLength: 1 }),
      summary: optional(string({ maxLength: 500 })),
    }),
    object({
      type: literal('session.ended'),
      reason: oneOf(providerSessionEndReasons),
      code: optional(number({ int: true })),
    }),
    object({ type: literal('error'), message: text(), retryable: boolean() }),
    object({
      type: literal('compaction'),
      turnId: optional(turnId()),
      trigger: oneOf(compactionTriggers),
      contextTokensBefore: count(),
      contextTokensAfter: optional(count()),
    }),
  ])

export type ProviderStatus = PeerState

/** Re-exported so a provider package needs one import for its whole contract. */
export type { PeerId, SessionId, ProviderSessionRef, TurnId, WorkId, ContractId }
