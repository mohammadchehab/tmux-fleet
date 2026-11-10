/**
 * The tmux session a view *is*: which one, and the commands that build it.
 *
 * Kept as data — argv lists, not calls — so the layout is a test with no tmux
 * installed, and so `--print` (or a person reading a bug report) can see exactly
 * what the view would run. `main.ts` is what actually spawns it.
 *
 * One window, one pane per peer, tiled: a view is looked at, not navigated, and
 * a window of four small panes says more about a fleet than four windows. The
 * panes run the renderer directly and never a shell, which is the read-only
 * half of §2's "it never receives keystrokes from code": there is no prompt in
 * the pane to type at.
 *
 * tmux joins its trailing `[shell-command]` arguments with spaces and hands the
 * result to `/bin/sh`, so the command has to arrive as **one** string with every
 * word quoted. A socket under a directory with a space in it would otherwise
 * silently start a pane that runs `node` with no arguments.
 */

export interface PaneOptions {
  /** Usually `[process.execPath, process.argv[1]]`; a test passes a plain pair. */
  readonly command: readonly string[]
  readonly socketPath: string
  readonly intervalMs: number
}

const shQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

/**
 * The one command a pane runs: the renderer for a single peer, against the
 * socket the session was built for. The socket is passed explicitly even though
 * the pane inherits the environment, because the environment is what `--socket`
 * exists to override.
 */
export const paneCommand = (options: PaneOptions, peerId: string): string =>
  [
    ...options.command,
    '--socket',
    options.socketPath,
    '--pane',
    peerId,
    '--interval',
    String(options.intervalMs),
  ]
    .map(shQuote)
    .join(' ')

/** One session per fleet, so a second `fleet-view` attaches to the first instead of racing it. */
export const viewSessionName = (profile: string | undefined): string =>
  profile === undefined ? 'fleet-view' : `fleet-${profile}`

export const WINDOW = 'peers'

export interface BuildOptions extends PaneOptions {
  readonly session: string
  readonly peers: readonly string[]
}

/** The tmux argv (after `tmux`) that builds the session, in order, from nothing. */
export const buildCommands = (options: BuildOptions): readonly (readonly string[])[] => {
  const target = `${options.session}:${WINDOW}`
  const first = options.peers[0]
  if (first === undefined) return []

  const splits = options.peers.slice(1).map((peer) => ['split-window', '-t', target, '--', paneCommand(options, peer)])

  return [
    // Borders on top carry each pane's peer id, set below, so a small pane is
    // still identifiable when its first line has scrolled out of a narrow tile.
    ['new-session', '-d', '-s', options.session, '-n', WINDOW, '-x', '200', '-y', '50', '--', paneCommand(options, first)],
    ['set-option', '-t', options.session, 'pane-border-status', 'top'],
    ...splits,
    // One pane has no layout to choose.
    ...(splits.length === 0 ? [] : [['select-layout', '-t', target, 'tiled']]),
    // A renderer that died (a crash, not a refused connection, which it handles)
    // leaves its last pane on screen with the reason rather than taking the grid
    // apart and re-tiling everyone else's view.
    ['set-window-option', '-t', target, 'remain-on-exit', 'on'],
    ...options.peers.map((peer, index) => ['select-pane', '-t', `${target}.${index}`, '-T', peer]),
  ]
}

/**
 * How to show the session. Inside tmux a client attaches to nothing useful — it
 * is already in a session — so it switches; outside, it attaches. `-d` above is
 * why this is a separate command: the session is built detached, then joined,
 * which is also what lets a second run join instead of rebuild.
 */
export const showCommand = (session: string, insideTmux: boolean): readonly string[] =>
  insideTmux ? ['switch-client', '-t', session] : ['attach-session', '-t', session]

export const hasSessionCommand = (session: string): readonly string[] => ['has-session', '-t', session]
