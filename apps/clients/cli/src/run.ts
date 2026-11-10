/**
 * `fleet`'s argument grammar and its commands (§2).
 *
 * Two halves, kept apart on purpose: `parseArgv` turns words into one of a
 * closed set of commands and throws `invalid_input` for anything else, and
 * `execute` turns a command into daemon calls. Neither touches `process`,
 * which is why every branch below is a test with a fake caller and no socket —
 * `main.ts` is the only file that knows there is a terminal.
 *
 * The CLI is a client, so it decides nothing about the fleet: it validates
 * what it can locally (`kind` is one of the four §7 kinds, `--limit` is a
 * positive integer) and hands everything else to the daemon, which validates
 * again against the same contract.
 */

import { existsSync } from 'node:fs'

import { decisionId, evalRunId, fleetError, peerId, profilePaths, toFleetError } from '@fleet/foundation-core'
import {
  evalSuites,
  turnKinds,
  type AppendEvent,
  type Decision,
  type LsResult,
  type TurnKind,
  type UpResult,
} from '@fleet/foundation-contracts'

import { asArgument, isUnreachable, type DaemonCaller } from './client.ts'
import { formatEvalCompare } from './evals-compare.ts'
import { formatEvalRun } from './evals-report.ts'
import { readEvalsOutput, type EvalsEvents, type EvalsProcessResult, type EvalsRunOptions } from './evals.ts'
import { formatDecision, formatDown, formatLs, formatPeek, formatSend, formatUp } from './render.ts'
import { socketPathOf } from './socket.ts'

/** Both eval verbs, so a wrong one names every one that exists. */
const EVALS_USAGE = 'fleet evals run <suite> | fleet evals compare <runA> <runB>'

const usage = (): string =>
  [
    'fleet - talk to a running fleetd. The CLI holds no state; everything it shows comes from the daemon.',
    '',
    '  fleet init <profile>                write a starter profile, once; it never overwrites',
    '  fleet up [profile]                  start the fleet, or reattach to the one already running',
    '  fleet down                          stop it',
    '  fleet ls                            peers, routines and the decisions waiting on you',
    '  fleet send <peer> <kind> <body>     message a peer',
    '  fleet peek <peer> [--limit N]       a peer\'s mailbox, oldest first (--limit keeps the newest N)',
    '  fleet decide <id> [answer]          show an open decision, or answer it',
    '  fleet evals run <suite>             run an eval suite against its baseline',
    '  fleet evals compare <runA> <runB>   two eval runs side by side (a run id is printed by `evals run`)',
    '  fleet --help                        this',
    '',
    'options, on any command:',
    '  --socket <path>    talk to this socket instead of the profile\'s',
    '  --profile <name>   the profile, instead of $FLEET_PROFILE',
    '  --json             print the daemon\'s answer as JSON, for another client',
    '',
    'options, on `evals run`:',
    '  --provider <name>  who answers: claude or deepinfra',
    '  --model <id>       the model under test; the run measures this one',
    '  --save-baseline    write this run as the baseline instead of comparing',
    '',
    `kinds: ${turnKinds.join(' | ')}   (info is what a person usually sends)`,
    `suites: ${evalSuites.join(' | ')}   (judge is the one that runs)`,
  ].join('\n')

/** Which daemon, and how to print what it says. */
export interface HowToTalk {
  readonly socket?: string
  readonly profile?: string
  readonly json: boolean
}

export type Command =
  | { readonly kind: 'help' }
  | { readonly kind: 'init'; readonly profile: string }
  | { readonly kind: 'up' }
  | { readonly kind: 'down' }
  | { readonly kind: 'ls' }
  | { readonly kind: 'send'; readonly to: string; readonly turn: TurnKind; readonly body: string }
  | { readonly kind: 'peek'; readonly peer: string; readonly limit?: number }
  | { readonly kind: 'decide'; readonly id: string; readonly decision?: string; readonly note?: string }
  | {
      readonly kind: 'evals-run'
      readonly suite: string
      readonly provider?: string
      readonly model?: string
      readonly saveBaseline: boolean
    }
  | { readonly kind: 'evals-compare'; readonly runA: string; readonly runB: string }

