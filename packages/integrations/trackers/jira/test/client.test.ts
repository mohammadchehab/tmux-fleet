/**
 * The rules `client.ts` exists to keep in one place (§3): the credential travels
 * as a header and nowhere else, the site is https and does not redirect, a body
 * is read against a bound, and an external body never reaches the event log
 * carrying a newline or an escape sequence.
 *
 * `fetch` is a fake here too, so the file proves what the adapter *sends* and
 * what it *refuses* without a socket.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FleetError } from '@fleet/foundation-core'
import type { JiraAuth } from '../src/auth.ts'
import { createJiraClient, type FetchLike } from '../src/client.ts'

const BASE = 'https://acme.atlassian.net'
const pat: JiraAuth = { kind: 'pat', token: 's3cr3t' }

interface Call {
  readonly url: string
  readonly method: string
  readonly redirect: RequestInit['redirect']
  readonly headers: Readonly<Record<string, string>>
}

/** A `fetch` that records the request and answers with `body` at `status`. */
const fakeFetch = (body = '{}', status = 200) => {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      redirect: init.redirect,
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Readonly<Record<string, string>>).map(([k, v]) => [k.toLowerCase(), v])),
    })
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetch: fetchImpl }
}

const get = { method: 'GET', path: '/rest/api/3/myself' } as const

describe('the jira client refuses a site it cannot trust', () => {
  it('wants https', () => {
    assert.throws(
      () => createJiraClient({ baseUrl: 'http://acme.atlassian.net', auth: pat, fetch: fakeFetch().fetch }),
      (thrown: unknown) => thrown instanceof FleetError && thrown.code === 'invalid_input' && /must be https/.test(thrown.message),
    )
  })

  it('allows http only when the local install is named as one', () => {
    const client = createJiraClient({ baseUrl: 'http://localhost:8080', auth: pat, fetch: fakeFetch().fetch, allowInsecureHttp: true })
    assert.equal(typeof client.send, 'function')
  })

  it('refuses a base URL that carries a credential of its own', () => {
    assert.throws(
      () => createJiraClient({ baseUrl: 'https://user:pw@acme.atlassian.net', auth: pat, fetch: fakeFetch().fetch }),
      (thrown: unknown) => thrown instanceof FleetError && /must not carry a username or password/.test(thrown.message),
    )
  })

  it('refuses a base URL that already has a query, which a path would land inside', () => {
    assert.throws(
      () => createJiraClient({ baseUrl: 'https://acme.atlassian.net?x=1', auth: pat, fetch: fakeFetch().fetch }),
      (thrown: unknown) => thrown instanceof FleetError && /must not carry a query/.test(thrown.message),
    )
  })

  it('refuses something that is not a URL at all', () => {
    assert.throws(
      () => createJiraClient({ baseUrl: 'acme.atlassian.net', auth: pat, fetch: fakeFetch().fetch }),
      (thrown: unknown) => thrown instanceof FleetError && thrown.code === 'invalid_input',
    )
  })
})

describe('the jira client sends the credential as a header and nowhere else', () => {
  it('keeps it out of the URL', async () => {
    const fake = fakeFetch()
    await createJiraClient({ baseUrl: BASE, auth: pat, fetch: fake.fetch }).send({ ...get, query: { jql: 'project = FLEET' } })
    const call = fake.calls[0] as Call
    assert.equal(call.url, `${BASE}/rest/api/3/myself?jql=project%20%3D%20FLEET`)
    assert.equal(call.url.includes('s3cr3t'), false)
    assert.equal(call.headers['authorization'], 'Bearer s3cr3t')
  })

  it('keeps a Server/DC context path rather than reducing the site to its origin', async () => {
    const fake = fakeFetch()
    await createJiraClient({ baseUrl: 'https://host.example/jira/', auth: pat, fetch: fake.fetch }).send(get)
    assert.equal((fake.calls[0] as Call).url, 'https://host.example/jira/rest/api/3/myself')
  })

  it('refuses to follow a redirect, which would replay the header elsewhere', async () => {
    const fake = fakeFetch()
    await createJiraClient({ baseUrl: BASE, auth: pat, fetch: fake.fetch }).send(get)
    assert.equal((fake.calls[0] as Call).redirect, 'error')
  })
})

describe('an external body is bounded and never breaks a log line', () => {
  it('cuts a failed body to a snippet on one line', async () => {
    const body = `{\n  "errorMessages": ["no such project"]\n}\u001b[31m forged\nsecond line`
    const client = createJiraClient({ baseUrl: BASE, auth: pat, fetch: fakeFetch(body, 400).fetch })
    await assert.rejects(
      () => client.json(get),
      (thrown: unknown) => {
        assert.ok(thrown instanceof FleetError)
        assert.equal(thrown.code, 'external_failed')
        assert.match(thrown.message, /^jira GET \/rest\/api\/3\/myself answered 400: /)
        assert.equal(thrown.message.includes('\n'), false)
        assert.equal(thrown.message.includes('\u001b'), false)
        return true
      },
    )
  })

  it('refuses a successful body past the bound instead of buffering it', async () => {
    const client = createJiraClient({ baseUrl: BASE, auth: pat, fetch: fakeFetch('{"a":1}').fetch, maxBodyBytes: 4 })
    await assert.rejects(
      () => client.json(get),
      (thrown: unknown) => thrown instanceof FleetError && /answered more than 4 bytes/.test(thrown.message),
    )
  })

  it('reads a body that sits exactly under the bound', async () => {
    const body = '{"a":1}'
    const client = createJiraClient({ baseUrl: BASE, auth: pat, fetch: fakeFetch(body).fetch, maxBodyBytes: body.length })
    assert.deepEqual(await client.json(get), { a: 1 })
  })
})
