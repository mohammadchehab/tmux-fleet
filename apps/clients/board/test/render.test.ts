/**
 * The page is a pure function of two daemon answers, so this is the whole of
 * what a browser would show: which rows, in which column, saying what.
 *
 * The escaping and the scheme checks are here because everything on the page is
 * a string the store held — a Work title is written by a peer, a tracker key by
 * a tracker — and a board that executed one of them would be a read-only board
 * that could still be made to do something.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderBoard, renderUnreachable } from '../src/render.ts'
import type { PeerId, WorkId } from '@fleet/foundation-core'

import { PEER, REPO, statusFixture, workFixture } from './fixtures.ts'

const AT = '2026-11-10T12:00:00.000Z'

const page = (work: Parameters<typeof renderBoard>[0]['work'], usage: Parameters<typeof renderBoard>[0]['usage'] = []): string =>
  renderBoard({ status: statusFixture(), work, usage, renderedAt: AT })

describe('board: the rows are the projection rows', () => {
  it('groups by state in the state machine order, not by arrival', () => {
    const html = page([
      workFixture({ workId: 'wrk_00000000000000a1', title: 'later', state: 'in_progress' }),
      workFixture({ workId: 'wrk_00000000000000a2', title: 'first', state: 'proposed' }),
    ])
    assert.ok(html.indexOf('<h2>proposed') < html.indexOf('<h2>in_progress'), 'proposed comes before in_progress')
    assert.match(html, /first/)
    assert.match(html, /later/)
  })

  it('leaves out a state that has no Work, rather than showing eleven empty columns', () => {
    const html = page([workFixture({ workId: 'wrk_00000000000000a1', state: 'blocked' })])
    assert.match(html, /<h2>blocked/)
    assert.doesNotMatch(html, /<h2>ready/)
    assert.doesNotMatch(html, /<h2>merged/)
  })

  it('renders every item, with no filter of its own', () => {
    const items = [
      workFixture({ workId: 'wrk_0000000000000001', state: 'proposed' }),
      workFixture({ workId: 'wrk_0000000000000002', state: 'proposed' }),
      workFixture({ workId: 'wrk_0000000000000003', state: 'cleaned' }),
    ]
    const html = page(items)
    for (const item of items) assert.match(html, new RegExp(item.workId))
    assert.match(html, /3 work items/)
  })

  it('counts one item in the singular', () => {
    assert.match(page([workFixture({ workId: 'wrk_0000000000000001' })]), /1 work item</)
  })

  it('says the board is empty instead of inventing a row', () => {
    const html = page([])
    assert.match(html, /No Work yet/)
    assert.doesNotMatch(html, /class="board"/)
  })
})

describe('board: a row says what a person needs to act on it', () => {
  it('names the assignee, the PR and the tracker key', () => {
    const html = page([
      workFixture({
        workId: 'wrk_0000000000000001',
        state: 'in_review',
        assignee: PEER,
        prs: [{ repo: REPO, number: 123 }],
        external: { system: 'jira', key: 'FLEET-7', url: 'https://jira.example.com/browse/FLEET-7' },
      }),
    ])
    assert.match(html, new RegExp(PEER))
    assert.match(html, /href="https:\/\/github.com\/mohammadchehab\/tmux-fleet\/pull\/123"/)
    assert.match(html, /mohammadchehab\/tmux-fleet#123/)
    assert.match(html, /href="https:\/\/jira.example.com\/browse\/FLEET-7"/)
    assert.match(html, /jira:FLEET-7/)
  })

  it('shows why a blocked Work is blocked', () => {
    const html = page([
      workFixture({ workId: 'wrk_0000000000000001', state: 'blocked', blockedReason: 'waiting on the architect' }),
    ])
    assert.match(html, /waiting on the architect/)
  })
})

describe('board: what a Work has cost', () => {
  const usage = (
    peer: string,
    workId: string | undefined,
    turns: number,
    costUsd: number,
  ): Parameters<typeof renderBoard>[0]['usage'][number] => ({
    peerId: peer as PeerId,
    role: 'engineer',
    ...(workId === undefined ? {} : { workId: workId as WorkId }),
    turns,
    inputTokens: turns * 1_000,
    outputTokens: turns * 100,
    cachedTokens: 0,
    costUsd,
    toolCalls: { grep: 0, glob: 0, read: 0, codegraph: 0 },
    redirects: 0,
    updatedAt: AT,
  })

  it('adds up every peer that worked on the Work, and only those', () => {
    const html = page(
      [workFixture({ workId: 'wrk_0000000000000001' }), workFixture({ workId: 'wrk_0000000000000002' })],
      [
        usage('engineer-1', 'wrk_0000000000000001', 5, 0.42),
        usage('engineer-2', 'wrk_0000000000000001', 3, 0.1),
        usage('engineer-1', 'wrk_0000000000000002', 1, 0.07),
        // The rollups are the fleet's bill; folding them into a Work would count
        // every turn twice.
        usage('engineer-1', undefined, 9, 0.59),
      ],
    )
    assert.match(html, /8 turns · in 8000 out 800 · \$0\.52/)
    assert.match(html, /1 turns · in 1000 out 100 · \$0\.07/)
    assert.match(html, /<span class="meta">\$0\.59 spent<\/span>/, 'the fleet total is the rollup')
  })

  it('leaves the line off a Work nothing has been recorded against', () => {
    const html = page([workFixture({ workId: 'wrk_0000000000000001' })], [usage('engineer-1', undefined, 9, 0.59)])
    assert.doesNotMatch(html, /class="cost"/, '$0.00 would claim the Work was free, not that it is unmeasured')
    assert.match(html, /\$0\.59 spent/)
  })
})

describe('board: everything it renders is escaped', () => {
  it('escapes a title rather than rendering it as markup', () => {
    const html = page([
      workFixture({ workId: 'wrk_0000000000000001', title: '<script>alert(1)</script>' }),
    ])
    assert.doesNotMatch(html, /<script>alert/)
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  })

  it('refuses a non-http tracker URL: a link, not an executable page', () => {
    const html = page([
      workFixture({
        workId: 'wrk_0000000000000001',
        external: { system: 'backlog', key: 'card.md', url: 'javascript:alert(1)' },
      }),
    ])
    assert.doesNotMatch(html, /javascript:/)
    assert.match(html, /backlog:card\.md/)
  })

  it('carries no script and loads nothing from elsewhere', () => {
    const html = page([workFixture({ workId: 'wrk_0000000000000001' })])
    assert.doesNotMatch(html, /<script/)
    assert.doesNotMatch(html, /\ssrc=/)
    assert.doesNotMatch(html, /https?:\/\/(?!github\.com\/mohammadchehab)/)
  })
})

describe('board: no daemon is a page too', () => {
  it('says which socket was not answering', () => {
    const html = renderUnreachable('/x/fleetd.sock', 'cannot reach fleetd at /x/fleetd.sock: connect ENOENT', AT)
    assert.match(html, /No fleetd answering/)
    assert.match(html, /connect ENOENT/)
    assert.match(html, /\/x\/fleetd.sock/)
  })
})
