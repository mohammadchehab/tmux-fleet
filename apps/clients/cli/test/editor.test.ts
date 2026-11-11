/**
 * `fleet editor install|uninstall` (§8) and the line `fleet up` adds.
 *
 * The filesystem is faked with a set of paths, so a test can say "a code on the
 * path and one vscode server" without owning either, and the editor CLIs are a
 * recorded argv list rather than a process.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EXTENSION_ID,
  editorCommands,
  editorHosts,
  editorsMissingExtension,
  findVsix,
  installEditor,
  installedIn,
  nodeEditorDeps,
  uninstallEditor,
  whichBin,
  type EditorDeps,
} from '../src/editor.ts'

const HOME = '/home/tester'

interface Fake {
  readonly deps: EditorDeps
  readonly ran: (readonly string[])[]
  readonly dirs: Map<string, readonly string[]>
  readonly files: Set<string>
}

const fake = (options: {
  files?: readonly string[]
  dirs?: Record<string, readonly string[]>
  home?: string
  path?: string
  failOn?: string
} = {}): Fake => {
  const files = new Set(options.files ?? [])
  const dirs = new Map(Object.entries(options.dirs ?? {}))
  const ran: (readonly string[])[] = []

  const deps: EditorDeps = {
    home: options.home ?? HOME,
    exists: (path) => files.has(path),
    readdir: async (path) => {
      const entries = dirs.get(path)
      if (entries === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return entries
    },
    pathValue: options.path ?? '/usr/local/bin:/usr/bin',
    run: async (argv) => {
      ran.push(argv)
      return { ok: options.failOn === undefined || !argv[0]?.includes(options.failOn), output: 'ok' }
    },
  }

  return { deps, ran, dirs, files }
}

describe('whichBin', () => {
  it('finds the first executable on PATH and nothing when it is absent', () => {
    const files = new Set(['/usr/local/bin/code', '/usr/bin/code'])
    assert.equal(whichBin('code', '/usr/local/bin:/usr/bin', (p) => files.has(p)), '/usr/local/bin/code')
    assert.equal(whichBin('cursor', '/usr/local/bin:/usr/bin', (p) => files.has(p)), undefined)
  })

  it('skips empty PATH entries rather than looking in the working directory', () => {
    const files = new Set(['/usr/bin/code'])
    assert.equal(whichBin('code', ':/usr/bin', (p) => files.has(p)), '/usr/bin/code')
  })
})

describe('editorHosts', () => {
  it('finds a local editor and both server layouts', async () => {
    const { deps } = fake({
      files: [
        '/usr/local/bin/code',
        `${HOME}/.vscode-server/cli/servers/Stable-abc/server/bin/code-server`,
        `${HOME}/.cursor-server/bin/linux-x64/def/bin/cursor-server`,
      ],
      dirs: {
        [`${HOME}/.vscode-server/cli/servers`]: ['Stable-abc'],
        [`${HOME}/.cursor-server/bin`]: ['linux-x64'],
        [`${HOME}/.cursor-server/bin/linux-x64`]: ['def'],
      },
    })

    const hosts = await editorHosts(deps)
    assert.deepEqual(
      hosts.map((host) => [host.name, host.kind]),
      [
        ['code', 'local'],
        ['vscode-server', 'server'],
        ['cursor-server', 'server'],
      ],
    )
    assert.equal(hosts[1]?.extensionsDir, `${HOME}/.vscode-server/extensions`)
  })

  it('says nothing about an editor that is not on this machine', async () => {
    const { deps } = fake()
    assert.deepEqual(await editorHosts(deps), [])
  })
})

describe('installed', () => {
  it('is the extensions entry for this extension, at any version', async () => {
    const { deps } = fake({
      files: ['/usr/local/bin/code'],
      dirs: { [`${HOME}/.vscode/extensions`]: ['tmux-fleet.fleet-editor-0.0.0', 'someone-else.thing-1.0.0'] },
    })
    const [host] = await editorHosts(deps)
    assert.ok(host !== undefined)
    assert.equal(await installedIn(deps, host), true)
  })

  it('missing is the hosts without it, one line per editor', async () => {
    const { deps } = fake({
      files: [
        '/usr/local/bin/code',
        `${HOME}/.vscode-server/cli/servers/Stable-abc/server/bin/code-server`,
        `${HOME}/.vscode-server/cli/servers/Stable-def/server/bin/code-server`,
      ],
      dirs: {
        [`${HOME}/.vscode/extensions`]: ['tmux-fleet.fleet-editor-0.0.0'],
        [`${HOME}/.vscode-server/cli/servers`]: ['Stable-abc', 'Stable-def'],
      },
    })
    assert.deepEqual(await editorsMissingExtension(deps), ['vscode-server'])
  })
})

describe('the packaged extension', () => {
  it('is the newest build output when none is named', async () => {
    const { deps } = fake({
      files: ['/build/fleet-editor-0.0.1.vsix'],
      dirs: { '/build': ['fleet-editor-0.0.0.vsix', 'fleet-editor-0.0.1.vsix', 'notes.txt'] },
    })
    assert.equal(await findVsix({ ...deps, vsixDir: '/build' }, undefined), '/build/fleet-editor-0.0.1.vsix')
  })

  it('is the one named, and refuses a path that is not there', async () => {
    const { deps } = fake({ files: ['/tmp/x.vsix'] })
    assert.equal(await findVsix(deps, '/tmp/x.vsix'), '/tmp/x.vsix')
    assert.equal(await findVsix(deps, '/tmp/gone.vsix'), undefined)
  })

  it('when there is none, install says how to build one instead of failing obscurely', async () => {
    const { deps } = fake({ dirs: {} })
    await assert.rejects(
      async () => editorCommands({ ...deps, vsixDir: '/build' }).install(undefined),
      /no \.vsix to install/,
    )
  })
})

describe('install and uninstall', () => {
  const hosts = (): Fake =>
    fake({
      files: [
        '/usr/local/bin/code',
        '/usr/local/bin/cursor',
        `${HOME}/.vscode-server/cli/servers/Stable-abc/server/bin/code-server`,
      ],
      dirs: {
        [`${HOME}/.vscode-server/cli/servers`]: ['Stable-abc'],
        [`${HOME}/.vscode/extensions`]: ['tmux-fleet.fleet-editor-0.0.0'],
      },
    })

  it('installs into every host with --force, because the usual case is an upgrade', async () => {
    const { deps, ran } = hosts()
    const report = await installEditor(deps, '/build/x.vsix')

    assert.deepEqual(ran, [
      ['/usr/local/bin/code', '--install-extension', '/build/x.vsix', '--force'],
      ['/usr/local/bin/cursor', '--install-extension', '/build/x.vsix', '--force'],
      [`${HOME}/.vscode-server/cli/servers/Stable-abc/server/bin/code-server`, '--install-extension', '/build/x.vsix', '--force'],
    ])
    assert.equal(report.succeeded, 3)
  })

  it('reports a host that refused, and counts the ones that did not', async () => {
    const { deps } = fake({
      files: ['/usr/local/bin/code', '/usr/local/bin/cursor'],
      failOn: 'cursor',
    })
    const report = await installEditor(deps, '/build/x.vsix')
    assert.equal(report.succeeded, 1)
    assert.match(report.lines.join('\n'), /failed in cursor/)
  })

  it('uninstalls only where it is installed, by extension id', async () => {
    const { deps, ran } = hosts()
    const report = await uninstallEditor(deps)

    assert.deepEqual(ran, [['/usr/local/bin/code', '--uninstall-extension', EXTENSION_ID]])
    assert.match(report.lines.join('\n'), /not installed in cursor/)
    assert.match(report.lines.join('\n'), /removed from code/)
  })

  it('says so when there is no editor to install into at all', async () => {
    const { deps } = fake({ files: ['/build/x.vsix'] })
    await assert.rejects(async () => editorCommands(deps).install('/build/x.vsix'), /no editor was found/)
  })
})

describe('nodeEditorDeps', () => {
  it('answers with the real process defaults unless a test overrides them', async () => {
    const deps = await nodeEditorDeps({ home: '/x', pathValue: '' })
    assert.equal(deps.home, '/x')
    assert.equal(await deps.readdir('/definitely-not-a-directory').catch(() => 'enoent'), 'enoent')
  })
})
