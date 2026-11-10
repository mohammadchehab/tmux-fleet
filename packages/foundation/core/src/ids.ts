/**
 * Stable identifiers (architecture §3, §7). Every entity is keyed by an id and
 * never by a tmux name, pane or session ref. `peerId` is the one human-chosen,
 * stable id (`engineer-1`) that outlives its sessions; every other id is
 * opaque and minted here so no caller invents its own format.
 */

import { randomUUID } from 'node:crypto'
import { branded, type Schema, string } from './schema.ts'

declare const brand: unique symbol

/** A string that carries its entity kind in the type system only. */
export type Brand<T, B extends string> = T & { readonly [brand]: B }

/** A git repository, `owner/name` as `gh` and git spell it. */
export type Repo = Brand<string, 'Repo'>

/** A commit sha, abbreviated or full. */
export type Sha = Brand<string, 'Sha'>

/**
 * A peer's stable id: `engineer-1`, `architect`, `security-architect`. Chosen
 * first and never recycled; a peer's sessions change underneath it (§7).
 */
export type PeerId = Brand<string, 'PeerId'>

/** One run of a peer. Many per peer over time. */
export type SessionId = Brand<string, 'SessionId'>
/** A session reference owned by the vendor; passed back to `Provider.resume`. */
export type ProviderSessionRef = Brand<string, 'ProviderSessionRef'>
/** One item of work in the PM's state machine (§5.1). */
export type WorkId = Brand<string, 'WorkId'>
/** A shared interface/layout a set of Work items builds on (§12). */
export type ContractId = Brand<string, 'ContractId'>
/** An immutable, versioned handoff to a peer (§12). */
export type BriefId = Brand<string, 'BriefId'>
/** One mailbox message (§7). */
export type MessageId = Brand<string, 'MessageId'>
/** A checkout a peer works in (§9). */
export type WorktreeId = Brand<string, 'WorktreeId'>
/** One PM branch, with its typed question and answer (§5.4). */
export type DecisionId = Brand<string, 'DecisionId'>
/** One typed question put to a Judge; its answer is recorded under the same id (§5.3). */
export type QuestionId = Brand<string, 'QuestionId'>
/** A registered routine (§6). */
export type RoutineId = Brand<string, 'RoutineId'>
/** One send to a provider session. */
export type TurnId = Brand<string, 'TurnId'>
/** A typed security finding, deduped by fingerprint (§6.2). */
export type FindingId = Brand<string, 'FindingId'>
/** A notification key: `decision:<id>`, `failure:<subject>:<kind>`, `standup:<date>` (§6.1). */
export type NotificationKey = Brand<string, 'NotificationKey'>
/** A build ledger entry, unique on `(repo, sha, task)` (§11). */
export type BuildId = Brand<string, 'BuildId'>

const PEER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA_PATTERN = /^[0-9a-f]{7,40}$/
const NOTIFICATION_KEY_PATTERN = /^(?:decision|failure|standup):[A-Za-z0-9._:-]{1,120}$/
const PROVIDER_SESSION_REF_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/

export const repo = (): Schema<Repo> => branded(string({ pattern: REPO_PATTERN, maxLength: 200 }), 'Repo')
export const sha = (): Schema<Sha> => branded(string({ pattern: SHA_PATTERN }), 'Sha')
export const peerId = (): Schema<PeerId> => branded(string({ pattern: PEER_PATTERN, maxLength: 40 }), 'PeerId')
export const providerSessionRef = (): Schema<ProviderSessionRef> =>
  branded(string({ pattern: PROVIDER_SESSION_REF_PATTERN }), 'ProviderSessionRef')
export const notificationKey = (): Schema<NotificationKey> =>
  branded(string({ pattern: NOTIFICATION_KEY_PATTERN, maxLength: 200 }), 'NotificationKey')

/**
 * Opaque ids are `<prefix>_<16 lowercase hex>`. `mint` and the schema share
 * one prefix, so a minted id always parses and a hand-written one never passes
 * for something it is not.
 */
const opaque = <T extends string>(name: string, prefix: string): Schema<T> => {
  const pattern = new RegExp(`^${prefix}_[0-9a-f]{16}$`)
  return branded(string({ pattern }), name)
}

export const sessionId = (): Schema<SessionId> => opaque('SessionId', 'ses')
export const workId = (): Schema<WorkId> => opaque('WorkId', 'wrk')
export const contractId = (): Schema<ContractId> => opaque('ContractId', 'con')
export const briefId = (): Schema<BriefId> => opaque('BriefId', 'brf')
export const messageId = (): Schema<MessageId> => opaque('MessageId', 'msg')
export const worktreeId = (): Schema<WorktreeId> => opaque('WorktreeId', 'wtr')
export const decisionId = (): Schema<DecisionId> => opaque('DecisionId', 'dec')
export const questionId = (): Schema<QuestionId> => opaque('QuestionId', 'qst')
export const routineId = (): Schema<RoutineId> => opaque('RoutineId', 'rtn')
export const turnId = (): Schema<TurnId> => opaque('TurnId', 'trn')
export const findingId = (): Schema<FindingId> => opaque('FindingId', 'fnd')
export const buildId = (): Schema<BuildId> => opaque('BuildId', 'bld')

const mint = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`

export const newSessionId = (): SessionId => mint('ses') as SessionId
export const newWorkId = (): WorkId => mint('wrk') as WorkId
export const newContractId = (): ContractId => mint('con') as ContractId
export const newBriefId = (): BriefId => mint('brf') as BriefId
export const newMessageId = (): MessageId => mint('msg') as MessageId
export const newWorktreeId = (): WorktreeId => mint('wtr') as WorktreeId
export const newDecisionId = (): DecisionId => mint('dec') as DecisionId
export const newQuestionId = (): QuestionId => mint('qst') as QuestionId
export const newRoutineId = (): RoutineId => mint('rtn') as RoutineId
export const newTurnId = (): TurnId => mint('trn') as TurnId
export const newFindingId = (): FindingId => mint('fnd') as FindingId
export const newBuildId = (): BuildId => mint('bld') as BuildId

/** A notification key, built the one way the notification projection builds it (§6.1). */
export const decisionNotificationKey = (id: DecisionId): NotificationKey => `decision:${id}` as NotificationKey
export const failureNotificationKey = (subject: string, kind: string): NotificationKey =>
  `failure:${subject}:${kind}` as NotificationKey
export const standupNotificationKey = (date: string): NotificationKey => `standup:${date}` as NotificationKey
