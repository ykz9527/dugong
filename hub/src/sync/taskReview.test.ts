import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { TaskPullRequest } from '@hapi/protocol'
import { Store } from '../store'
import type { StoredTask } from '../store'
import {
    TaskReviewService,
    buildPullBody,
    parsePullRequestUrl,
    shellQuote,
    type RunCommand
} from './taskReview'

let store: Store
let service: TaskReviewService
let commands: Array<{ sessionId: string; command: string; cwd?: string }>
let commandImpl: RunCommand
let tokens: Record<string, string> | undefined
let published: StoredTask[]

const originalFetch = globalThis.fetch

const OPEN_PULL = {
    number: 7,
    html_url: 'https://github.com/acme/widget/pull/7',
    title: 'Fix the parser',
    state: 'open',
    draft: false,
    mergeable: true,
    head: { ref: 'hapi/fix', sha: 'abc' },
    base: { ref: 'main' }
}

function stubFetch(routes: Array<[string, { status: number; body: unknown }]>): void {
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString()
        const route = routes.find(([needle]) => url.includes(needle))
        if (!route) throw new Error(`No stub for ${url}`)
        return new Response(JSON.stringify(route[1].body), {
            status: route[1].status,
            headers: { 'content-type': 'application/json' }
        })
    }) as typeof fetch
}

function seedSession(id: string): void {
    store.sessions.getOrCreateSession(
        id, { path: '/repo', host: 'box' }, null, 'default',
        undefined, undefined, undefined, id
    )
}

/** A task in the shape the review flow expects: a branch, and a live session. */
function reviewableTask(overrides: Partial<Parameters<Store['tasks']['create']>[0]> = {}): StoredTask {
    const task = store.tasks.create({
        namespace: 'default',
        title: 'Fix the parser',
        prompt: 'Fix the parser.',
        workdir: '/repo',
        machineId: 'box-1',
        spawn: { flavor: 'claude' },
        baseRef: 'main',
        ...overrides
    })
    seedSession('sess-1')
    store.tasks.startRun({
        taskId: task.id, namespace: 'default', origin: 'user',
        sessionId: 'sess-1', branch: 'hapi/fix', worktreePath: '/repo-worktrees/fix'
    })
    return store.tasks.get(task.id) as StoredTask
}

beforeEach(() => {
    store = new Store(':memory:')
    commands = []
    published = []
    tokens = { 'github.com': 'tok' }
    commandImpl = async () => ({ success: true, stdout: 'git@github.com:acme/widget.git', exitCode: 0 })
    service = new TaskReviewService({
        store,
        runCommand: async (sessionId, options) => {
            commands.push({ sessionId, command: options.command, cwd: options.cwd })
            return await commandImpl(sessionId, options)
        },
        readTokens: async () => tokens,
        onTaskChanged: (task) => published.push(task)
    })
})

afterEach(() => {
    globalThis.fetch = originalFetch
    store.close()
})

describe('helpers', () => {
    it('parses a pull request URL back into its repo', () => {
        expect(parsePullRequestUrl('https://github.com/acme/widget/pull/7')).toEqual({
            host: 'github.com', owner: 'acme', repo: 'widget'
        })
        expect(parsePullRequestUrl('https://ghe.corp.example/team/sub/widget/pull/12')).toEqual({
            host: 'ghe.corp.example', owner: 'team/sub', repo: 'widget'
        })
        expect(parsePullRequestUrl('https://github.com/acme/widget')).toBeNull()
        expect(parsePullRequestUrl('nonsense')).toBeNull()
    })

    it('quotes a branch name safely', () => {
        expect(shellQuote('hapi/fix')).toBe(`'hapi/fix'`)
        expect(shellQuote("weird'name")).toBe(`'weird'\\''name'`)
    })

    it('puts the prompt in the pull request body', () => {
        const body = buildPullBody({ id: 'task-1', prompt: 'Fix it\nproperly' })
        expect(body).toContain('> Fix it')
        expect(body).toContain('> properly')
        expect(body).toContain('task-1')
    })
})

