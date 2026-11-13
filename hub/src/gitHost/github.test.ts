import { afterEach, describe, expect, it } from 'bun:test'
import { createPull, findPullByHead, getPull, rollUpChecks } from './github'
import type { GitHostTarget } from './types'

const TARGET: GitHostTarget = {
    kind: 'github',
    apiBase: 'https://api.github.com',
    host: 'github.com',
    owner: 'acme',
    repo: 'widget',
    token: 'tok'
}

const originalFetch = globalThis.fetch

afterEach(() => {
    globalThis.fetch = originalFetch
})

type Route = { status: number; body: unknown }

/** Route table keyed by a substring of the request URL, in insertion order. */
function stubFetch(routes: Array<[string, Route]>): { calls: Array<{ url: string; method: string; body: unknown }> } {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        calls.push({
            url,
            method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : null
        })
        const route = routes.find(([needle]) => url.includes(needle))
        if (!route) throw new Error(`No stub for ${url}`)
        return new Response(JSON.stringify(route[1].body), {
            status: route[1].status,
            headers: { 'content-type': 'application/json' }
        })
    }) as typeof fetch
    return { calls }
}

const OPEN_PULL = {
    number: 42,
    html_url: 'https://github.com/acme/widget/pull/42',
    title: 'Fix the parser',
    state: 'open',
    draft: false,
    mergeable: true,
    head: { ref: 'hapi/fix', sha: 'abc123' },
    base: { ref: 'main' }
}

describe('rollUpChecks', () => {
    it('reports none when there are no runs', () => {
        expect(rollUpChecks([])).toBe('none')
    })

    it('lets a failure outrank anything still running', () => {
        expect(rollUpChecks([
            { status: 'in_progress' },
            { status: 'completed', conclusion: 'failure' }
        ])).toBe('failing')
    })

    it('reports pending while any run is unfinished', () => {
        expect(rollUpChecks([
            { status: 'completed', conclusion: 'success' },
            { status: 'queued' }
        ])).toBe('pending')
    })

    it('counts timed out and cancelled as failures', () => {
        expect(rollUpChecks([{ status: 'completed', conclusion: 'timed_out' }])).toBe('failing')
        expect(rollUpChecks([{ status: 'completed', conclusion: 'cancelled' }])).toBe('failing')
    })

    it('treats skipped and neutral as non-blocking', () => {
        expect(rollUpChecks([
            { status: 'completed', conclusion: 'skipped' },
            { status: 'completed', conclusion: 'neutral' },
            { status: 'completed', conclusion: 'success' }
        ])).toBe('passing')
    })
})

describe('createPull', () => {
    it('opens a pull request and rolls its checks up', async () => {
        const { calls } = stubFetch([
            ['/pulls', { status: 201, body: OPEN_PULL }],
            ['/check-runs', { status: 200, body: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }]
        ])

        const result = await createPull(TARGET, {
            title: 'Fix the parser',
            body: 'body',
            headBranch: 'hapi/fix',
            baseBranch: 'main',
            draft: false
        })

        expect(result.outcome).toBe('ok')
        if (result.outcome !== 'ok') return
        expect(result.value).toMatchObject({
            url: 'https://github.com/acme/widget/pull/42',
            number: 42,
            state: 'open',
            headBranch: 'hapi/fix',
            baseBranch: 'main',
            mergeable: true,
            checks: 'passing'
        })
        expect(calls[0].body).toMatchObject({ head: 'hapi/fix', base: 'main', draft: false })
    })

    it('surfaces an existing pull request instead of failing on the 422', async () => {
        stubFetch([
            // Order matters: the list query also contains "/pulls".
            ['/pulls?state=all', { status: 200, body: [OPEN_PULL] }],
            ['/pulls', { status: 422, body: { message: 'A pull request already exists for acme:hapi/fix.' } }],
            ['/check-runs', { status: 200, body: { check_runs: [] } }]
        ])

        const result = await createPull(TARGET, {
            title: 't', body: 'b', headBranch: 'hapi/fix', baseBranch: 'main', draft: false
        })

        expect(result.outcome).toBe('already-exists')
        if (result.outcome !== 'already-exists') return
        expect(result.url).toBe('https://github.com/acme/widget/pull/42')
    })

    it('classifies an expired token', async () => {
        stubFetch([['/pulls', { status: 401, body: { message: 'Bad credentials' } }]])
        const result = await createPull(TARGET, {
            title: 't', body: 'b', headBranch: 'b', baseBranch: 'main', draft: false
        })
        expect(result).toEqual({ outcome: 'unauthorized', message: 'Bad credentials' })
    })

    it('reports a network failure without throwing', async () => {
        globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
        const result = await createPull(TARGET, {
            title: 't', body: 'b', headBranch: 'b', baseBranch: 'main', draft: false
        })
        expect(result).toEqual({ outcome: 'network-error', message: 'ECONNREFUSED' })
    })
})

describe('getPull', () => {
    it('reads merged state off merged_at, not the state field', async () => {
        stubFetch([
            ['/pulls/42', { status: 200, body: { ...OPEN_PULL, state: 'closed', merged_at: '2026-01-01T00:00:00Z' } }],
            ['/check-runs', { status: 200, body: { check_runs: [] } }]
        ])

        const result = await getPull(TARGET, 42)
        expect(result.outcome).toBe('ok')
        if (result.outcome !== 'ok') return
        expect(result.value.state).toBe('merged')
        expect(result.value.checks).toBe('none')
    })

    it('keeps a null mergeable rather than inventing false', async () => {
        stubFetch([
            ['/pulls/42', { status: 200, body: { ...OPEN_PULL, mergeable: null } }],
            ['/check-runs', { status: 200, body: { check_runs: [] } }]
        ])

        const result = await getPull(TARGET, 42)
        if (result.outcome !== 'ok') throw new Error('expected ok')
        expect(result.value.mergeable).toBeNull()
    })

    it('does not fail the pull request when the checks call is refused', async () => {
        stubFetch([
            ['/pulls/42', { status: 200, body: OPEN_PULL }],
            ['/check-runs', { status: 403, body: { message: 'Resource not accessible' } }]
        ])

        const result = await getPull(TARGET, 42)
        expect(result.outcome).toBe('ok')
        if (result.outcome !== 'ok') return
        expect(result.value.checks).toBeNull()
    })
})

describe('findPullByHead', () => {
    it('qualifies the head with the owner', async () => {
        const { calls } = stubFetch([
            ['/pulls?state=all', { status: 200, body: [OPEN_PULL] }],
            ['/check-runs', { status: 200, body: { check_runs: [] } }]
        ])

        await findPullByHead(TARGET, 'hapi/fix')
        expect(calls[0].url).toContain(encodeURIComponent('acme:hapi/fix'))
    })

    it('reports not-found for a branch with no pull request', async () => {
        stubFetch([['/pulls?state=all', { status: 200, body: [] }]])
        const result = await findPullByHead(TARGET, 'hapi/none')
        expect(result.outcome).toBe('not-found')
    })
})
