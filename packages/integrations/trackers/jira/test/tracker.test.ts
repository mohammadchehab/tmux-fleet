/**
 * The `Tracker` port over Jira's REST API v3 (§3): which endpoint each call
 * hits, how both auth modes are sent, how each search flavor pages, and the
 * three places this adapter refuses to guess — an unmapped `WorkState`, a
 * transition the workflow does not offer, and an issue that is not there.
 *
 * `fetch` is a fake that records the request and answers from a table, so
 * nothing here authenticates or opens a socket. Everything under test — the URL,
 * the header, the paging, the mapping, the error — is the code that ships.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fixedClock, FleetError } from '@fleet/foundation-core'
import type { JiraAuth } from '../src/auth.ts'
import type { FetchLike } from '../src/client.ts'
import { createJiraTracker } from '../src/tracker.ts'

const BASE = 'https://acme.atlassian.net'
const OCTOBER = '2026-11-01T00:00:00.000Z'
const clock = fixedClock(OCTOBER)

const cloud: JiraAuth = { kind: 'cloud', email: 'fleet@acme.test', token: 's3cr3t' }
const pat: JiraAuth = { kind: 'pat', token: 's3cr3t' }

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

interface Reply {
  readonly status?: number
  readonly body?: unknown
}

/** A `fetch` that records every request and answers from `reply`, which may depend on the request. */
const fakeFetch = (reply: (call: Call) => Reply = () => ({ body: {} })) => {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Readonly<Record<string, string>>).map(([key, value]) => [key.toLowerCase(), value]),
    )
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    }
    calls.push(call)
    const answer = reply(call)
    const status = answer.status ?? 200
    const body = answer.body === undefined ? '' : JSON.stringify(answer.body)
    // 204 has no body at all, and `Response` refuses one — exactly like a real socket.
    const withBody = status === 204 || status === 304 ? null : body
    return new Response(withBody, { status, headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetch: fetchImpl }
}

const issue = (overrides: Readonly<Record<string, unknown>> = {}, fields: Readonly<Record<string, unknown>> = {}) => ({
  key: 'FLEET-1',
  fields: {
    summary: 'Add pagination to the list',
    status: { name: 'In Progress' },
    description: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Page the list.' }] }],
    },
    // Jira's offset spelling, not the fleet's `Z` one.
    updated: '2026-11-02T08:09:10.000+0000',
    ...fields,
  },
  ...overrides,
})

const searchPage = (issues: readonly unknown[], extra: Readonly<Record<string, unknown>> = {}) => ({ issues, ...extra })

const urlOf = (call: Call): URL => new URL(call.url)

/** The `FleetError` a call threw, or a failure naming what it threw instead. */
const threw = async (call: () => Promise<unknown>): Promise<FleetError> => {
  try {
    await call()
  } catch (thrown) {
    assert.ok(thrown instanceof FleetError, `expected a FleetError, got ${String(thrown)}`)
    return thrown
  }
  assert.fail('expected the call to throw')
}

describe('auth', () => {
  it('sends Cloud’s email and API token as HTTP basic, never in the URL', async () => {
    const fake = fakeFetch(() => ({ body: searchPage([]) }))
    await createJiraTracker({ baseUrl: BASE, auth: cloud, fetch: fake.fetch, clock }).pull('project = FLEET')

    assert.equal(fake.calls.length, 1)
    const call = fake.calls[0] as Call
    assert.equal(call.headers['authorization'], `Basic ${Buffer.from('fleet@acme.test:s3cr3t', 'utf8').toString('base64')}`)
    assert.equal(call.url.includes('s3cr3t'), false, 'the token must not reach the URL')
    assert.equal(call.url.includes('fleet@acme.test'), false, 'the email must not reach the URL')
  })

  it('sends a Server / Data Center PAT as a bearer token', async () => {
    const fake = fakeFetch(() => ({ body: searchPage([]) }))
    await createJiraTracker({ baseUrl: BASE, auth: pat, fetch: fake.fetch, clock }).pull('project = FLEET')

    assert.equal((fake.calls[0] as Call).headers['authorization'], 'Bearer s3cr3t')
  })

  it('refuses an empty credential when it is built, not on every request', () => {
    assert.throws(
      () => createJiraTracker({ baseUrl: BASE, auth: { kind: 'pat', token: '  ' }, fetch: fakeFetch().fetch }),
      (thrown: unknown) => thrown instanceof FleetError && thrown.code === 'invalid_input',
    )
    assert.throws(
      () => createJiraTracker({ baseUrl: BASE, auth: { kind: 'cloud', email: '', token: 'x' }, fetch: fakeFetch().fetch }),
      (thrown: unknown) => thrown instanceof FleetError && thrown.code === 'invalid_input',
    )
  })
})