describe('openPullRequest', () => {
    it('reads the remote, pushes the branch, and opens the pull request', async () => {
        stubFetch([
            ['/pulls', { status: 201, body: OPEN_PULL }],
            ['/check-runs', { status: 200, body: { check_runs: [] } }]
        ])
        const task = reviewableTask()

        const result = await service.openPullRequest(task.id, 'default')
        expect(result.outcome).toBe('ok')
        if (result.outcome !== 'ok') return
        expect(result.value.url).toBe('https://github.com/acme/widget/pull/7')

        expect(commands[0].command).toBe('git remote get-url origin')
        expect(commands[1].command).toBe(`git push --set-upstream origin 'hapi/fix'`)
        // Both run in the worktree, not the source checkout.
        expect(commands[1].cwd).toBe('/repo-worktrees/fix')

        // Cached on the task and broadcast.
        const stored = store.tasks.get(task.id)?.pullRequest as TaskPullRequest
        expect(stored.number).toBe(7)
        expect(published.at(-1)?.id).toBe(task.id)
    })

    it('refuses a task with no branch', async () => {
        const task = store.tasks.create({
            namespace: 'default', title: 't', prompt: 'p', workdir: '/repo', spawn: { flavor: 'claude' }
        })
        const result = await service.openPullRequest(task.id, 'default')
        expect(result.outcome).toBe('no-branch')
        expect(commands).toHaveLength(0)
    })

    it('refuses when the session is gone, because the push needs the machine', async () => {
        const task = reviewableTask()
        store.tasks.finishRun(store.tasks.getActiveRun(task.id)!.id, {
            status: 'succeeded', clearSession: true
        })

        const result = await service.openPullRequest(task.id, 'default')
        expect(result.outcome).toBe('no-session')
        if (result.outcome !== 'no-session') return
        expect(result.message).toContain('Resume the task')
    })

    it('reports a repo with no origin remote', async () => {
        commandImpl = async () => ({ success: true, stdout: '', exitCode: 0 })
        const task = reviewableTask()

        const result = await service.openPullRequest(task.id, 'default')
        expect(result.outcome).toBe('rejected')
    })

    it('stops at a rejected push instead of opening a doomed pull request', async () => {
        commandImpl = async (_sessionId, options) => options.command.startsWith('git push')
            ? { success: false, stderr: 'protected branch hook declined', exitCode: 1 }
            : { success: true, stdout: 'git@github.com:acme/widget.git', exitCode: 0 }
        const task = reviewableTask()

        const result = await service.openPullRequest(task.id, 'default')
        expect(result.outcome).toBe('push-failed')
        if (result.outcome !== 'push-failed') return
        expect(result.message).toContain('protected branch')
    })

    it('reports a missing token before touching the machine any further', async () => {
        tokens = {}
        const task = reviewableTask()

        const result = await service.openPullRequest(task.id, 'default')
        expect(result).toEqual({ outcome: 'no-token', host: 'github.com' })
        // The remote was read, but nothing was pushed.
        expect(commands).toHaveLength(1)
    })

    it('names an unsupported forge', async () => {
        commandImpl = async () => ({ success: true, stdout: 'git@gitlab.com:acme/widget.git', exitCode: 0 })
        tokens = { 'gitlab.com': 'tok' }
        const task = reviewableTask()

        expect(await service.openPullRequest(task.id, 'default'))
            .toEqual({ outcome: 'unsupported-host', host: 'gitlab.com' })
    })

    it('adopts the pull request that already exists for the branch', async () => {
        stubFetch([
            ['/pulls?state=all', { status: 200, body: [OPEN_PULL] }],
            ['/pulls', { status: 422, body: { message: 'A pull request already exists for acme:hapi/fix.' } }],
            ['/check-runs', { status: 200, body: { check_runs: [] } }]
        ])
        const task = reviewableTask()

        const result = await service.openPullRequest(task.id, 'default')
        expect(result.outcome).toBe('ok')
        if (result.outcome !== 'ok') return
        expect(result.value.number).toBe(7)
        expect((store.tasks.get(task.id)?.pullRequest as TaskPullRequest).number).toBe(7)
    })

    it('falls back to the default branch when the pinned base is a commit sha', async () => {
        let pullBody: Record<string, unknown> = {}
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input.toString()
            if (url.endsWith('/repos/acme/widget')) {
                return new Response(JSON.stringify({ default_branch: 'trunk' }), { status: 200 })
            }
            if (url.includes('/check-runs')) {
                return new Response(JSON.stringify({ check_runs: [] }), { status: 200 })
            }
            pullBody = init?.body ? JSON.parse(init.body as string) : {}
            return new Response(JSON.stringify(OPEN_PULL), { status: 201 })
        }) as typeof fetch

        const task = reviewableTask({ baseRef: 'a1b2c3d4e5f6' })
        const result = await service.openPullRequest(task.id, 'default')

        expect(result.outcome).toBe('ok')
        expect(pullBody.base).toBe('trunk')
    })

    it('honours an explicit base branch and draft flag', async () => {
        let pullBody: Record<string, unknown> = {}
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input.toString()
            if (url.includes('/check-runs')) {
                return new Response(JSON.stringify({ check_runs: [] }), { status: 200 })
            }
            pullBody = init?.body ? JSON.parse(init.body as string) : {}
            return new Response(JSON.stringify(OPEN_PULL), { status: 201 })
        }) as typeof fetch

        const task = reviewableTask()
        await service.openPullRequest(task.id, 'default', { baseBranch: 'develop', draft: true, title: 'WIP' })

        expect(pullBody).toMatchObject({ base: 'develop', draft: true, title: 'WIP' })
    })
})

