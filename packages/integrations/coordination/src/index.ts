/**
 * Coordination transport via git (shared fleets, architecture §2, §9).
 * Implements the Coordination port over `git` and `gh` for atomic operations.
 */

import { execFileSync } from 'node:child_process'
import type { Coordination, GitRef } from '@fleet/foundation-contracts'
import type { Repo, Sha } from '@fleet/foundation-core'

/** Execute a git command and return stdout, or throw on failure. */
const git = (cwd: string, ...args: readonly string[]): string => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch (e) {
    throw new Error(`git failed: git -C ${cwd} ${args.join(' ')}\n${String(e)}`)
  }
}

/** Execute a gh command and return stdout, or throw on failure. */
const gh = (...args: readonly string[]): string => {
  try {
    return execFileSync('gh', [...args], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    throw new Error(`gh failed: gh ${args.join(' ')}\n${String(e)}`)
  }
}

/**
 * Create a Coordination transport implementation using git and gh.
 * All writes are protected: `expectedSha` is verified before committing.
 */
export const createCoordination = (): Coordination => ({
  async listRefs(repo: Repo): Promise<readonly GitRef[]> {
    try {
      const output = gh('ls-remote', '--heads', '--tags', repo)
      return output
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const [sha, ...rest] = line.split('\t')
          const name = rest.join('\t')
          return { sha: sha as Sha, name }
        })
    } catch (e) {
      throw new Error(`Failed to list refs in ${repo}: ${String(e)}`)
    }
  },

  async fetch(input: { readonly repo: Repo; readonly cwd: string; readonly ref: string }): Promise<Sha> {
    try {
      git(input.cwd, 'fetch', '--depth=1', 'origin', input.ref)
      const sha = git(input.cwd, 'rev-parse', 'FETCH_HEAD')
      git(input.cwd, 'update-ref', `refs/heads/_coord_${input.ref.replace(/\//g, '_')}`, sha)
      return sha as Sha
    } catch (e) {
      throw new Error(`Failed to fetch ${input.ref} from ${input.repo}: ${String(e)}`)
    }
  },

  async push(input: {
    readonly repo: Repo
    readonly cwd: string
    readonly branch: string
    readonly message: string
    readonly expectedSha?: Sha
  }): Promise<Sha> {
    try {
      const currentSha = git(input.cwd, 'rev-parse', 'HEAD')
      if (input.expectedSha && currentSha !== input.expectedSha) {
        throw new Error(
          `HEAD has moved: expected ${input.expectedSha}, but got ${currentSha}. ` +
            `This machine may have been offline and another fleet may have pushed to this branch.`,
        )
      }
      git(input.cwd, 'commit', '--allow-empty', '-m', input.message)
      const newSha = git(input.cwd, 'rev-parse', 'HEAD')
      git(input.cwd, 'push', 'origin', `HEAD:refs/heads/${input.branch}`)
      return newSha as Sha
    } catch (e) {
      throw new Error(`Failed to push to ${input.branch} in ${input.repo}: ${String(e)}`)
    }
  },

  async createRef(input: {
    readonly repo: Repo
    readonly ref: string
    readonly message: string
  }): Promise<Sha> {
    try {
      const output = gh('api', `repos/${input.repo}/git/refs`, '-f', 'ref=' + input.ref, '-f', 'sha=HEAD')
      const result = JSON.parse(output) as { object: { sha: string } }
      return result.object.sha as Sha
    } catch (e) {
      const error = String(e)
      if (error.includes('already exists') || error.includes('Reference already exists')) {
        throw new Error(`Ref ${input.ref} already exists (another fleet claimed it first)`)
      }
      throw new Error(`Failed to create ref ${input.ref} in ${input.repo}: ${error}`)
    }
  },

  async deleteRef(input: {
    readonly repo: Repo
    readonly ref: string
    readonly expectedSha: Sha
  }): Promise<void> {
    try {
      const refs = await this.listRefs(input.repo)
      const existing = refs.find((r) => r.name === input.ref)
      if (!existing) {
        throw new Error(`Ref ${input.ref} does not exist`)
      }
      if (existing.sha !== input.expectedSha) {
        throw new Error(
          `Ref ${input.ref} has moved: expected ${input.expectedSha}, but found ${existing.sha}. ` +
            `This claim may belong to another fleet now.`,
        )
      }
      gh('api', '-X', 'DELETE', `repos/${input.repo}/git/refs/${input.ref}`)
    } catch (e) {
      throw new Error(`Failed to delete ref ${input.ref} in ${input.repo}: ${String(e)}`)
    }
  },

  async readEngagementKey(input: {
    readonly repo: Repo
    readonly engagement: string
    readonly peerId: string
  }): Promise<{ readonly encrypted: string; readonly sha: Sha } | undefined> {
    try {
      const path = `keys/${input.engagement}/${input.peerId}.age`
      const output = gh('api', `repos/${input.repo}/contents/${path}`)
      const data = JSON.parse(output) as { content?: string; sha: string }
      if (!data.content) return undefined
      const encrypted = Buffer.from(data.content, 'base64').toString('utf-8')
      return { encrypted, sha: data.sha as Sha }
    } catch {
      return undefined
    }
  },

  async writeEngagementKey(input: {
    readonly repo: Repo
    readonly engagement: string
    readonly peerId: string
    readonly encrypted: string
    readonly message: string
    readonly expectedSha?: Sha
  }): Promise<Sha> {
    try {
      const path = `keys/${input.engagement}/${input.peerId}.age`
      const content = Buffer.from(input.encrypted).toString('base64')
      const payload = {
        message: input.message,
        content,
        ...(input.expectedSha ? { sha: input.expectedSha } : {}),
      }
      const output = gh('api', `repos/${input.repo}/contents/${path}`, ...Object.entries(payload).flatMap(([k, v]) => ['-f', `${k}=${String(v)}`]))
      const result = JSON.parse(output) as { commit: { sha: string } }
      return result.commit.sha as Sha
    } catch (e) {
      throw new Error(`Failed to write engagement key for ${input.peerId} in ${input.repo}: ${String(e)}`)
    }
  },
})