export interface Parsed {
  readonly command: Command
  readonly how: HowToTalk
}

const usageError = (message: string): Error => fleetError('invalid_input', message)

/** `--name value` and `--name=value` both, because a shell does one and a script often the other. */
const optionValue = (argv: readonly string[], index: number, name: string): { readonly value: string; readonly next: number } => {
  const arg = argv[index] ?? ''
  const equals = arg.indexOf('=')
  if (equals >= 0) {
    const value = arg.slice(equals + 1)
    if (value === '') throw usageError(`${name} needs a value`)
    return { value, next: index }
  }
  const value = argv[index + 1]
  if (value === undefined || value === '') throw usageError(`${name} needs a value`)
  return { value, next: index + 1 }
}

const positiveCount = (name: string, raw: string): number => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw usageError(`${name} takes a positive whole number, not "${raw}"`)
  return value
}

const arity = (command: string, rest: readonly string[], shape: string, accept: (count: number) => boolean): void => {
  if (!accept(rest.length)) throw usageError(`usage: fleet ${command}${shape === '' ? '' : ` ${shape}`}`)
}

export const parseArgv = (argv: readonly string[]): Parsed => {
  const positional: string[] = []
  let socket: string | undefined
  let profile: string | undefined
  let limit: string | undefined
  let note: string | undefined
  let provider: string | undefined
  let model: string | undefined
  let saveBaseline = false
  let json = false

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--help' || arg === '-h') return { command: { kind: 'help' }, how: { json } }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--save-baseline') {
      saveBaseline = true
      continue
    }
    if (arg === '--socket' || arg.startsWith('--socket=')) {
      const read = optionValue(argv, index, '--socket')
      socket = read.value
      index = read.next
      continue
    }
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      const read = optionValue(argv, index, '--profile')
      profile = read.value
      index = read.next
      continue
    }
    if (arg === '--limit' || arg.startsWith('--limit=')) {
      const read = optionValue(argv, index, '--limit')
      limit = read.value
      index = read.next
      continue
    }
    if (arg === '--note' || arg.startsWith('--note=')) {
      const read = optionValue(argv, index, '--note')
      note = read.value
      index = read.next
      continue
    }
    if (arg === '--provider' || arg.startsWith('--provider=')) {
      const read = optionValue(argv, index, '--provider')
      provider = read.value
      index = read.next
      continue
    }
    if (arg === '--model' || arg.startsWith('--model=')) {
      const read = optionValue(argv, index, '--model')
      model = read.value
      index = read.next
      continue
    }
    if (arg.startsWith('-')) throw usageError(`unknown option ${arg}`)
    positional.push(arg)
  }

  const [name, ...rest] = positional
  // `up <profile>` names the profile positionally, which is how `fleet up` is
  // written in the docs; `--profile` still works and wins over nothing, since
  // the two are the same slot.
  const how = (positionalProfile?: string): HowToTalk => {
    const named = positionalProfile ?? profile
    return {
      json,
      ...(socket === undefined ? {} : { socket }),
      ...(named === undefined ? {} : { profile: named }),
    }
  }

  if (name === undefined) return { command: { kind: 'help' }, how: how() }
  switch (name) {
    case 'help':
      return { command: { kind: 'help' }, how: how() }
    case 'init': {
      arity('init', rest, '<profile>', (count) => count === 1)
      const profileName = rest[0]
      if (profileName === undefined) throw usageError('usage: fleet init <profile>')
      return { command: { kind: 'init', profile: profileName }, how: how() }
    }
    case 'up': {
      arity('up', rest, '[profile]', (count) => count <= 1)
      return { command: { kind: 'up' }, how: how(rest[0]) }
    }
    case 'down':
      arity('down', rest, '', (count) => count === 0)
      return { command: { kind: 'down' }, how: how() }
    case 'ls':
      arity('ls', rest, '', (count) => count === 0)
      return { command: { kind: 'ls' }, how: how() }
    case 'send': {
      arity('send', rest, '<peer> <kind> <body>', (count) => count >= 3)
      const [to, kind, ...words] = rest
      const body = words.join(' ')
      if (to === undefined || kind === undefined || body === '') throw usageError('usage: fleet send <peer> <kind> <body>')
      if (!(turnKinds as readonly string[]).includes(kind)) {
        throw usageError(`kind "${kind}" is not one of ${turnKinds.join(', ')}`)
      }
      return { command: { kind: 'send', to, turn: kind as TurnKind, body }, how: how() }
    }
    case 'peek': {
      arity('peek', rest, '<peer> [--limit N]', (count) => count === 1)
      const peer = rest[0]
      if (peer === undefined) throw usageError('usage: fleet peek <peer> [--limit N]')
      return {
        command: { kind: 'peek', peer, ...(limit === undefined ? {} : { limit: positiveCount('--limit', limit) }) },
        how: how(),
      }
    }
    case 'decide': {
      arity('decide', rest, '<id> [answer]', (count) => count >= 1)
      const [id, ...words] = rest
      const decision = words.join(' ')
      if (id === undefined) throw usageError('usage: fleet decide <id> [answer]')
      return {
        command: {
          kind: 'decide',
          id,
          ...(decision === '' ? {} : { decision }),
          ...(note === undefined ? {} : { note }),
        },
        how: how(),
      }
    }
    case 'evals': {
      // The verb decides the rest, so `compare` and `run` each keep their own
      // arity and their own refusal.
      const [verb, ...more] = rest
      if (verb === 'compare') {
        arity('evals compare', more, '<runA> <runB>', (count) => count === 2)
        const [runA, runB] = more
        if (runA === undefined || runB === undefined) throw usageError(`usage: ${EVALS_USAGE}`)
        return { command: { kind: 'evals-compare', runA, runB }, how: how() }
      }
      const [suite, ...extra] = more
      if (verb !== 'run') throw usageError(`usage: ${EVALS_USAGE}`)
      if (suite === undefined || extra.length > 0) throw usageError('usage: fleet evals run <suite>')
      if (!(evalSuites as readonly string[]).includes(suite)) {
        throw usageError(`suite "${suite}" is not one of ${evalSuites.join(', ')}`)
      }
      // Only the judge suite has a runner. Saying so here rather than spawning a
      // binary that would refuse is the difference between a typo and an unfinished
      // suite, and the four names above stay listed because they are the plan.
      if (suite !== 'judge') throw usageError(`the ${suite} suite has no runner yet; judge is the one that runs`)
      return {
        command: {
          kind: 'evals-run',
          suite,
          saveBaseline,
          ...(provider === undefined ? {} : { provider }),
          ...(model === undefined ? {} : { model }),
        },
        how: how(),
      }
    }
    default:
      throw usageError(`unknown command ${name}`)
  }
}
export interface RunDeps {
  /** Bind the caller to a socket; `callerFor` from `client.ts` is the real one. */
  readonly call: (socketPath: string) => DaemonCaller
  /** `fleet up` on a fleet that is not running. Absent means `up` reports the dead socket instead. */
  readonly startFleetd?: (profile: string) => Promise<void>
  /**
   * `fleet evals run`: the suite as a process. Absent means this build cannot run
   * one, and the command says so instead of pretending the suite is missing.
   */
  readonly runEvals?: (options: EvalsRunOptions) => Promise<EvalsProcessResult>
  /**
   * `fleet init`: write the starter profile and say where it went. Absent means
   * this build cannot write one, and the command says so rather than the person
   * finding an empty file later.
   */
  readonly initProfile?: (profile: string) => Promise<{ readonly profileFile: string }>
  readonly out?: (text: string) => void
  readonly err?: (text: string) => void
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string
  readonly sleep?: (ms: number) => Promise<void>
  /** How long `up` waits for a daemon it just started. */
  readonly upTimeoutMs?: number
  readonly upIntervalMs?: number
  /** "Is this profile file there?" — `existsSync` unless a test says otherwise. */
  readonly profileFileExists?: (path: string) => boolean
}

