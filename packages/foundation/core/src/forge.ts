/**
 * Where a PR lives on a forge, as a link a person can open (TASK-94).
 *
 * GitHub is `<host>/<repo>/pull/N`; GitLab is `<host>/<repo>/-/merge_requests/N`,
 * and a GitLab repo may be a subgroup path (`group/sub/project`), so the repo is
 * used whole rather than split on its first slash. Pure string work, so both the
 * routines and the board can call it without importing each other (§1.1).
 */

/** The forge a fleet's repos live on: the profile's `forge` block, structurally. */
export interface ForgeRef {
  readonly kind: 'github' | 'gitlab'
  /** The forge's hostname. Absent means the public host (`github.com`, `gitlab.com`). */
  readonly host?: string
}

/** GitHub when no forge is named: what every fleet before the `forge` block was. */
export const pullRequestUrl = (forge: ForgeRef | undefined, repo: string, number: number): string => {
  const gitlab = forge?.kind === 'gitlab'
  const host = forge?.host ?? (gitlab ? 'gitlab.com' : 'github.com')
  const tail = gitlab ? `-/merge_requests/${String(number)}` : `pull/${String(number)}`
  return `https://${host}/${repo}/${tail}`
}