describe('refreshPullRequest', () => {
    it('works without a session, from the stored URL alone', async () => {
        stubFetch([
            ['/pulls', { status: 201, body: OPEN_PULL }],
            ['/check-runs', { status: 200, body: { check_runs: [] } }]
        ])
        const task = reviewableTask()
        await service.openPullRequest(task.id, 'default')

        // The agent is long gone by review time.
        store.tasks.finishRun(store.tasks.getActiveRun(task.id)!.id, {
            status: 'succeeded', column: 'review', clearSession: true
        })
        commands.length = 0

        stubFetch([
            ['/pulls/7', { status: 200, body: { ...OPEN_PULL, state: 'closed', merged_at: '2026-01-01T00:00:00Z' } }],
            ['/check-runs', { status: 200, body: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }]
        ])

        const result = await service.refreshPullRequest(task.id, 'default')
        expect(result.outcome).toBe('ok')
        if (result.outcome !== 'ok') return
        expect(result.value.state).toBe('merged')
        expect(result.value.checks).toBe('passing')
        // No machine was involved.
        expect(commands).toHaveLength(0)
    })

    it('reports a task with no pull request', async () => {
        const task = reviewableTask()
        const result = await service.refreshPullRequest(task.id, 'default')
        expect(result.outcome).toBe('no-pull-request')
    })

    it('404s an unknown task', async () => {
        expect((await service.refreshPullRequest('nope', 'default')).outcome).toBe('task-not-found')
    })
})

describe('forgetPullRequest', () => {
    it('clears the cached pull request', async () => {
        stubFetch([
            ['/pulls', { status: 201, body: OPEN_PULL }],
            ['/check-runs', { status: 200, body: { check_runs: [] } }]
        ])
        const task = reviewableTask()
        await service.openPullRequest(task.id, 'default')

        const result = service.forgetPullRequest(task.id, 'default')
        expect(result.outcome === 'ok' ? result.value.pullRequest : 'not ok').toBeNull()
        expect(store.tasks.get(task.id)?.pullRequest).toBeNull()
    })
})

describe('owner-only', () => {
    // The git host tokens are the owner's and reach every repo the owner can,
    // so another namespace must not be able to drive a forge call with them --
    // e.g. by pointing its task's `origin` at the owner's private repo.
    function foreignTask(): StoredTask {
        const task = store.tasks.create({
            namespace: 'tenant',
            title: 'Steal',
            prompt: 'x',
            workdir: '/repo',
            machineId: 'box-1',
            spawn: { flavor: 'claude' }
        })
        return store.tasks.update(task.id, 'tenant', { branch: 'hapi/x' }) as StoredTask
    }

    it('refuses every review action outside the owner namespace without running anything', async () => {
        globalThis.fetch = (async () => { throw new Error('no forge call expected') }) as unknown as typeof fetch
        const task = foreignTask()

        expect(await service.openPullRequest(task.id, 'tenant')).toEqual({ outcome: 'owner-only' })
        expect(await service.refreshPullRequest(task.id, 'tenant')).toEqual({ outcome: 'owner-only' })
        expect(service.forgetPullRequest(task.id, 'tenant')).toEqual({ outcome: 'owner-only' })
        expect(commands).toHaveLength(0)
    })
})