interface Answer {
  readonly text: string
  /** What `--json` prints: the daemon's answer, untouched. */
  readonly value: unknown
  /**
   * The command's own exit code, for the one command whose answer *is* a code: an
   * eval run that fell below its baseline is a `1` the caller scripted for.
   */
  readonly exitCode?: number
}

const waitForUp = async (
  call: DaemonCaller,
  options: {
    readonly timeoutMs: number
    readonly intervalMs: number
    readonly sleep: (ms: number) => Promise<void>
    /** The file `spawnFleetd` sent the daemon's own output to, for the timeout line. */
    readonly logPath?: string
  },
): Promise<UpResult> => {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    try {
      return await call('up', {})
    } catch (thrown) {
      // A daemon that is up and refusing is not a daemon that is starting.
      if (!isUnreachable(thrown)) throw thrown
      if (Date.now() >= deadline) {
        throw fleetError(
          'timeout',
          `fleetd did not come up within ${String(options.timeoutMs)} ms${options.logPath === undefined ? '' : `; the daemon's own output is in ${options.logPath}`}`,
          { cause: thrown },
        )
      }
      await options.sleep(options.intervalMs)
    }
  }
}

/**
 * Hand the run's `eval.*` rows to the daemon, in the two batches the store's
 * citation rule asks for: `eval.run_started` on its own, then every scored attempt
 * and the finish, each citing the start's seq so a reader can join a run.
 *
 * The runner cannot do this itself — it is a second process and the store has one
 * writer — and `fleetd` validates every row against the event's own contract
 * schema, so this is the only place a row can enter the ledger from dev tooling.
 */
