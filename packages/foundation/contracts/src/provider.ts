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

import {
  array,
  boolean,
  count,
  literal,
  number,
  object,
  oneOf,
  optional,
  positiveInt,
  record,
  refine,
  string,
  text,
  union,
  type Schema,
} from '@fleet/foundation-core'
import {
  briefId,
  contractId,
  peerId,
  providerSessionRef,
  turnId,
  type BriefId,
  type ContractId,
  type PeerId,
  type ProviderSessionRef,
  type SessionId,
  type TurnId,
  type WorkId,
} from '@fleet/foundation-core'
import type { PeerState } from '@fleet/foundation-core'

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
  /** The provider can answer a `Judge`-style call against a schema. */
  readonly structuredOutput: boolean
  /** The permission modes this provider honours; `SessionSpec.permissionMode` must be one. */
  readonly permissionModes: readonly PermissionMode[]
}

export const providerCapabilities = (): Schema<ProviderCapabilities> =>
  object({
    resume: boolean(),
    modelSwitch: boolean(),
    usageTokens: boolean(),
    structuredOutput: boolean(),
    permissionModes: array(permissionMode(), { maxItems: permissionModes.length }),
  }) as Schema<ProviderCapabilities>

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
  object({
    id: string({ minLength: 1, maxLength: 80 }),
    command: string({ minLength: 1 }),
    args: optional(array(string())),
    env: optional(record(string())),
  }) as Schema<McpServer>

/** The brief a session starts from, resolved from the store at start (§7, §12). */
export interface BriefHandoff {
  readonly briefId: BriefId
  readonly version: number
  /** The contract versions the brief was written against; a newer contract supersedes it (§12). */
  readonly contractVersions: readonly { readonly contractId: ContractId; readonly version: number }[]
  readonly text: string
}

export const briefHandoff = (): Schema<BriefHandoff> =>
  object({
    briefId: briefId(),
    version: positiveInt(),
    contractVersions: array(object({ contractId: contractId(), version: positiveInt() })),
    text: text(),
  }) as Schema<BriefHandoff>

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
  object({
    peerId: peerId(),
    goal: text(),
    done: array(text()),
    inFlight: array(text()),
    next: array(text()),
    decisions: array(text()),
    openQuestions: array(text()),
    briefVersion: positiveInt(),
  }) as Schema<StateFile>

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
}

export const sessionSpec = (): Schema<SessionSpec> =>
  object({
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
  }) as Schema<SessionSpec>

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
  object({ text: text(), kind: oneOf(turnKinds), briefVersion: positiveInt() }) as Schema<Turn>

/** What `Provider.usage` reports; the self-purge trigger reads `contextTokens` (§8). */
export interface Usage {
  readonly contextTokens: number
  readonly contextLimit: number
  readonly costUsd?: number
}

export const usage = (): Schema<Usage> =>
  object({
    contextTokens: count(),
    contextLimit: positiveInt(),
    costUsd: optional(number({ min: 0 })),
  }) as Schema<Usage>

/**
 * The stream a provider pushes (§4). `waiting_input` is derived from
 * `question.asked`, not from a regex on `?`; a turn boundary is where the
 * self-purge trigger is evaluated (§8).
 */
export type ProviderEvent =
  | { readonly type: 'turn.started'; readonly turnId: TurnId; readonly at: string }
  | { readonly type: 'turn.ended'; readonly turnId: TurnId; readonly at: string; readonly usage?: Usage }
  | {
      readonly type: 'tool.use'
      readonly turnId: TurnId
      readonly tool: string
      /** A short, already-redacted summary; never the full tool input. */
      readonly summary?: string
    }
  | { readonly type: 'question.asked'; readonly turnId: TurnId; readonly question: string }
  | { readonly type: 'error'; readonly message: string; readonly retryable: boolean }
  | {
      readonly type: 'compaction'
      readonly turnId: TurnId
      readonly contextTokensBefore: number
      readonly contextTokensAfter: number
    }

const isoInstant = (): Schema<string> =>
  refine(string({ minLength: 20, maxLength: 30 }), (v) => !Number.isNaN(Date.parse(v)), 'an ISO 8601 timestamp')

export const providerEvent = (): Schema<ProviderEvent> =>
  union([
    object({ type: literal('turn.started'), turnId: turnId(), at: isoInstant() }),
    object({ type: literal('turn.ended'), turnId: turnId(), at: isoInstant(), usage: optional(usage()) }),
    object({
      type: literal('tool.use'),
      turnId: turnId(),
      tool: string({ minLength: 1 }),
      summary: optional(string({ maxLength: 500 })),
    }),
    object({ type: literal('question.asked'), turnId: turnId(), question: text() }),
    object({ type: literal('error'), message: text(), retryable: boolean() }),
    object({
      type: literal('compaction'),
      turnId: turnId(),
      contextTokensBefore: count(),
      contextTokensAfter: count(),
    }),
  ]) as Schema<ProviderEvent>

export type ProviderStatus = PeerState

/** Re-exported so a provider package needs one import for its whole contract. */
export type { PeerId, SessionId, ProviderSessionRef, TurnId, WorkId, ContractId }