describe('pull', () => {
  it('asks Cloud’s enhanced endpoint for the fields an item is made of', async () => {
    const fake = fakeFetch(() => ({ body: searchPage([issue()], { isLast: true }) }))
    const items = await createJiraTracker({ baseUrl: BASE, auth: cloud, fetch: fake.fetch, clock }).pull('project = FLEET')

    const call = fake.calls[0] as Call
    assert.equal(call.method, 'GET')
    assert.equal(urlOf(call).pathname, '/rest/api/3/search/jql')
    assert.equal(urlOf(call).searchParams.get('jql'), 'project = FLEET')
    assert.equal(urlOf(call).searchParams.get('fields'), 'summary,status,description,updated')
    assert.equal(urlOf(call).searchParams.get('maxResults'), '100')
    assert.equal(urlOf(call).searchParams.get('nextPageToken'), null, 'the first page asks for no token')

    assert.deepEqual(items, [
      {
        system: 'jira',
        key: 'FLEET-1',
        title: 'Add pagination to the list',
        body: 'Page the list.',
        status: 'In Progress',
        url: `${BASE}/browse/FLEET-1`,
        updatedAt: '2026-11-02T08:09:10.000Z',
      },
    ])
  })

  it('asks Server / Data Center’s classic endpoint, paging by offset', async () => {
    const fake = fakeFetch(() => ({ body: searchPage([issue()], { total: 1 }) }))
    await createJiraTracker({ baseUrl: BASE, auth: pat, fetch: fake.fetch, clock }).pull('project = FLEET')

    const call = fake.calls[0] as Call
    assert.equal(urlOf(call).pathname, '/rest/api/3/search')
    assert.equal(urlOf(call).searchParams.get('startAt'), '0')
    assert.equal(urlOf(call).searchParams.get('nextPageToken'), null)
  })

  it('follows nextPageToken until the endpoint says it is done', async () => {
    const fake = fakeFetch((call) =>
      urlOf(call).searchParams.get('nextPageToken') === null
        ? { body: searchPage([issue()], { nextPageToken: 'page-2' }) }
        : { body: searchPage([issue({ key: 'FLEET-2' })], { isLast: true }) },
    )
    const items = await createJiraTracker({ baseUrl: BASE, auth: cloud, fetch: fake.fetch, clock }).pull('project = FLEET')

    assert.equal(fake.calls.length, 2)
    assert.equal(urlOf(fake.calls[1] as Call).searchParams.get('nextPageToken'), 'page-2')
    assert.deepEqual(
      items.map((item) => item.key),
      ['FLEET-1', 'FLEET-2'],
    )
  })

  it('stops on a token it has already followed, rather than looping forever', async () => {
    const fake = fakeFetch(() => ({ body: searchPage([issue()], { nextPageToken: 'same-token' }) }))
    const items = await createJiraTracker({ baseUrl: BASE, auth: cloud, fetch: fake.fetch, clock }).pull('project = FLEET')

    // Two pages: the first names the token, the second names the token it was given.
    assert.equal(fake.calls.length, 2)
    assert.equal(items.length, 2)
  })

  it('pages the classic endpoint until startAt reaches total', async () => {
    const fake = fakeFetch((call) =>
      urlOf(call).searchParams.get('startAt') === '0'
        ? { body: searchPage([issue()], { total: 2 }) }
        : { body: searchPage([issue({ key: 'FLEET-2' })], { total: 2 }) },
    )
    const items = await createJiraTracker({ baseUrl: BASE, auth: pat, fetch: fake.fetch, clock, pageSize: 1 }).pull('project = FLEET')

    assert.equal(fake.calls.length, 2)
    assert.equal(urlOf(fake.calls[1] as Call).searchParams.get('startAt'), '1')
    assert.deepEqual(
      items.map((item) => item.key),
      ['FLEET-1', 'FLEET-2'],
    )
  })

  it('refuses an issue with no summary rather than proposing an untitled Work', async () => {
    const fake = fakeFetch(() => ({ body: searchPage([issue({}, { summary: undefined })], { isLast: true }) }))
    const error = await threw(() =>
      createJiraTracker({ baseUrl: BASE, auth: cloud, fetch: fake.fetch, clock }).pull('project = FLEET'),
    )

    assert.equal(error.code, 'external_failed')
    assert.match(error.message, /without a key or a summary/)
  })
})