const appendEvalEvents = async (call: DaemonCaller, events: EvalsEvents): Promise<void> => {
  const started = await call('events.append', { events: [events.started] })
  const startedSeq = started.seqs[0]
  if (startedSeq === undefined) {
    throw fleetError('internal', 'the daemon appended eval.run_started and returned no seq to cite')
  }
  const cited = (event: AppendEvent): AppendEvent => ({ ...event, causedBy: [startedSeq] }) as AppendEvent
  await call('events.append', { events: [...events.scored.map(cited), cited(events.finished)] })
}

/**
 * The commands that talk to a daemon. `init` is not among them: it writes the
 * file every other command needs, so `run` answers it before a socket is
 * resolved, and the type says so rather than leaving a case that never fires.
 */
type DaemonCommand = Exclude<Command, { readonly kind: 'init' }>

const execute = async (
  command: DaemonCommand,
  call: DaemonCaller,
  deps: RunDeps,
  profile: string | undefined,
  /** Where a command's own narration goes: the same writer the caller's errors use. */
  say: (text: string) => void,
): Promise<Answer> => {
  switch (command.kind) {
    case 'up': {
      try {
        const result = await call('up', {})
        return { text: formatUp(result), value: result }
      } catch (thrown) {
        if (!isUnreachable(thrown)) throw thrown
        if (profile === undefined || deps.startFleetd === undefined) {
          throw fleetError('external_failed', `${toFleetError(thrown).message}; name a profile (fleet up <profile>) and the CLI will start one`, {
            cause: thrown,
          })
        }
        await deps.startFleetd(profile)
        const result = await waitForUp(call, {
          timeoutMs: deps.upTimeoutMs ?? 10_000,
          intervalMs: deps.upIntervalMs ?? 50,
          sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
          logPath: profilePaths(profile, deps.home === undefined ? {} : { home: deps.home }).logPath,
        })
        return { text: formatUp(result), value: result }
      }
    }
    case 'down': {
      try {
        const result = await call('down', {})
        return { text: formatDown(result), value: result }
      } catch (thrown) {
        // Stopping a fleet that is not up is what the user asked for. A refusal
        // from a live daemon is not this, and still throws.
        if (!isUnreachable(thrown)) throw thrown
        return { text: `${profile ?? 'the fleet'} is not running`, value: { stopped: false } }
      }
    }
    case 'ls': {
      try {
        const result = await call('ls', {})
        return { text: formatLs(result), value: result }
      } catch (thrown) {
        // "connect ENOENT" is the truth and not the remedy; a named profile has one.
        if (!isUnreachable(thrown) || profile === undefined) throw thrown
        throw fleetError(
          'external_failed',
          `${toFleetError(thrown).message} — that fleet is not running; fleet up ${profile} starts it`,
          { cause: thrown },
        )
      }
    }
    case 'send': {
      const to = asArgument(peerId(), command.to, 'peer')
      const result = await call('send', { to, kind: command.turn, body: command.body })
      return { text: formatSend(result, command.to), value: result }
    }
    case 'peek': {
      const peer = asArgument(peerId(), command.peer, 'peer')
      const result = await call('peek', { peer, ...(command.limit === undefined ? {} : { limit: command.limit }) })
      return { text: formatPeek(result, command.peer), value: result }
    }
    case 'decide': {
      const id = asArgument(decisionId(), command.id, 'decision id')
      if (command.decision !== undefined) {
        const result = await call('decide', {
          id,
          decision: command.decision,
          ...(command.note === undefined ? {} : { note: command.note }),
        })
        return { text: formatDecision(result), value: result }
      }
      // `fleet decide <id>` with no answer is a question about the inbox, so it
      // reads the inbox: the decision is in `ls` (§6.1), and a seventh method
      // that repeated it would be one more thing to keep in step.
      const listing: LsResult = await call('ls', {})
      const found: Decision | undefined = listing.decisions.find((row) => row.decisionId === command.id)
      if (found === undefined) {
        throw fleetError('not_found', `no decision ${command.id}; 'fleet ls' lists the open ones`, {
          details: { decisionId: command.id },
        })
      }
      return { text: formatDecision(found), value: found }
    }
    case 'evals-run': {
      if (deps.runEvals === undefined) {
        throw fleetError('external_failed', 'this build of the CLI cannot run an eval suite; install the fleet checkout')
      }
      const ran = await deps.runEvals({
        suite: command.suite,
        saveBaseline: command.saveBaseline,
        ...(command.provider === undefined ? {} : { provider: command.provider }),
        ...(command.model === undefined ? {} : { model: command.model }),
        ...(deps.env === undefined ? {} : { env: deps.env }),
      })
      // The run's own narration is a person's, not a parser's: forwarded as it came,
      // because "baseline written" and "this case fell" are lines the suite wrote.
      if (ran.stderr !== '') say(ran.stderr.replace(/\n$/, ''))
      const answer = readEvalsOutput(ran.stdout)
      // A ledger that would not take the rows is a fleet problem, not a verdict on
      // the model: the run has already happened and cost what it cost, so the rows
      // are reported as lost and the answer still prints with the suite's own code.
      try {
        await appendEvalEvents(call, answer.events)
      } catch (thrown) {
        say(`fleet: the run's eval events did not reach the ledger: ${toFleetError(thrown).message}`)
      }
      const lines = [formatEvalRun(answer.report)]
      if (answer.gate.kind === 'no-baseline') lines.push('  no baseline yet; run with --save-baseline')
      if (answer.gate.kind === 'saved') lines.push(`  baseline written to ${answer.baselinePath ?? 'the baseline file'}`)
      if (answer.gate.kind === 'regressed') {
        lines.push('  below the baseline:')
        for (const regression of answer.gate.regressions) {
          lines.push(
            `    ${regression.caseId}: ${String(regression.passes)}/${String(regression.attempts)} attempts, baseline ${String(regression.baselinePasses)}/${String(regression.baselineAttempts)}`,
          )
        }
      }
      // The suite's code, not the CLI's: `1` is a verdict about the model and `2` a
      // mistake in the setup, and a caller that scripted this reads the difference.
      return { text: lines.join('\n'), value: answer, exitCode: ran.exitCode }
    }
    case 'evals-compare': {
      // Two reads of the projections, not one read of the log: the daemon hands
      // each run over with its cases, and this side only lays them side by side.
      const runA = asArgument(evalRunId(), command.runA, 'run id')
      const runB = asArgument(evalRunId(), command.runB, 'run id')
      const [a, b] = await Promise.all([call('evals', { runId: runA }), call('evals', { runId: runB })])
      return { text: formatEvalCompare(a, b), value: { a, b } }
    }
    case 'help':
      return { text: usage(), value: {} }
  }
}

