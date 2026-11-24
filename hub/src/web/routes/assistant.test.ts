import { beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { WebAppEnv } from '../middleware/auth'
import { createAuthMiddleware } from '../middleware/auth'
import { Store } from '../../store'
import type { SyncEvent } from '../../sync/syncEngine'
import { AssistantService } from '../../sync/assistantService'
import { assistantSystemNoticeKind } from '@hapi/protocol'
import { createAssistantRoutes } from './assistant'

const JWT_SECRET = new TextEncoder().encode('test-secret')

async function headers(namespace = 'default') {
    const token = await new SignJWT({ uid: 1, ns: namespace })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(JWT_SECRET)
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

let store: Store
let events: SyncEvent[]
let app: Hono<WebAppEnv>
let kaiId: string

beforeEach(() => {
    store = new Store(':memory:')
    events = []
    app = new Hono<WebAppEnv>()
    app.use('*', createAuthMiddleware(JWT_SECRET))
    app.route('/api', createAssistantRoutes({ store, publish: (event) => events.push(event), getAssistantService: () => null }))
    kaiId = store.workspaceUsers.create({ namespace: 'default', name: 'Kai', paths: ['/home/kai'] }).id
})

async function create(body: Record<string, unknown>) {
    return app.request('/api/assistant/memories', {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({
            workspaceUserId: kaiId,
            scope: 'user',
            scopeRef: kaiId,
            name: 'reply-in-chinese',
            description: '用中文回复',
            type: 'user',
            body: '',
            ...body
        })
    })
}

describe('assistant memory routes', () => {
    it('creates as the person and announces the change', async () => {
        const res = await create({})
        expect(res.status).toBe(201)
        const { memory } = await res.json() as { memory: { id: string; createdBy: string } }
        expect(memory.createdBy).toBe('human')
        expect(events).toEqual([
            { type: 'assistant-memory-updated', namespace: 'default', workspaceUserId: kaiId, memoryId: memory.id }
        ])

        expect((await create({})).status).toBe(409)
    })

    it('lists what is in context for a task: the person, the task\'s repo, the task', async () => {
        const task = store.tasks.create({
            namespace: 'default',
            title: 'Fix handoff',
            prompt: 'Fix handoff',
            workdir: '/home/kai/hapi/',
            machineId: null,
            isolation: 'worktree',
            spawn: { flavor: 'claude' }
        } as Parameters<Store['tasks']['create']>[0])

        await create({ name: 'mine' })
        await create({ scope: 'repo', scopeRef: '/home/kai/hapi', name: 'this-repo' })
        await create({ scope: 'repo', scopeRef: '/home/kai/other', name: 'other-repo' })
        await create({ scope: 'task', scopeRef: task.id, name: 'this-task' })
        await create({ scope: 'task', scopeRef: 'another-task', name: 'other-task' })

        const res = await app.request(
            `/api/assistant/memories?workspaceUser=${kaiId}&taskId=${task.id}`,
            { headers: await headers() }
        )
        const { memories } = await res.json() as { memories: Array<{ name: string }> }
        expect(memories.map((m) => m.name).sort()).toEqual(['mine', 'this-repo', 'this-task'])

        const all = await app.request(`/api/assistant/memories?workspaceUser=${kaiId}`, { headers: await headers() })
        expect(((await all.json()) as { memories: unknown[] }).memories).toHaveLength(5)
    })

    it('lets the person keep or take back an assistant edit', async () => {
        const created = store.assistant.createMemory({
            namespace: 'default', workspaceUserId: kaiId, scope: 'user', scopeRef: kaiId,
            name: 'note', description: 'd', type: 'project', body: '人写的', author: 'human'
        })
        store.assistant.updateMemory(created.id, 'default', { body: 'AI 改的' }, 'ai')

        const undo = await app.request(`/api/assistant/memories/${created.id}/undo`, { method: 'POST', headers: await headers() })
        expect(undo.status).toBe(200)
        const undone = await undo.json() as { outcome: string; memory: { body: string } }
        expect(undone).toMatchObject({ outcome: 'restored', memory: { body: '人写的' } })

        const again = await app.request(`/api/assistant/memories/${created.id}/undo`, { method: 'POST', headers: await headers() })
        expect(again.status).toBe(409)

        store.assistant.updateMemory(created.id, 'default', { body: 'AI 又改' }, 'ai')
        const keep = await app.request(`/api/assistant/memories/${created.id}`, {
            method: 'PATCH', headers: await headers(), body: JSON.stringify({ acceptPrevious: true })
        })
        const kept = await keep.json() as { memory: { body: string; previous: unknown } }
        expect(kept.memory).toMatchObject({ body: 'AI 又改', previous: null })
    })

    it('keeps an entry the person kept when the chat card\'s undo comes later', async () => {
        // The assistant wrote the entry from scratch; the chat card holds the
        // write's result, the person pressed Keep in the memory tab.
        const written = store.assistant.createMemory({
            namespace: 'default', workspaceUserId: kaiId, scope: 'user', scopeRef: kaiId,
            name: 'note', description: 'd', type: 'project', body: 'AI 写的', author: 'ai'
        })
        Bun.sleepSync(2)
        await app.request(`/api/assistant/memories/${written.id}`, {
            method: 'PATCH', headers: await headers(), body: JSON.stringify({ acceptPrevious: true })
        })

        const undo = await app.request(`/api/assistant/memories/${written.id}/undo`, {
            method: 'POST', headers: await headers(), body: JSON.stringify({ ifUpdatedAt: written.updatedAt })
        })
        expect(undo.status).toBe(409)
        expect(store.assistant.getMemory(written.id, 'default')?.body).toBe('AI 写的')
    })

    it('does not reach another namespace', async () => {
        const res = await create({})
        const { memory } = await res.json() as { memory: { id: string } }

        const otherNs = await headers('other')
        expect((await app.request(`/api/assistant/memories?workspaceUser=${kaiId}`, { headers: otherNs })).status).toBe(404)
        expect((await app.request(`/api/assistant/memories/${memory.id}`, { method: 'DELETE', headers: otherNs })).status).toBe(404)
        expect(store.assistant.getMemory(memory.id, 'default')).not.toBeNull()
    })
})

describe('assistant grant routes', () => {
    it('lists and revokes the person\'s standing grants', async () => {
        const grant = store.assistant.addGrant(kaiId, 'mcp__hapi__ping_peer')

        const list = await app.request(`/api/assistant/grants?workspaceUser=${kaiId}`, { headers: await headers() })
        expect(((await list.json()) as { grants: unknown[] }).grants).toHaveLength(1)

        const revoke = await app.request(`/api/assistant/grants/${grant.id}?workspaceUser=${kaiId}`, {
            method: 'DELETE', headers: await headers()
        })
        expect(revoke.status).toBe(200)
        expect(store.assistant.hasGrant(kaiId, 'mcp__hapi__ping_peer')).toBe(false)
        expect(events.at(-1)).toEqual({ type: 'assistant-grants-updated', namespace: 'default', workspaceUserId: kaiId })
    })
})

describe('assistant question routes', () => {
    function fileQuestion() {
        return store.assistant.createQuestion({
            namespace: 'default', workspaceUserId: kaiId, taskId: null,
            question: '先打通哪个子系统？', options: ['scheduler', 'kubelet'], chosen: 'scheduler',
            rationale: '依赖少', rollback: '回退 a1b2c3d 之后的 commit'
        })
    }

    function withService(sent: Array<{ text: string }>) {
        app = new Hono<WebAppEnv>()
        app.use('*', createAuthMiddleware(JWT_SECRET))
        const service = {
            send: async (input: { text: string }) => {
                sent.push(input)
                return { type: 'success', sessionId: 'a', contextSent: false }
            }
        } as unknown as AssistantService
        app.route('/api', createAssistantRoutes({ store, publish: (event) => events.push(event), getAssistantService: () => service }))
    }

    const answer = async (id: string, text: string) => app.request(`/api/assistant/questions/${id}/answer`, {
        method: 'POST', headers: await headers(), body: JSON.stringify({ answer: text })
    })

    it('closes quietly when the person keeps what the assistant chose', async () => {
        const sent: Array<{ text: string }> = []
        withService(sent)
        const question = fileQuestion()

        const res = await answer(question.id, 'scheduler')
        expect(res.status).toBe(200)
        expect(store.assistant.getQuestion(question.id, 'default')?.status).toBe('confirmed')
        expect(sent).toEqual([])
        expect((await answer(question.id, 'kubelet')).status).toBe(409)
        expect(sent).toEqual([])
    })

    it('sends the assistant back to redo when the answer differs', async () => {
        const sent: Array<{ text: string }> = []
        withService(sent)
        const question = fileQuestion()

        const res = await answer(question.id, 'kubelet')
        expect(res.status).toBe(200)
        expect(store.assistant.getQuestion(question.id, 'default')?.status).toBe('overridden')
        expect(sent).toHaveLength(1)
        expect(assistantSystemNoticeKind(sent[0].text)).toBe('answer')
        expect(sent[0].text).toContain('回退 a1b2c3d 之后的 commit')
    })

    it('keeps the question open when the assistant could not be told, so the answer can be retried', async () => {
        let failing = true
        const sent: Array<{ text: string }> = []
        const service = {
            send: async (input: { text: string }) => {
                if (failing) return { type: 'error', status: 503, message: 'No machine is online' }
                sent.push(input)
                return { type: 'success', sessionId: 'a', contextSent: false }
            }
        } as unknown as AssistantService
        app = new Hono<WebAppEnv>()
        app.use('*', createAuthMiddleware(JWT_SECRET))
        app.route('/api', createAssistantRoutes({ store, publish: (event) => events.push(event), getAssistantService: () => service }))
        const question = fileQuestion()

        const first = await answer(question.id, 'kubelet')
        expect(first.status).toBe(200)
        expect(await first.json()).toMatchObject({ reworkError: 'No machine is online', question: { status: 'open' } })
        expect(store.assistant.getQuestion(question.id, 'default')?.status).toBe('open')

        failing = false
        const retry = await answer(question.id, 'kubelet')
        expect(await retry.json()).toMatchObject({ reworkError: null, question: { status: 'overridden', answer: 'kubelet' } })
        expect(sent).toHaveLength(1)
    })
})

describe('assistant machine route', () => {
    function withMachines(online: string[], stops: string[]) {
        const service = new AssistantService({
            store,
            getSession: () => undefined,
            listSessions: () => [],
            onlineMachineIds: () => online,
            spawn: async () => ({ type: 'error', message: 'unused' }),
            reopen: async () => ({ type: 'error', message: 'unused' }),
            stop: async (id) => { stops.push(id) },
            send: async () => {}
        })
        app = new Hono<WebAppEnv>()
        app.use('*', createAuthMiddleware(JWT_SECRET))
        app.route('/api', createAssistantRoutes({ store, publish: (event) => events.push(event), getAssistantService: () => service }))
    }

    const put = async (body: unknown) => app.request('/api/assistant/machine', {
        method: 'PUT', headers: await headers(), body: JSON.stringify(body)
    })

    it('pins the assistant to an online machine and back to automatic', async () => {
        withMachines(['m-1', 'm-2'], [])

        const pinned = await put({ workspaceUserId: kaiId, machineId: 'm-2' })
        expect(pinned.status).toBe(200)
        expect(await pinned.json()).toEqual({ sessionId: null, agent: 'claude', machineId: 'm-2', sessionMachineId: null })
        expect(store.assistant.getMachineId(kaiId, 'default')).toBe('m-2')

        const session = await app.request(`/api/assistant/session?workspaceUser=${kaiId}`, { headers: await headers() })
        expect(await session.json()).toMatchObject({ machineId: 'm-2' })

        const auto = await put({ workspaceUserId: kaiId, machineId: null })
        expect(await auto.json()).toMatchObject({ machineId: null })
        expect(store.assistant.getMachineId(kaiId, 'default')).toBeNull()
    })

    it('refuses an offline machine, a stranger and a malformed body', async () => {
        withMachines(['m-1'], [])

        expect((await put({ workspaceUserId: kaiId, machineId: 'm-gone' })).status).toBe(409)
        expect(store.assistant.getMachineId(kaiId, 'default')).toBeNull()
        expect((await put({ workspaceUserId: 'nobody', machineId: 'm-1' })).status).toBe(404)
        expect((await put({ workspaceUserId: kaiId })).status).toBe(400)
    })
})

describe('assistant message route', () => {
    const sends: Array<{ text: string; attachments?: unknown[] }> = []
    beforeEach(() => {
        sends.length = 0
        const session = {
            id: 's-1', namespace: 'default', active: true, updatedAt: 1,
            metadata: { path: '/a', host: 'h', role: 'assistant', workspaceUserId: kaiId, flavor: 'claude', machineId: 'm-1' }
        }
        const service = new AssistantService({
            store,
            getSession: (id) => (id === 's-1' ? session : undefined) as never,
            listSessions: () => [session] as never,
            onlineMachineIds: () => ['m-1'],
            spawn: async () => ({ type: 'error', message: 'unused' }),
            reopen: async () => ({ type: 'error', message: 'unused' }),
            stop: async () => {},
            send: async (_id, payload) => { sends.push(payload) }
        })
        app = new Hono<WebAppEnv>()
        app.use('*', createAuthMiddleware(JWT_SECRET))
        app.route('/api', createAssistantRoutes({ store, publish: (event) => events.push(event), getAssistantService: () => service }))
    })

    const post = async (path: string, body: unknown) => app.request(`/api/assistant/${path}`, {
        method: 'POST', headers: await headers(), body: JSON.stringify(body)
    })

    it('opens the session for an upload and takes a files-only message', async () => {
        const opened = await post('session', { workspaceUserId: kaiId })
        expect(opened.status).toBe(200)
        expect(await opened.json()).toEqual({ sessionId: 's-1' })

        const attachment = { id: 'a', filename: 'notes.txt', mimeType: 'text/plain', size: 5, path: '/tmp/hapi-blobs/x/notes.txt' }
        const res = await post('messages', { workspaceUserId: kaiId, text: '', attachments: [attachment] })
        expect(res.status).toBe(200)
        expect(sends[0]?.attachments).toEqual([attachment])
    })

    it('refuses a message with neither text nor files', async () => {
        expect((await post('messages', { workspaceUserId: kaiId, text: '  ' })).status).toBe(400)
        expect(sends).toHaveLength(0)
    })
})
