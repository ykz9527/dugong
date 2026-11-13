import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createConfiguration } from '../../configuration'
import { Store } from '../../store'
import type { Session, SyncEngine, SyncEvent } from '../../sync/syncEngine'
import type { CliEnv } from './cli'
import { createCliAssistantRoutes } from './cliAssistant'

let store: Store
let app: Hono<CliEnv>
let sessions: Map<string, Session>
let events: SyncEvent[]
let approvals: Array<{ sessionId: string; requestId: string }>
let denials: Array<{ sessionId: string; requestId: string; decision?: string }>
let kaiId: string

const headers = { authorization: 'Bearer cli-secret', 'content-type': 'application/json' }

function session(id: string, metadata: Record<string, unknown>, extra: Partial<Session> = {}): Session {
    const s = { id, namespace: 'default', active: true, metadata, ...extra } as unknown as Session
    sessions.set(id, s)
    return s
}

beforeAll(async () => {
    const config = await createConfiguration()
    config._setCliApiToken('cli-secret', 'env', false)
})

beforeEach(() => {
    store = new Store(':memory:')
    sessions = new Map()
    events = []
    approvals = []
    denials = []
    kaiId = store.workspaceUsers.create({ namespace: 'default', name: 'Kai', paths: ['/home/kai'] }).id
    session('assistant', { path: '/hapi/assistant/kai', host: 'h', role: 'assistant', workspaceUserId: kaiId })
    store.assistant.setSessionId(kaiId, 'default', 'assistant')
    session('plain', { path: '/home/kai/repo', host: 'h' })
    const engine = {
        getSessionByNamespace: (id: string, ns: string) => {
            const s = sessions.get(id)
            return s && s.namespace === ns ? s : undefined
        },
        approvePermission: async (sessionId: string, requestId: string) => { approvals.push({ sessionId, requestId }) },
        denyPermission: async (sessionId: string, requestId: string, decision?: string) => {
            denials.push({ sessionId, requestId, decision })
        }
    } as unknown as SyncEngine
    app = new Hono<CliEnv>()
    app.route('/cli', createCliAssistantRoutes({
        store,
        getSyncEngine: () => engine,
        getTaskOrchestrator: () => null,
        publish: (event) => events.push(event)
    }))
})

const post = (path: string, body: Record<string, unknown>) =>
    app.request(`/cli/assistant/tools${path}`, { method: 'POST', headers, body: JSON.stringify(body) })

function makeTask(workdir: string) {
    return store.tasks.create({
        namespace: 'default', title: 't', prompt: 'p', workdir, machineId: null,
        isolation: 'simple', spawn: { flavor: 'claude' }
    } as Parameters<Store['tasks']['create']>[0])
}