/**
 * One command, one exit code: `0` done, `2` the command line was wrong, `1`
 * the fleet said no. The split matters because a script can retry `1` and
 * cannot fix `2`.
 */
export const run = async (argv: readonly string[], deps: RunDeps): Promise<number> => {
  const out = deps.out ?? ((text: string) => void process.stdout.write(`${text}\n`))
  const err = deps.err ?? ((text: string) => void process.stderr.write(`${text}\n`))

  try {
    const parsed = parseArgv(argv)
    if (parsed.command.kind === 'help') {
      out(usage())
      return 0
    }
    // `init` writes the file the other commands read, so it resolves no socket:
    // a person typing `fleet init me` is by definition a fleet with nothing to
    // talk to yet, and asking them for a socket first would be the papercut this
    // command exists to remove.
    if (parsed.command.kind === 'init') {
      const write = deps.initProfile
      if (write === undefined) {
        throw fleetError('external_failed', "this build of the CLI cannot write a profile; run it from a fleet checkout")
      }
      const written = await write(parsed.command.profile)
      out(`wrote ${written.profileFile}\nedit it, then: fleet up ${parsed.command.profile}`)
      return 0
    }
    const choice = socketPathOf({
      ...(parsed.how.socket === undefined ? {} : { socket: parsed.how.socket }),
      ...(parsed.how.profile === undefined ? {} : { profile: parsed.how.profile }),
      env: deps.env ?? process.env,
      ...(deps.home === undefined ? {} : { home: deps.home }),
    })
    // A profile that is not there is a typed name, not a dead daemon, and the two
    // read the same from a socket error. Only checked when the socket came from
    // the profile: `--socket` and `FLEET_SOCKET` name a daemon directly, and a
    // peer is handed a socket with no profile file of its own (§8).
    if (choice.profile !== undefined) {
      const paths = profilePaths(choice.profile, deps.home === undefined ? {} : { home: deps.home })
      const exists = deps.profileFileExists ?? existsSync
      if (choice.socketPath === paths.socketPath && !exists(paths.profileFile)) {
        throw fleetError(
          'invalid_input',
          `no profile "${choice.profile}": ${paths.profileFile} is not there; a profile names the fleet's repos and its peers, and fleet up ${choice.profile} reads it`,
        )
      }
    }
    const answer = await execute(parsed.command, deps.call(choice.socketPath), deps, choice.profile, err)
    out(parsed.how.json ? JSON.stringify(answer.value, null, 2) : answer.text)
    return answer.exitCode ?? 0
  } catch (thrown) {
    const error = toFleetError(thrown, 'internal')
    err(`fleet: ${error.message}`)
    if (error.code === 'invalid_input') err("fleet: run 'fleet --help' for the commands")
    return error.code === 'invalid_input' ? 2 : 1
  }
}

export { usage }