describe('get', () => {
  it('reads one issue, body and all', async () => {
    const fake = fakeFetch(() => ({ body: issue() }))
    const item = await createJiraTracker({ baseUrl: BASE, auth: cloud, fetch: fake.fetch, clock }).get('FLEET-1')

    assert.equal(urlOf(fake.calls[0] as Call).pathname, '/rest/api/3/issue/FLEET-1')
    assert.equal(item?.key, 'FLEET-1')
    assert.equal(item?.body, 'Page the list.')
  })

  it('answers undefined for a missing issue', async () => {
    const fake = fakeFetch(() => ({ status: 404, body: { errorMessages: ['Issue does not exist'] } }))
    const item = await createJiraTracker({ baseUrl: BASE, auth: cloud, fetch: fake.fetch, clock }).get('FLEET-404')

    assert.equal(item, undefined)
  })

  it('throws for a site that failed, so a broken board never reads as a deleted one', async () => {
    const fake = fakeFetch(() => ({ status: 500, body: { errorMessages: ['boom'] } }))
    const error = await threw(() =>
      createJiraTracker({ baseUrl: BASE, auth: cloud, fetch: fake.fetch, clock }).get('FLEET-1'),
    )

    assert.equal(error.code, 'external_failed')
    assert.equal(error.details?.['status'], 500)
    assert.equal(error.message.includes('s3cr3t'), false, 'an error is read by people; the token is not for them')
  })
})

describe('transition', () => {
  const transitions = {
    transitions: [
      { id: '11', name: 'Start work', to: { name: 'In Progress' } },
      { id: '21', name: 'Done', to: { name: 'Done' } },
    ],
  }

  it('sends nothing for a state the profile did not map', async () => {
    const fake = fakeFetch()
    await createJiraTracker({
      baseUrl: BASE,
      auth: cloud,
      fetch: fake.fetch,
      clock,
      statuses: { in_progress: 'In Progress' },
    }).transition('FLEET-1', 'merged')

    assert.equal(fake.calls.length, 0, 'an unmapped state must not touch the board')
  })

  it('matches where the transition lands, not what the workflow calls the step', async () => {
    const fake = fakeFetch((call) => (call.method === 'GET' ? { body: transitions } : { status: 204 }))
    await createJiraTracker({
      baseUrl: BASE,
      auth: cloud,
      fetch: fake.fetch,
      clock,
      statuses: { in_progress: 'In Progress' },
    }).transition('FLEET-1', 'in_progress')

    assert.deepEqual(
      fake.calls.map((call) => [call.method, urlOf(call).pathname]),
      [
        ['GET', '/rest/api/3/issue/FLEET-1/transitions'],
        ['POST', '/rest/api/3/issue/FLEET-1/transitions'],
      ],
    )
    assert.deepEqual(fake.calls[1]?.body, { transition: { id: '11' } })
  })

  it('refuses a state the workflow does not offer, naming what it does', async () => {
    const fake = fakeFetch(() => ({ body: transitions }))
    const error = await threw(() =>
      createJiraTracker({
        baseUrl: BASE,
        auth: cloud,
        fetch: fake.fetch,
        clock,
        statuses: { in_progress: 'Doing' },
      }).transition('FLEET-1', 'in_progress'),
    )

    assert.equal(error.code, 'external_failed')
    assert.match(error.message, /cannot move to "Doing"/)
    assert.match(error.message, /In Progress, Done/)
    assert.equal(fake.calls.filter((call) => call.method === 'POST').length, 0)
  })
})