describe('task assistant tool routes', () => {
    it('only answer a task assistant session, and only with the CLI token', async () => {
        expect((await post('/memories/read', { sessionId: 'plain', name: 'x' })).status).toBe(403)
        const noToken = await app.request('/cli/assistant/tools/memories?sessionId=assistant')
        expect(noToken.status).toBe(401)
    })

    it('writes as the assistant: creates, then updates in place keeping the person\'s version', async () => {
        const human = store.assistant.createMemory({
            namespace: 'default', workspaceUserId: kaiId, scope: 'repo', scopeRef: '/home/kai/hapi',
            name: 'check-schema', description: '发布前比对 schema', type: 'project', body: '人写的', author: 'human'
        })

        const updated = await post('/memories/write', {
            sessionId: 'assistant', scope: 'repo', scopeRef: '/home/kai/hapi/', name: 'check-schema',
            description: '发布前比对 schema', type: 'project', body: 'AI 补充的'
        })
        expect(await updated.json()).toMatchObject({ outcome: 'updated', memory: { id: human.id, body: 'AI 补充的', lastEditedBy: 'ai', previous: { body: '人写的' } } })

        const created = await post('/memories/write', {
            sessionId: 'assistant', scope: 'user', name: 'reply-in-chinese',
            description: '用中文回复', type: 'user', body: '…'
        })
        const createdBody = await created.json() as { outcome: string; memory: { scopeRef: string; createdBy: string; source: unknown } }
        expect(createdBody).toMatchObject({ outcome: 'created', memory: { scopeRef: kaiId, createdBy: 'ai', source: { sessionId: 'assistant' } } })
        expect(events.filter((e) => e.type === 'assistant-memory-updated')).toHaveLength(2)

        const badName = await post('/memories/write', {
            sessionId: 'assistant', scope: 'user', name: 'Not Kebab', description: 'd', type: 'user', body: ''
        })
        expect(badName.status).toBe(400)
    })

    it('cannot file a memory under, or look at, someone else\'s task', async () => {
        const mine = makeTask('/home/kai/repo')
        const theirs = makeTask('/home/ming/repo')

        const refused = await post('/memories/write', {
            sessionId: 'assistant', scope: 'task', scopeRef: theirs.id, name: 'peek', description: 'd', type: 'project', body: ''
        })
        expect(refused.status).toBe(404)
        expect((await app.request(`/cli/assistant/tools/tasks/${theirs.id}?sessionId=assistant`, { headers })).status).toBe(404)

        const list = await app.request('/cli/assistant/tools/tasks?sessionId=assistant', { headers })
        const { tasks } = await list.json() as { tasks: Array<{ id: string }> }
        expect(tasks.map((t) => t.id)).toEqual([mine.id])
    })

    it('hands back a deleted entry whole so it can be restored', async () => {
        store.assistant.createMemory({
            namespace: 'default', workspaceUserId: kaiId, scope: 'user', scopeRef: kaiId,
            name: 'stale', description: '过时的', type: 'project', body: '…', author: 'ai'
        })
        const res = await post('/memories/delete', { sessionId: 'assistant', name: 'stale' })
        expect(await res.json()).toMatchObject({ deleted: { name: 'stale', description: '过时的' } })
        expect(store.assistant.listMemories('default', kaiId)).toHaveLength(0)
    })

    it('refuses a session that only claims to be the person\'s assistant', async () => {
        // Self-reported metadata identical to the real assistant, but the hub
        // never assigned this session.
        session('impostor', { path: '/home/kai/repo', host: 'h', role: 'assistant', workspaceUserId: kaiId })
        const task = makeTask('/home/kai/repo')
        const calls: Array<[string, Record<string, unknown>]> = [
            [`/tasks/${task.id}/start`, {}],
            [`/tasks/${task.id}/cancel`, {}],
            [`/tasks/${task.id}/move`, { column: 'done' }],
            ['/peer-respond', { targetSessionId: 'plain', requestId: 'r', decision: 'approve' }]
        ]
        for (const [path, body] of calls) {
            expect((await post(path, { sessionId: 'impostor', ...body })).status).toBe(403)
            expect((await post(path, { sessionId: 'plain', ...body })).status).toBe(403)
        }
        expect(store.tasks.getByNamespace(task.id, 'default')?.column).not.toBe('done')
    })

    it('answers another session\'s prompt only for the person\'s own tasks', async () => {
        const runOn = (workdir: string, sessionId: string) => {
            const task = makeTask(workdir)
            store.sessions.getOrCreateSession(sessionId, { path: workdir }, {}, 'default', undefined, undefined, undefined, sessionId)
            store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'manual', sessionId })
        }
        const pending = (requestId: string) => ({
            agentState: { requests: { [requestId]: { tool: 'Bash', arguments: {} } } }
        } as Partial<Session>)
        session('kai-task', { path: '/home/kai/repo', host: 'h' }, pending('req-1'))
        session('ming-task', { path: '/home/ming/repo', host: 'h' }, pending('req-2'))
        session('kai-by-hand', { path: '/home/kai/repo', host: 'h' }, pending('req-3'))
        session('kai-stopped', { path: '/home/kai/repo', host: 'h' }, { ...pending('req-4'), active: false })
        runOn('/home/kai/repo', 'kai-task')
        runOn('/home/ming/repo', 'ming-task')
        runOn('/home/kai/repo', 'kai-stopped')

        const respond = (targetSessionId: string, requestId: string, decision: 'approve' | 'deny' = 'approve') =>
            post('/peer-respond', { sessionId: 'assistant', targetSessionId, requestId, decision })

        expect((await respond('ming-task', 'req-2')).status).toBe(404)
        expect((await respond('kai-by-hand', 'req-3')).status).toBe(404)
        expect((await respond('kai-stopped', 'req-4')).status).toBe(409)
        expect((await respond('kai-task', 'req-1')).status).toBe(200)
        expect(approvals).toEqual([{ sessionId: 'kai-task', requestId: 'req-1' }])

        expect((await respond('kai-task', 'req-1', 'deny')).status).toBe(200)
        expect(denials).toEqual([{ sessionId: 'kai-task', requestId: 'req-1', decision: 'denied' }])
    })

    it('reports standing grants for the calling assistant\'s person', async () => {
        const check = async (tool: string) =>
            ((await (await app.request(`/cli/assistant/tools/grants?sessionId=assistant&tool=${tool}`, { headers })).json()) as { granted: boolean }).granted
        expect(await check('mcp__hapi__ping_peer')).toBe(false)
        store.assistant.addGrant(kaiId, 'mcp__hapi__ping_peer')
        expect(await check('mcp__hapi__ping_peer')).toBe(true)
        expect(await check('ping_peer')).toBe(true)
    })
})

describe('questions for later', () => {
    it('files a question on the person\'s own task, lists it while open, and withdraws it once', async () => {
        const own = makeTask('/home/kai/repo')
        const others = makeTask('/home/ming/repo')
        const question = {
            sessionId: 'assistant', question: '先打通哪个子系统？', options: ['scheduler', 'kubelet'],
            chosen: 'scheduler', rationale: '依赖少', rollback: '回退 a1b2c3d 之后的 commit'
        }

        expect((await post('/questions/add', { ...question, taskId: others.id })).status).toBe(404)
        expect((await post('/questions/add', { ...question, chosen: 'etcd' })).status).toBe(400)

        const added = await post('/questions/add', { ...question, taskId: own.id })
        expect(added.status).toBe(200)
        const { id } = await added.json() as { id: string }
        expect(events.at(-1)).toEqual({ type: 'assistant-questions-updated', namespace: 'default', workspaceUserId: kaiId })

        const listed = await app.request('/cli/assistant/tools/questions?sessionId=assistant', { headers })
        expect((await listed.json() as { questions: Array<{ id: string }> }).questions.map((q) => q.id)).toEqual([id])

        expect((await post('/questions/withdraw', { sessionId: 'assistant', id })).status).toBe(200)
        expect((await post('/questions/withdraw', { sessionId: 'assistant', id })).status).toBe(409)
        const after = await app.request('/cli/assistant/tools/questions?sessionId=assistant', { headers })
        expect((await after.json() as { questions: unknown[] }).questions).toEqual([])
    })
})
