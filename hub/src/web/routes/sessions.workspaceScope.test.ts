import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

/**
 * `GET /api/sessions?workspaceUser=<id>`.
 *
 * Same ownership rule as the board, asked of the session list — the two are
 * tested separately because they read it off different shapes (a stored task's
 * `workdir`, a live session's `metadata.path`) and a divergence would show as
 * a card whose conversation cannot be opened.
 */

function session(id: string, metadata: Session['metadata']): Session {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata,
        metadataVersion: 1,
        agentState: { controlledByUser: false, requests: {}, completedRequests: {} },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: 'default',
        collaborationMode: 'default'
    } as Session
}

function createApp(store: Store, sessions: Session[], namespace = 'default') {
    const engine = {
        getSessionsByNamespace: () => sessions,
        getFutureScheduledMessageCounts: () => new Map<string, number>(),
        getNextScheduledAtBySessionIds: () => new Map<string, number>()
    } as unknown as SyncEngine

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        c.set('userId', 1)
        await next()
    })
    app.route('/api', createSessionsRoutes(() => engine, store))
    return app
}

async function listIds(app: Hono<WebAppEnv>, query: string): Promise<string[]> {
    const response = await app.request(`/api/sessions${query}`)
    expect(response.status).toBe(200)
    const body = await response.json() as { sessions: Array<{ id: string }> }
    return body.sessions.map((entry) => entry.id)
}

describe('sessions workspace scoping', () => {
    it('returns only sessions running under the selected user roots', async () => {
        const store = new Store(':memory:')
        const kai = store.workspaceUsers.create({
            namespace: 'default', name: 'Kai', paths: ['/home/kai/repo']
        })
        const app = createApp(store, [
            session('mine', { path: '/home/kai/repo/web', host: 'box' }),
            session('theirs', { path: '/home/ming/repo', host: 'box' })
        ])

        expect(await listIds(app, `?workspaceUser=${kai.id}`)).toEqual(['mine'])
    })

    it('claims a worktree session through the repo it forked from', async () => {
        const store = new Store(':memory:')
        const kai = store.workspaceUsers.create({
            namespace: 'default', name: 'Kai', paths: ['/home/kai/repo']
        })
        const app = createApp(store, [
            session('worktree', {
                path: '/home/kai/repo-worktrees/fix',
                host: 'box',
                worktree: { basePath: '/home/kai/repo', branch: 'hapi/fix', name: 'fix' }
            })
        ])

        expect(await listIds(app, `?workspaceUser=${kai.id}`)).toEqual(['worktree'])
    })

    it('hides everything from a user with no directories configured', async () => {
        const store = new Store(':memory:')
        const nobody = store.workspaceUsers.create({
            namespace: 'default', name: 'New hire', paths: []
        })
        const app = createApp(store, [session('mine', { path: '/home/kai/repo', host: 'box' })])

        expect(await listIds(app, `?workspaceUser=${nobody.id}`)).toEqual([])
    })

    it('shows everything when no user is selected', async () => {
        const store = new Store(':memory:')
        const app = createApp(store, [
            session('a', { path: '/home/kai/repo', host: 'box' }),
            session('b', { path: '/home/ming/repo', host: 'box' })
        ])

        expect(await listIds(app, '')).toEqual(['a', 'b'])
    })

    it('404s a user id the namespace does not have', async () => {
        const store = new Store(':memory:')
        const app = createApp(store, [session('a', { path: '/home/kai/repo', host: 'box' })])

        const response = await app.request('/api/sessions?workspaceUser=missing')
        expect(response.status).toBe(404)
    })
})