describe('link', () => {
  it('records the pull request once, keyed by its URL', async () => {
    const prUrl = 'https://github.com/acme/fleet/pull/7'
    const fake = fakeFetch((call) => (call.method === 'POST' ? { status: 201, body: { id: 41 } } : {}))
    await createJiraTracker({ baseUrl: BASE, auth: cloud, fetch: fake.fetch, clock }).link('FLEET-1', prUrl)

    const call = fake.calls[0] as Call
    assert.equal(call.method, 'POST')
    assert.equal(urlOf(call).pathname, '/rest/api/3/issue/FLEET-1/remotelink')
    // `globalId` is what makes a second `link` an update instead of a second link.
    assert.deepEqual(call.body, {
      globalId: prUrl,
      relationship: 'is implemented by',
      object: { url: prUrl, title: 'Pull request' },
    })
  })

  it('refuses to link a pull request to an issue that is not there', async () => {
    const fake = fakeFetch(() => ({ status: 404, body: {} }))
    const error = await threw(() =>
      createJiraTracker({ baseUrl: BASE, auth: cloud, fetch: fake.fetch, clock }).link('FLEET-404', 'https://github.com/acme/fleet/pull/7'),
    )

    assert.equal(error.code, 'external_failed')
    assert.match(error.message, /jira has no issue FLEET-404/)
  })
})

describe('comment', () => {
  const commentPage = (bodies: readonly string[]): unknown => ({
    comments: bodies.map((text) => ({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } })),
  })

  it('posts the note as ADF, one paragraph per line', async () => {
    const fake = fakeFetch((call) => (call.method === 'GET' ? { body: commentPage([]) } : { status: 201, body: { id: 88 } }))

    await createJiraTracker({ baseUrl: BASE, auth: cloud, fetch: fake.fetch, clock }).comment('FLEET-1', 'implement: the fix is pushed')

    const post = fake.calls.find((call) => call.method === 'POST') as Call
    assert.equal(urlOf(post).pathname, '/rest/api/3/issue/FLEET-1/comment')
    assert.deepEqual(post.body, {
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'implement: the fix is pushed' }] }] },
    })
  })

  it('is idempotent: a note the issue already carries is not posted twice', async () => {
    const fake = fakeFetch(() => ({ body: commentPage(['plan: read the adapter']) }))

    await createJiraTracker({ baseUrl: BASE, auth: cloud, fetch: fake.fetch, clock }).comment('FLEET-1', 'plan: read the adapter')

    assert.equal(fake.calls.filter((call) => call.method === 'POST').length, 0, 'the note is already there')
  })

  it('posts a note the issue does not carry, even when the issue carries others', async () => {
    const fake = fakeFetch((call) => (call.method === 'GET' ? { body: commentPage(['plan: read the adapter']) } : { status: 201, body: {} }))

    await createJiraTracker({ baseUrl: BASE, auth: cloud, fetch: fake.fetch, clock }).comment('FLEET-1', 'mr: https://github.com/acme/fleet/pull/7')

    assert.equal(fake.calls.filter((call) => call.method === 'POST').length, 1)
  })

  it('refuses to comment on an issue that is not there', async () => {
    const fake = fakeFetch((call) => (call.method === 'GET' ? { status: 404, body: {} } : {}))
    const error = await threw(() =>
      createJiraTracker({ baseUrl: BASE, auth: cloud, fetch: fake.fetch, clock }).comment('FLEET-404', 'plan: anything'),
    )

    assert.equal(error.code, 'external_failed')
  })
})
