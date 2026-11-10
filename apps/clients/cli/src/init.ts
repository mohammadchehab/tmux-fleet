/**
 * `fleet init <name>`: the starter profile, written once (§2).
 *
 * The file it writes is the one `fleet up <name>` reads, so the starter is a
 * *working* profile rather than a blank one: the first run should fail on the
 * one thing a starter cannot know — which repo to work in — and not on a field
 * the person did not know existed. Everything a profile may hold that the
 * starter does not use is in the comments, generated from the same constants
 * the daemon validates against, so the two cannot drift apart.
 *
 * `init` never overwrites. A profile is hand-written and reviewed after the
 * first run, and a command that quietly replaced it would be the one mistake a
 * starter file cannot afford.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { fleetError, profilePaths, type PathRoots, type ProfileName } from '@fleet/foundation-core'
import { profileProviders, providerModels, routineKinds } from '@fleet/foundation-contracts'

export interface WrittenProfile {
  /** Where the starter went, so the CLI can name it and the person can open it. */
  readonly profileFile: string
}

/**
 * The starter profile for `name`, as bytes. Pure: the writer below is the only
 * part that touches a disk, which is what makes the text testable without one.
 */
export const starterProfile = (name: ProfileName): string =>
  [
    `# ${name} — a fleet profile, written by \`fleet init ${name}\`.`,
    '#',
    `# Edit it, then run \`fleet up ${name}\`. A field this starter leaves out keeps`,
    '# its documented default; a field it fills in is one you are meant to change.',
    `profile: ${name}`,
    '',
    '# the repos the fleet may assign work in. The first is the default.',
    'repos:',
    '  - /path/to/a/repo',
    '',
    '# the peers. Each one is a declaration until `fleet up` registers it.',
    'peers:',
    '  - id: pm',
    '    role: pm',
    '    provider: claude',
    '    model: claude-sonnet-5-5',
    '  - id: engineer-1',
    '    role: engineer',
    '    provider: claude',
    '    model: claude-sonnet-5-5',
    '',
    '# the model ids this repo knows, by provider. A hint, never a gate — an id',
    '# served by a proxy or a newer model still works, it is just not listed here.',
    ...profileProviders.map((provider) => `#   ${provider.padEnd(10)}${providerModels[provider].join(', ')}`),
    '',
    '# every routine runs on its default trigger, so this block only ever turns one',
    '# off or reschedules it. The routines a fleet has:',
    `#   ${routineKinds.join(', ')}`,
    '#',
    '# for example:',
    '#',
    '#   routines:',
    '#     standup:',
    "#       at: '09:00'",
    '#     worktree-gc:',
    '#       enabled: false',
    'routines: {}',
    '',
    '# where a notification goes. `none` keeps the ledger and sends nothing.',
    'notify:',
    '  channel: none',
    '',
  ].join('\n')

/**
 * Write the starter to `~/.config/fleet/profiles/<name>.yaml`, creating the
 * directory but never the file over an existing one.
 */
export const writeStarter = async (name: ProfileName, roots: PathRoots = {}): Promise<WrittenProfile> => {
  const paths = profilePaths(name, roots)
  await mkdir(dirname(paths.profileFile), { recursive: true })
  try {
    // `wx` is the whole of "never overwrite": the create either wins the name or
    // fails, with no window for a check-then-write to race another `init`.
    await writeFile(paths.profileFile, starterProfile(name), { flag: 'wx' })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw fleetError('conflict', `${paths.profileFile} is already there; fleet init never overwrites a profile`, {
        cause,
      })
    }
    throw cause
  }
  return { profileFile: paths.profileFile }
}
