import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { StoredTask } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import {
    TaskOrchestrator,
    type SpawnTaskSessionInput,
    type SpawnTaskSessionResult
} from '../../sync/taskOrchestrator'
import { TaskReviewService, type RunCommand } from '../../sync/taskReview'
import { TaskWorktreeService } from '../../sync/taskWorktree'
import type {
    RemoveWorktreeRequest,
    RemoveWorktreeResponse
} from '@hapi/protocol/apiTypes'
import type { WebAppEnv } from '../middleware/auth'
import { createTasksRoutes } from './tasks'

let store: Store
let app: Hono<WebAppEnv>
let orchestrator: TaskOrchestrator | null
let review: TaskReviewService | null
let spawnImpl: (input: SpawnTaskSessionInput) => Promise<SpawnTaskSessionResult>
let abortCalls: string[]
let stopSessionCalls: Array<{ machineId: string; sessionId: string }>
let stopSessionStatus: 'stopped' | 'already_gone' | 'still_alive'
let commandImpl: RunCommand
let gitHostTokens: Record<string, string> | undefined
let worktreeService: TaskWorktreeService | null
let machineCapabilities: readonly string[] | null
/** Removal requests only; probes are recorded in `probeCalls`. */
let removeWorktreeCalls: RemoveWorktreeRequest[]
let probeCalls: RemoveWorktreeRequest[]
/** Answers removals and probes alike unless it inspects `request.probe`. */
let removeWorktreeImpl: (request: RemoveWorktreeRequest) => Promise<RemoveWorktreeResponse>

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
        return new Response(JSON.stringify(route[1].body), { status: route[1].status })
    }) as typeof fetch
}

/** A task with a branch and a live session — what the review flow needs.
 *  `baseRef` is pinned so the flow does not have to ask the forge for a
 *  default branch, keeping these stubs to the routes under test. */
function reviewableTask(): StoredTask {
    const task = makeTask({ baseRef: 'main' })
    store.tasks.startRun({
        taskId: task.id, namespace: 'default', origin: 'user',
        sessionId: 'sess-1', branch: 'hapi/fix', worktreePath: '/repo-worktrees/fix'
    })
    return store.tasks.get(task.id) as StoredTask
}

const KNOWN_MACHINE = 'box-1'

function fakeEngine(): SyncEngine {
    return {
        getMachine: (id: string) =>
            id === KNOWN_MACHINE ? { id, namespace: 'default' } : undefined
    } as unknown as SyncEngine
}

function createApp(namespace = 'default'): Hono<WebAppEnv> {
    const instance = new Hono<WebAppEnv>()
    instance.use('*', async (c, next) => {
        c.set('namespace', namespace)
        c.set('userId', 1)
        await next()
    })
    instance.route('/api', createTasksRoutes({
        store,
        getSyncEngine: () => fakeEngine(),
        getTaskOrchestrator: () => orchestrator,
        getTaskReview: () => review,
        getTaskWorktree: () => worktreeService
    }))
    return instance
}

function seedSession(id: string): void {
    store.sessions.getOrCreateSession(
        id, { path: '/repo', host: 'box' }, null, 'default',
        undefined, undefined, undefined, id
    )
}

function makeTask(overrides: Partial<Parameters<Store['tasks']['create']>[0]> = {}): StoredTask {
    return store.tasks.create({
        namespace: 'default',
        title: 'Fix the parser',
        prompt: 'Fix it.',
        workdir: '/repo',
        machineId: KNOWN_MACHINE,
        spawn: { flavor: 'claude' },
        ...overrides
    })
}

async function post(path: string, body?: unknown): Promise<Response> {
    return await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    })
}

async function patch(path: string, body: unknown): Promise<Response> {
    return await app.request(path, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    })
}

beforeEach(() => {
    store = new Store(':memory:')
    abortCalls = []
    stopSessionCalls = []
    stopSessionStatus = 'stopped'
    seedSession('sess-1')
    spawnImpl = async () => ({ type: 'success', sessionId: 'sess-1' })
    orchestrator = new TaskOrchestrator({
        store,
        getSession: (id) => (id === 'sess-1' ? { id, namespace: 'default', active: true } : null),
        spawnSession: async (input) => await spawnImpl(input),
        sendMessage: async () => {},
        abortSession: async (id) => { abortCalls.push(id) },
        stopSession: async (machineId, sessionId) => {
            stopSessionCalls.push({ machineId, sessionId })
            return stopSessionStatus
        },
        subscribe: () => () => {},
        logger: { error: () => {} }
    })
    commandImpl = async () => ({ success: true, stdout: 'git@github.com:acme/widget.git', exitCode: 0 })
    gitHostTokens = { 'github.com': 'tok' }
    review = new TaskReviewService({
        store,
        runCommand: async (sessionId, commandOptions) => await commandImpl(sessionId, commandOptions),
        readTokens: async () => gitHostTokens
    })
    machineCapabilities = ['remove-worktree']
    removeWorktreeCalls = []
    probeCalls = []
    removeWorktreeImpl = async (request) => request.probe
        ? { outcome: 'clean' }
        : { outcome: 'removed', branch: 'deleted' }
    worktreeService = new TaskWorktreeService({
        getMachineCapabilities: () => machineCapabilities,
        removeWorktree: async (_machineId, request) => {
            (request.probe ? probeCalls : removeWorktreeCalls).push(request)
            return await removeWorktreeImpl(request)
        }
    })
    app = createApp()
})

afterEach(() => {
    globalThis.fetch = originalFetch
    store.close()
})

describe('GET /api/tasks', () => {
    it('returns an empty board with counts', async () => {
        const response = await app.request('/api/tasks')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ tasks: [], counts: {} })
    })

    it('lists live tasks with per-column counts', async () => {
        makeTask({ column: 'ready' })
        makeTask({ column: 'review' })
        const archived = makeTask()
        store.tasks.archive(archived.id, 'default')

        const body = await (await app.request('/api/tasks')).json() as {
            tasks: Array<{ column: string }>
            counts: Record<string, number>
        }
        expect(body.tasks).toHaveLength(2)
        expect(body.counts).toEqual({ ready: 1, review: 1 })
    })

    it('filters by column and can include archived rows', async () => {
        makeTask({ column: 'ready' })
        const archived = makeTask({ column: 'done' })
        store.tasks.archive(archived.id, 'default')

        const filtered = await (await app.request('/api/tasks?column=ready')).json() as { tasks: unknown[] }
        expect(filtered.tasks).toHaveLength(1)

        const all = await (await app.request('/api/tasks?includeArchived=true')).json() as { tasks: unknown[] }
        expect(all.tasks).toHaveLength(2)
    })

    it('rejects an unknown column and a bad limit', async () => {
        expect((await app.request('/api/tasks?column=nope')).status).toBe(400)
        expect((await app.request('/api/tasks?limit=0')).status).toBe(400)
        expect((await app.request('/api/tasks?limit=abc')).status).toBe(400)
    })

    it('does not leak tasks from another namespace', async () => {
        makeTask()
        const other = createApp('tenant')
        const body = await (await other.request('/api/tasks')).json() as { tasks: unknown[] }
        expect(body.tasks).toHaveLength(0)
    })
})

describe('POST /api/tasks', () => {
    it('creates a task and derives the title from the prompt', async () => {
        const response = await post('/api/tasks', {
            prompt: 'Rewrite the tokenizer\nand add tests',
            workdir: '/repo',
            spawn: { flavor: 'claude' }
        })

        expect(response.status).toBe(201)
        const body = await response.json() as { task: { title: string; column: string; isolation: string } }
        expect(body.task.title).toBe('Rewrite the tokenizer')
        expect(body.task.column).toBe('backlog')
        expect(body.task.isolation).toBe('worktree')
    })

    it('keeps an explicit title', async () => {
        const response = await post('/api/tasks', {
            prompt: 'Rewrite the tokenizer',
            workdir: '/repo',
            title: 'Tokenizer work',
            spawn: { flavor: 'codex' }
        })
        const body = await response.json() as { task: { title: string } }
        expect(body.task.title).toBe('Tokenizer work')
    })

    it('rejects a malformed body and an unknown agent', async () => {
        expect((await post('/api/tasks', { workdir: '/repo' })).status).toBe(400)
        expect((await post('/api/tasks', {
            prompt: 'x', workdir: '/repo', spawn: { flavor: 'nope' }
        })).status).toBe(400)
    })

    it('refuses a machine the caller cannot see', async () => {
        const response = await post('/api/tasks', {
            prompt: 'x', workdir: '/repo', spawn: { flavor: 'claude' }, machineId: 'box-unknown'
        })
        expect(response.status).toBe(404)
    })

    it('refuses start without a machine', async () => {
        const response = await post('/api/tasks', {
            prompt: 'x', workdir: '/repo', spawn: { flavor: 'claude' }, start: true
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'start requires a machineId' })
    })

    it('creates and starts in one call', async () => {
        const response = await post('/api/tasks', {
            prompt: 'Ship it', workdir: '/repo', spawn: { flavor: 'claude' },
            machineId: KNOWN_MACHINE, start: true
        })

        expect(response.status).toBe(201)
        const body = await response.json() as {
            task: { column: string }
            start: { outcome: string; sessionId?: string }
        }
        expect(body.task.column).toBe('running')
        expect(body.start).toMatchObject({ outcome: 'started', sessionId: 'sess-1' })
    })

    it('creates nothing when it cannot start', async () => {
        orchestrator = null
        const response = await post('/api/tasks', {
            prompt: 'Ship it', workdir: '/repo', spawn: { flavor: 'claude' },
            machineId: KNOWN_MACHINE, start: true
        })

        expect(response.status).toBe(503)
        expect(store.tasks.list('default')).toHaveLength(0)
    })

    it('keeps the created card when the start fails', async () => {
        spawnImpl = async () => ({ type: 'error', message: 'runner offline' })
        const response = await post('/api/tasks', {
            prompt: 'Ship it', workdir: '/repo', spawn: { flavor: 'claude' },
            machineId: KNOWN_MACHINE, start: true
        })

        expect(response.status).toBe(201)
        const body = await response.json() as {
            task: { column: string; lastError: string | null }
            start: { outcome: string; message?: string }
        }
        // Spawn failures land in `blocked` — the error column.
        expect(body.task.column).toBe('blocked')
        expect(body.task.lastError).toBe('runner offline')
        expect(body.start).toEqual({ outcome: 'spawn-failed', message: 'runner offline' })
    })
})

describe('POST /api/tasks/adopt', () => {
    /** An imported session: native id in metadata, transcript in messages. */
    function seedAdoptable(id: string): void {
        store.sessions.getOrCreateSession(id, {
            path: '/repo',
            host: 'box',
            machineId: KNOWN_MACHINE,
            flavor: 'claude',
            claudeSessionId: 'native-1',
            name: 'Merge parallel edges',
            summary: { text: 'commit and merge the schema change', updatedAt: 1 }
        }, {}, 'default', undefined, undefined, undefined, id)
        for (const [localId, text] of [
            ['claude:native-1:u1', 'how should parallel edges pick an Operator?'],
            ['claude:native-1:u2', 'commit and merge the schema change']
        ]) {
            store.messages.addImportedMessage(id, {
                role: 'user',
                content: { type: 'text', text },
                meta: { sentFrom: 'cli' }
            }, localId, 1)
        }
    }

    it('describes the card by how the conversation opened, not how it ended', async () => {
        // The session summary is the *last* thing asked. On a finished
        // conversation that is an instruction already carried out, and it reads
        // on the card as a to-do that will never be done.
        seedAdoptable('import-1')

        const response = await post('/api/tasks/adopt', { sessionId: 'import-1' })

        expect(response.status).toBe(201)
        const body = await response.json() as { task: { prompt: string; title: string; spawn: Record<string, unknown> } }
        expect(body.task.prompt).toBe('how should parallel edges pick an Operator?')
        expect(body.task.title).toBe('Merge parallel edges')
        expect(body.task.spawn.adoptedNativeSessionId).toBe('native-1')
    })

    it('pins the card to the directory the conversation ran in', async () => {
        // A worktree would move the card somewhere the agent's own history does
        // not point, and `claude --resume` indexes transcripts by cwd.
        seedAdoptable('import-2')

        const response = await post('/api/tasks/adopt', { sessionId: 'import-2' })

        const body = await response.json() as { task: { isolation: string; workdir: string; column: string } }
        expect(body.task.isolation).toBe('simple')
        expect(body.task.workdir).toBe('/repo')
        expect(body.task.column).toBe('review')
    })

    it('records the permission mode the card will start under', async () => {
        // Starting a card spawns from its own spawn config, so a mode kept only
        // on the session row would never reach `--permission-mode` and every
        // adopted conversation would resume asking about each tool call.
        seedAdoptable('import-mode')

        const response = await post('/api/tasks/adopt', { sessionId: 'import-mode', permissionMode: 'auto' })

        expect(response.status).toBe(201)
        const body = await response.json() as { task: { spawn: Record<string, unknown> } }
        expect(body.task.spawn.permissionMode).toBe('auto')
    })

    it('drops a permission mode Claude does not have', async () => {
        // `yolo` belongs to the Codex family. Persisted here it would be handed
        // to a claude process that rejects it, turning a preference into a
        // failed start.
        seedAdoptable('import-bad-mode')

        const response = await post('/api/tasks/adopt', { sessionId: 'import-bad-mode', permissionMode: 'yolo' })

        expect(response.status).toBe(201)
        const body = await response.json() as { task: { spawn: Record<string, unknown> } }
        expect(body.task.spawn.permissionMode).toBeUndefined()
    })

    it('refuses a session that has no native id to resume', async () => {
        store.sessions.getOrCreateSession('no-native', {
            path: '/repo', host: 'box', machineId: KNOWN_MACHINE, flavor: 'claude', name: 'x'
        }, {}, 'default', undefined, undefined, undefined, 'no-native')

        const response = await post('/api/tasks/adopt', { sessionId: 'no-native' })

        expect(response.status).toBe(400)
    })

    it('refuses to give one session two cards', async () => {
        seedAdoptable('import-3')
        expect((await post('/api/tasks/adopt', { sessionId: 'import-3' })).status).toBe(201)

        const second = await post('/api/tasks/adopt', { sessionId: 'import-3' })

        expect(second.status).toBe(409)
    })

    it('refuses a flavor Start could not resume', async () => {
        store.sessions.getOrCreateSession('gemini-import', {
            path: '/repo', host: 'box', machineId: KNOWN_MACHINE, flavor: 'gemini', name: 'x'
        }, {}, 'default', undefined, undefined, undefined, 'gemini-import')

        const response = await post('/api/tasks/adopt', { sessionId: 'gemini-import' })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Adopting a gemini session is not supported yet' })
        expect(store.tasks.list('default')).toHaveLength(0)
    })

    it('refuses a session on a machine the caller cannot see', async () => {
        store.sessions.getOrCreateSession('far-away', {
            path: '/repo', host: 'box', machineId: 'box-unknown', flavor: 'claude', claudeSessionId: 'native-far'
        }, {}, 'default', undefined, undefined, undefined, 'far-away')

        expect((await post('/api/tasks/adopt', { sessionId: 'far-away' })).status).toBe(404)
        expect(store.tasks.list('default')).toHaveLength(0)
    })

    it('adopts a Codex session and resumes its Codex thread', async () => {
        store.sessions.getOrCreateSession('codex-import', {
            path: '/repo',
            host: 'box',
            machineId: KNOWN_MACHINE,
            flavor: 'codex',
            codexSessionId: 'thread-9',
            name: 'Port the parser'
        }, {}, 'default', undefined, undefined, undefined, 'codex-import')

        const response = await post('/api/tasks/adopt', { sessionId: 'codex-import', permissionMode: 'yolo' })

        expect(response.status).toBe(201)
        const body = await response.json() as { task: { spawn: Record<string, unknown> } }
        expect(body.task.spawn).toMatchObject({
            flavor: 'codex',
            adoptedNativeSessionId: 'thread-9',
            permissionMode: 'yolo'
        })
    })
})

describe('GET /api/tasks/:id', () => {
    it('returns the task with its run history', async () => {
        const task = makeTask()
        await post(`/api/tasks/${task.id}/start`)

        const body = await (await app.request(`/api/tasks/${task.id}`)).json() as {
            task: { id: string }
            runs: Array<{ status: string; origin: string }>
        }
        expect(body.task.id).toBe(task.id)
        expect(body.runs).toHaveLength(1)
        expect(body.runs[0]).toMatchObject({ status: 'running', origin: 'user' })
    })

    it('404s for an unknown id and for another namespace', async () => {
        const task = makeTask()
        expect((await app.request('/api/tasks/nope')).status).toBe(404)
        expect((await createApp('tenant').request(`/api/tasks/${task.id}`)).status).toBe(404)
    })
})

describe('PATCH /api/tasks/:id', () => {
    it('updates editable fields', async () => {
        const task = makeTask()
        const response = await patch(`/api/tasks/${task.id}`, { title: 'Renamed', prompt: 'Do it better' })

        expect(response.status).toBe(200)
        const body = await response.json() as { task: { title: string; prompt: string } }
        expect(body.task.title).toBe('Renamed')
        expect(body.task.prompt).toBe('Do it better')
    })

    it('rejects an empty patch', async () => {
        const task = makeTask()
        expect((await patch(`/api/tasks/${task.id}`, {})).status).toBe(400)
    })

    it('refuses to re-point a running task, but still allows a rename', async () => {
        const task = makeTask()
        await post(`/api/tasks/${task.id}/start`)

        const blocked = await patch(`/api/tasks/${task.id}`, { workdir: '/elsewhere' })
        expect(blocked.status).toBe(409)
        expect(await blocked.json()).toMatchObject({ code: 'task_running' })

        expect((await patch(`/api/tasks/${task.id}`, { title: 'Still editable' })).status).toBe(200)
    })

    it('refuses a machine the caller cannot see', async () => {
        const task = makeTask()
        expect((await patch(`/api/tasks/${task.id}`, { machineId: 'box-unknown' })).status).toBe(404)
    })
})

describe('POST /api/tasks/:id/move', () => {
    it('moves a card', async () => {
        const task = makeTask()
        const response = await post(`/api/tasks/${task.id}/move`, { column: 'review' })
        expect(response.status).toBe(200)
        expect((await response.json() as { task: { column: string } }).task.column).toBe('review')
    })

    it('rejects an unknown column', async () => {
        const task = makeTask()
        expect((await post(`/api/tasks/${task.id}/move`, { column: 'nope' })).status).toBe(400)
    })
})

describe('POST /api/tasks/:id/start', () => {
    it('refuses an archived task', async () => {
        const task = makeTask()
        store.tasks.archive(task.id, 'default')

        const response = await post(`/api/tasks/${task.id}/start`)
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'task_archived' })
    })

    it('starts a task', async () => {
        const task = makeTask()
        const response = await post(`/api/tasks/${task.id}/start`)

        expect(response.status).toBe(200)
        const body = await response.json() as { task: { column: string }; sessionId: string }
        expect(body.task.column).toBe('running')
        expect(body.sessionId).toBe('sess-1')
    })

    it('409s a task that is already running', async () => {
        const task = makeTask()
        await post(`/api/tasks/${task.id}/start`)

        const again = await post(`/api/tasks/${task.id}/start`)
        expect(again.status).toBe(409)
        expect(await again.json()).toMatchObject({ code: 'task_running' })
    })

    it('400s a task with no machine', async () => {
        const task = makeTask({ machineId: null })
        const response = await post(`/api/tasks/${task.id}/start`)
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ code: 'task_no_machine' })
    })

    it('502s when the runner refuses', async () => {
        spawnImpl = async () => ({ type: 'error', message: 'runner offline' })
        const task = makeTask()
        const response = await post(`/api/tasks/${task.id}/start`)

        expect(response.status).toBe(502)
        expect(await response.json()).toMatchObject({ code: 'spawn_failed', error: 'runner offline' })
        // Settled into the error column, where the failure is visible.
        expect(store.tasks.get(task.id)?.column).toBe('blocked')
    })

    it('503s when the orchestrator is not up yet', async () => {
        const task = makeTask()
        orchestrator = null
        expect((await post(`/api/tasks/${task.id}/start`)).status).toBe(503)
    })
})

describe('POST /api/tasks/:id/cancel', () => {
    it('cancels a running task', async () => {
        const task = makeTask()
        await post(`/api/tasks/${task.id}/start`)

        const response = await post(`/api/tasks/${task.id}/cancel`)
        expect(response.status).toBe(200)
        expect((await response.json() as { task: { column: string } }).task.column).toBe('ready')
        expect(abortCalls).toEqual(['sess-1'])
    })

    it('409s a task that is not running', async () => {
        const task = makeTask()
        const response = await post(`/api/tasks/${task.id}/cancel`)
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'task_not_running' })
    })
})

describe('archive lifecycle', () => {
    it('archives and restores a card in Done', async () => {
        const task = makeTask({ column: 'done' })
        expect((await post(`/api/tasks/${task.id}/archive`)).status).toBe(200)
        expect((await post(`/api/tasks/${task.id}/archive`)).status).toBe(409)
        expect((await post(`/api/tasks/${task.id}/unarchive`)).status).toBe(200)
        expect((await post(`/api/tasks/${task.id}/unarchive`)).status).toBe(409)
    })

    it('refuses to archive a card that is not in Done', async () => {
        const task = makeTask()
        const response = await post(`/api/tasks/${task.id}/archive`)
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'task_not_done', column: 'backlog' })
        expect(store.tasks.get(task.id)?.archivedAt).toBeNull()
    })

    it('force archives a card that never reached Done', async () => {
        const task = makeTask()
        expect((await post(`/api/tasks/${task.id}/archive`, { force: true })).status).toBe(200)
    })

    it('refuses to archive a running task', async () => {
        const task = makeTask()
        await post(`/api/tasks/${task.id}/start`)
        const response = await post(`/api/tasks/${task.id}/archive`, { force: true })
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'task_running' })
    })

    it('stops the run and archives when asked to', async () => {
        const task = makeTask({ column: 'done' })
        await post(`/api/tasks/${task.id}/start`)
        // Starting moves the card to `running`; put it back, because the case
        // under test is the one that actually happens on this board -- a card
        // marked Done whose Claude Code session never exited.
        store.tasks.move(task.id, 'default', 'done')

        const response = await post(`/api/tasks/${task.id}/archive`, { stopRun: true })
        expect(response.status).toBe(200)

        const archived = store.tasks.get(task.id)
        expect(archived?.archivedAt).not.toBeNull()
        // The run is settled, and the cancel did not quietly un-finish the card
        // by leaving it in the `ready` column cancellation normally implies.
        expect(store.tasks.getActiveRun(task.id)).toBeNull()
        expect(archived?.column).toBe('done')
    })
})

describe('archive teardown', () => {
    /** A card with a checkout on disk and a session still attached to it --
     *  what every card on this board looks like by the time it reaches Done.
     *  `orphaned` is the default because it is what this board actually
     *  produces: a restart settles the run while the agent keeps going. */
    function settledCard(status: 'succeeded' | 'orphaned' = 'orphaned'): StoredTask {
        const task = reviewableTask()
        const run = store.tasks.getActiveRun(task.id)
        store.tasks.finishRun(run!.id, { status, column: 'done' })
        return store.tasks.get(task.id) as StoredTask
    }

    it('retires the session and removes the checkout, keeping the branch', async () => {
        const task = settledCard()
        const response = await post(`/api/tasks/${task.id}/archive`)

        expect(response.status).toBe(200)
        expect(stopSessionCalls).toEqual([{ machineId: KNOWN_MACHINE, sessionId: 'sess-1' }])
        expect(removeWorktreeCalls).toHaveLength(1)
        // The branch carries every commit the card produced, and archiving is
        // reversible -- so teardown must ask for the checkout only.
        expect(removeWorktreeCalls[0].branch).toBeUndefined()
        expect(removeWorktreeCalls[0].worktreePath).toBe('/repo-worktrees/fix')
        expect(await response.json()).toMatchObject({ session: 'stopped' })
    })

    it('stops a session the run gate cannot see', async () => {
        // The case this board actually hits: a restart settles the run while
        // the agent keeps running, so `getActiveRun` is null and the old
        // `stopRun` gate never fires -- yet a live session is still out there.
        const task = settledCard()
        expect(store.tasks.getActiveRun(task.id)).toBeNull()

        await post(`/api/tasks/${task.id}/archive`)
        expect(stopSessionCalls).toHaveLength(1)
    })

    it('refuses to archive over uncommitted work', async () => {
        const task = settledCard()
        removeWorktreeImpl = async () => ({ outcome: 'dirty', changedFiles: 3 })

        const response = await post(`/api/tasks/${task.id}/archive`)
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'worktree_dirty', changedFiles: 3 })
        // The card has to stay reachable -- it is the only way back to the
        // worktree holding that work.
        expect(store.tasks.get(task.id)?.archivedAt).toBeNull()
        // Asked before anything was stopped: the agent keeps its session.
        expect(stopSessionCalls).toHaveLength(0)
        expect(removeWorktreeCalls).toHaveLength(0)
    })

    it('refuses over uncommitted work before stopping a live run', async () => {
        const task = reviewableTask()
        store.tasks.move(task.id, 'default', 'done')
        removeWorktreeImpl = async () => ({ outcome: 'dirty', changedFiles: 2 })

        const response = await post(`/api/tasks/${task.id}/archive`, { stopRun: true })
        expect(response.status).toBe(409)
        expect(store.tasks.getActiveRun(task.id)).not.toBeNull()
        expect(store.tasks.get(task.id)?.column).toBe('done')
        expect(abortCalls).toHaveLength(0)
        expect(stopSessionCalls).toHaveLength(0)
    })

    it('pauses the schedule of an archived task, and unarchiving leaves it paused', async () => {
        const task = settledCard()
        store.taskSchedules.upsert({
            taskId: task.id, namespace: 'default', cron: '0 9 * * *', tz: 'UTC', catchup: true,
            overlap: 'skip', sessionMode: 'fresh', maxRunMs: 3_600_000, nextRunAt: Date.now() + 60_000
        })

        expect((await post(`/api/tasks/${task.id}/archive`)).status).toBe(200)
        expect(store.taskSchedules.get(task.id)).toMatchObject({ enabled: false, pausedReason: 'archived' })

        expect((await post(`/api/tasks/${task.id}/unarchive`)).status).toBe(200)
        expect(store.taskSchedules.get(task.id)?.enabled).toBe(false)
    })

    it('archives over uncommitted work when forced', async () => {
        const task = settledCard()
        removeWorktreeImpl = async () => ({ outcome: 'removed', branch: 'skipped' })

        const response = await post(`/api/tasks/${task.id}/archive`, { forceWorktree: true })
        expect(response.status).toBe(200)
        expect(probeCalls).toHaveLength(0)
        expect(removeWorktreeCalls[0].force).toBe(true)
        expect(store.tasks.get(task.id)?.archivedAt).not.toBeNull()
    })

    it('keeps the checkout when asked, but still retires the session', async () => {
        const task = settledCard()
        const response = await post(`/api/tasks/${task.id}/archive`, { keepWorktree: true })

        expect(response.status).toBe(200)
        expect(removeWorktreeCalls).toHaveLength(0)
        expect(stopSessionCalls).toHaveLength(1)
    })

    it('does not tear down twice when archive is repeated', async () => {
        const task = settledCard()
        expect((await post(`/api/tasks/${task.id}/archive`)).status).toBe(200)

        const again = await post(`/api/tasks/${task.id}/archive`)
        expect(again.status).toBe(409)
        // A double click must not pay for teardown a second time -- by then the
        // checkout is gone and the second call would report a bogus failure.
        expect(removeWorktreeCalls).toHaveLength(1)
        expect(stopSessionCalls).toHaveLength(1)
    })

    it('reports a session the runner could not stop', async () => {
        // The runner drops its handles on restart, so it answers `still_alive`:
        // it signalled nothing and the agent is still out there. Reporting that
        // as stopped would hide a live process behind a card that just went
        // away -- which is how one got missed.
        const task = settledCard()
        stopSessionStatus = 'still_alive'

        const response = await post(`/api/tasks/${task.id}/archive`)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ session: 'still-alive' })
    })

    it('does not report a session the hub already holds as inactive', async () => {
        // A runner restart leaves it answering `still_alive` for every session
        // it never met, long-dead ones included. With no agent connected to
        // the hub there is no process to warn about.
        seedSession('sess-gone')
        const task = makeTask({ baseRef: 'main' })
        store.tasks.startRun({
            taskId: task.id, namespace: 'default', origin: 'user',
            sessionId: 'sess-gone', branch: 'hapi/fix', worktreePath: '/repo-worktrees/fix'
        })
        store.tasks.finishRun(store.tasks.getActiveRun(task.id)!.id, { status: 'succeeded', column: 'done' })
        stopSessionStatus = 'still_alive'

        const response = await post(`/api/tasks/${task.id}/archive`)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ session: 'already-gone' })
    })

    it('distinguishes an agent that had already exited', async () => {
        const task = settledCard()
        stopSessionStatus = 'already_gone'

        const response = await post(`/api/tasks/${task.id}/archive`)
        expect(await response.json()).toMatchObject({ session: 'already-gone' })
    })

    it('archives anyway when the machine is offline', async () => {
        const task = settledCard()
        machineCapabilities = null

        const response = await post(`/api/tasks/${task.id}/archive`)
        expect(response.status).toBe(200)
        // Disk state left behind is worth reporting; it is not worth stranding
        // the card on the board over.
        expect(await response.json()).toMatchObject({
            worktree: { outcome: 'skipped', reason: 'machine-offline' }
        })
    })
})

describe('DELETE /api/tasks/:id', () => {
    it('deletes a settled task', async () => {
        const task = makeTask()
        const response = await app.request(`/api/tasks/${task.id}`, { method: 'DELETE' })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
            deleted: true,
            worktree: { outcome: 'skipped', reason: 'no-worktree' }
        })
        expect(store.tasks.get(task.id)).toBeNull()
    })

    it('refuses to delete a running task', async () => {
        const task = makeTask()
        await post(`/api/tasks/${task.id}/start`)
        const response = await app.request(`/api/tasks/${task.id}`, { method: 'DELETE' })
        expect(response.status).toBe(409)
        expect(store.tasks.get(task.id)).not.toBeNull()
    })

    it('stops a run on a card parked outside running, then deletes', async () => {
        const task = makeTask()
        await post(`/api/tasks/${task.id}/start`)
        // A card parked in backlog while its session is still up: delete is the
        // only way out, so it has to be able to stop the agent.
        store.tasks.move(task.id, 'default', 'backlog')

        const response = await app.request(`/api/tasks/${task.id}?stopRun=true`, { method: 'DELETE' })

        expect(response.status).toBe(200)
        expect(stopSessionCalls).toHaveLength(1)
        expect(store.tasks.get(task.id)).toBeNull()
    })

    it('stops the run and deletes after explicit confirmation', async () => {
        const task = makeTask()
        await post(`/api/tasks/${task.id}/start`)

        const response = await app.request(`/api/tasks/${task.id}?stopRun=true`, { method: 'DELETE' })

        expect(response.status).toBe(200)
        expect(abortCalls).toEqual(['sess-1'])
        expect(stopSessionCalls).toEqual([{ machineId: KNOWN_MACHINE, sessionId: 'sess-1' }])
        expect(store.tasks.get(task.id)).toBeNull()
    })
})

describe('GET /api/tasks/:id/runs', () => {
    it('returns run history newest first', async () => {
        const task = makeTask()
        await post(`/api/tasks/${task.id}/start`)
        await post(`/api/tasks/${task.id}/cancel`)
        await post(`/api/tasks/${task.id}/start`)

        const body = await (await app.request(`/api/tasks/${task.id}/runs`)).json() as {
            runs: Array<{ status: string }>
        }
        expect(body.runs.map((run) => run.status)).toEqual(['running', 'canceled'])
    })

    it('validates the limit', async () => {
        const task = makeTask()
        expect((await app.request(`/api/tasks/${task.id}/runs?limit=-1`)).status).toBe(400)
    })
})

describe('pull request routes', () => {
    it('opens a pull request and caches it on the task', async () => {
        stubFetch([
            ['/pulls', { status: 201, body: OPEN_PULL }],
            ['/check-runs', { status: 200, body: { check_runs: [] } }]
        ])
        const task = reviewableTask()

        const response = await post(`/api/tasks/${task.id}/pr`, {})
        expect(response.status).toBe(201)

        const body = await response.json() as {
            task: { pullRequest: { number: number; state: string } | null }
            pullRequest: { url: string }
        }
        expect(body.pullRequest.url).toBe('https://github.com/acme/widget/pull/7')
        expect(body.task.pullRequest).toMatchObject({ number: 7, state: 'open' })
    })

    it('400s a task with no branch', async () => {
        const task = makeTask()
        const response = await post(`/api/tasks/${task.id}/pr`, {})
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ code: 'task_no_branch' })
    })

    it('409s when the session needed for the push is gone', async () => {
        const task = reviewableTask()
        store.tasks.finishRun(store.tasks.getActiveRun(task.id)!.id, {
            status: 'succeeded', clearSession: true
        })

        const response = await post(`/api/tasks/${task.id}/pr`, {})
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'session_offline' })
    })

    it('400s a host with no token, naming the host', async () => {
        gitHostTokens = {}
        const task = reviewableTask()

        const response = await post(`/api/tasks/${task.id}/pr`, {})
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ code: 'git_host_no_token', host: 'github.com' })
    })

    it('502s a rejected push', async () => {
        commandImpl = async (_sessionId, options) => options.command.startsWith('git push')
            ? { success: false, stderr: 'hook declined', exitCode: 1 }
            : { success: true, stdout: 'git@github.com:acme/widget.git', exitCode: 0 }
        const task = reviewableTask()

        const response = await post(`/api/tasks/${task.id}/pr`, {})
        expect(response.status).toBe(502)
        expect(await response.json()).toMatchObject({ code: 'push_failed' })
    })

    it('403s an expired forge token', async () => {
        stubFetch([['/pulls', { status: 401, body: { message: 'Bad credentials' } }]])
        const task = reviewableTask()

        const response = await post(`/api/tasks/${task.id}/pr`, {})
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({ code: 'git_host_unauthorized' })
    })

    it('refreshes a cached pull request without a session', async () => {
        stubFetch([
            ['/pulls', { status: 201, body: OPEN_PULL }],
            ['/check-runs', { status: 200, body: { check_runs: [] } }]
        ])
        const task = reviewableTask()
        await post(`/api/tasks/${task.id}/pr`, {})

        store.tasks.finishRun(store.tasks.getActiveRun(task.id)!.id, {
            status: 'succeeded', column: 'review', clearSession: true
        })
        stubFetch([
            ['/pulls/7', { status: 200, body: { ...OPEN_PULL, merged_at: '2026-01-01T00:00:00Z' } }],
            ['/check-runs', { status: 200, body: { check_runs: [{ status: 'completed', conclusion: 'failure' }] } }]
        ])

        const response = await post(`/api/tasks/${task.id}/pr/refresh`)
        expect(response.status).toBe(200)
        const body = await response.json() as { pullRequest: { state: string; checks: string } }
        expect(body.pullRequest.state).toBe('merged')
        expect(body.pullRequest.checks).toBe('failing')
    })

    it('404s a refresh with nothing to refresh', async () => {
        const task = reviewableTask()
        const response = await post(`/api/tasks/${task.id}/pr/refresh`)
        expect(response.status).toBe(404)
        expect(await response.json()).toMatchObject({ code: 'no_pull_request' })
    })

    it('forgets a cached pull request', async () => {
        stubFetch([
            ['/pulls', { status: 201, body: OPEN_PULL }],
            ['/check-runs', { status: 200, body: { check_runs: [] } }]
        ])
        const task = reviewableTask()
        await post(`/api/tasks/${task.id}/pr`, {})

        const response = await app.request(`/api/tasks/${task.id}/pr`, { method: 'DELETE' })
        expect(response.status).toBe(200)
        expect((await response.json() as { task: { pullRequest: unknown } }).task.pullRequest).toBeNull()
    })

    it('400s a malformed body', async () => {
        const task = reviewableTask()
        expect((await post(`/api/tasks/${task.id}/pr`, { title: 'x'.repeat(300) })).status).toBe(400)
        expect((await post(`/api/tasks/${task.id}/pr`, { baseBranch: 42 })).status).toBe(400)
    })

    it('403s pull request actions outside the owner namespace', async () => {
        const tenant = createApp('tenant')
        const task = store.tasks.create({
            namespace: 'tenant', title: 't', prompt: 'p', workdir: '/repo',
            machineId: KNOWN_MACHINE, spawn: { flavor: 'claude' }
        })

        for (const [method, path] of [
            ['POST', `/api/tasks/${task.id}/pr`],
            ['POST', `/api/tasks/${task.id}/pr/refresh`],
            ['DELETE', `/api/tasks/${task.id}/pr`]
        ] as const) {
            const response = await tenant.request(path, { method })
            expect(response.status).toBe(403)
            expect(await response.json()).toMatchObject({ code: 'git_host_owner_only' })
        }
    })

    it('503s when the review service is not up', async () => {
        const task = reviewableTask()
        review = null
        expect((await post(`/api/tasks/${task.id}/pr`, {})).status).toBe(503)
    })
})

describe('DELETE worktree teardown', () => {
    /** A deleted card's worktree can only be torn down if the task recorded one. */
    function taskWithWorktree(): StoredTask {
        const task = reviewableTask()
        store.tasks.finishRun(store.tasks.getActiveRun(task.id)!.id, {
            status: 'succeeded', column: 'review', clearSession: true
        })
        return store.tasks.get(task.id) as StoredTask
    }

    it('removes the worktree and reports the branch outcome', async () => {
        const task = taskWithWorktree()
        const response = await app.request(`/api/tasks/${task.id}`, { method: 'DELETE' })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
            deleted: true,
            worktree: { outcome: 'removed', branch: 'deleted' }
        })
        expect(removeWorktreeCalls[0]).toEqual({
            worktreePath: '/repo-worktrees/fix',
            branch: 'hapi/fix',
            force: false
        })
        expect(store.tasks.get(task.id)).toBeNull()
    })

    it('refuses to delete when the worktree has uncommitted work', async () => {
        removeWorktreeImpl = async () => ({ outcome: 'dirty', changedFiles: 3 })
        const task = taskWithWorktree()

        const response = await app.request(`/api/tasks/${task.id}`, { method: 'DELETE' })
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'worktree_dirty', changedFiles: 3 })
        // The card is still there — nothing was destroyed.
        expect(store.tasks.get(task.id)).not.toBeNull()
        expect(removeWorktreeCalls).toHaveLength(0)
        expect(stopSessionCalls).toHaveLength(0)
    })

    it('refuses over uncommitted work before cancelling a live run', async () => {
        removeWorktreeImpl = async () => ({ outcome: 'dirty', changedFiles: 1 })
        const task = reviewableTask()
        const columnBefore = store.tasks.get(task.id)?.column

        const response = await app.request(`/api/tasks/${task.id}?stopRun=true`, { method: 'DELETE' })
        expect(response.status).toBe(409)
        // Not cancelled into `ready`, not stopped: exactly as it was.
        expect(store.tasks.getActiveRun(task.id)).not.toBeNull()
        expect(store.tasks.get(task.id)?.column).toBe(columnBefore)
        expect(abortCalls).toHaveLength(0)
        expect(stopSessionCalls).toHaveLength(0)
    })

    it('takes the schedule with it', async () => {
        const task = taskWithWorktree()
        store.taskSchedules.upsert({
            taskId: task.id, namespace: 'default', cron: '0 9 * * *', tz: 'UTC', catchup: true,
            overlap: 'skip', sessionMode: 'fresh', maxRunMs: 3_600_000, nextRunAt: Date.now() + 60_000
        })

        expect((await app.request(`/api/tasks/${task.id}`, { method: 'DELETE' })).status).toBe(200)
        expect(store.taskSchedules.get(task.id)).toBeNull()
    })

    it('deletes anyway with force', async () => {
        let seenForce: boolean | undefined
        removeWorktreeImpl = async () => ({ outcome: 'removed', branch: 'kept-unmerged' })
        const task = taskWithWorktree()

        const response = await app.request(`/api/tasks/${task.id}?force=true`, { method: 'DELETE' })
        seenForce = removeWorktreeCalls[0]?.force

        expect(response.status).toBe(200)
        expect(seenForce).toBe(true)
        // An unmerged branch survives; the response says so.
        expect(await response.json()).toMatchObject({ worktree: { branch: 'kept-unmerged' } })
    })

    it('leaves the worktree alone when asked to', async () => {
        const task = taskWithWorktree()
        const response = await app.request(`/api/tasks/${task.id}?worktree=keep`, { method: 'DELETE' })

        expect(response.status).toBe(200)
        expect(removeWorktreeCalls).toHaveLength(0)
        expect(store.tasks.get(task.id)).toBeNull()
    })

    it('still deletes the card when the runner is too old to help', async () => {
        machineCapabilities = ['stop-runner']
        const task = taskWithWorktree()

        const response = await app.request(`/api/tasks/${task.id}`, { method: 'DELETE' })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
            worktree: { outcome: 'skipped', reason: 'unsupported-runner' }
        })
        expect(store.tasks.get(task.id)).toBeNull()
    })

    it('still deletes the card when the machine is offline', async () => {
        machineCapabilities = null
        const task = taskWithWorktree()

        const response = await app.request(`/api/tasks/${task.id}`, { method: 'DELETE' })
        expect(await response.json()).toMatchObject({
            worktree: { outcome: 'skipped', reason: 'machine-offline' }
        })
        expect(store.tasks.get(task.id)).toBeNull()
    })

    it('still deletes the card when the teardown errors', async () => {
        removeWorktreeImpl = async () => { throw new Error('rpc timeout') }
        const task = taskWithWorktree()

        const response = await app.request(`/api/tasks/${task.id}`, { method: 'DELETE' })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
            worktree: { outcome: 'error', message: 'rpc timeout' }
        })
        expect(store.tasks.get(task.id)).toBeNull()
    })
})

describe('workspace user scoping', () => {
    /** Two people on one hub: Kai works in /repo, Ming in /other. */
    function seedTwoOwners(): { kai: string } {
        makeTask({ workdir: '/repo', title: 'Kai task' })
        makeTask({ workdir: '/other/proj', title: 'Ming task' })
        const kai = store.workspaceUsers.create({
            namespace: 'default', name: 'Kai', paths: ['/repo']
        })
        return { kai: kai.id }
    }

    it('returns only tasks under the selected user roots', async () => {
        const { kai } = seedTwoOwners()

        const response = await app.request(`/api/tasks?workspaceUser=${kai}`)
        expect(response.status).toBe(200)
        const body = await response.json() as { tasks: Array<{ title: string }> }
        expect(body.tasks.map((task) => task.title)).toEqual(['Kai task'])
    })

    it('counts only the selected user tasks in the column headers', async () => {
        const { kai } = seedTwoOwners()

        const body = await (await app.request(`/api/tasks?workspaceUser=${kai}`)).json() as {
            counts: Record<string, number>
        }
        expect(body.counts.backlog).toBe(1)
    })

    it('claims a worktree checkout through its source repo', async () => {
        // The checkout is a sibling of the repo, so `workdir` is the only
        // field that can place this card with its owner.
        const task = makeTask({ workdir: '/repo', title: 'Worktree task' })
        store.tasks.startRun({
            taskId: task.id, namespace: 'default', origin: 'user',
            sessionId: 'sess-1', branch: 'hapi/fix', worktreePath: '/repo-worktrees/fix'
        })
        const kai = store.workspaceUsers.create({
            namespace: 'default', name: 'Kai', paths: ['/repo']
        })

        const body = await (await app.request(`/api/tasks?workspaceUser=${kai.id}`)).json() as {
            tasks: Array<{ title: string }>
        }
        expect(body.tasks.map((task) => task.title)).toContain('Worktree task')
    })

    it('shows everything when no user is selected', async () => {
        seedTwoOwners()

        const body = await (await app.request('/api/tasks')).json() as { tasks: unknown[] }
        expect(body.tasks).toHaveLength(2)
    })

    it('404s an unknown user rather than falling back to everything', async () => {
        seedTwoOwners()

        const response = await app.request('/api/tasks?workspaceUser=gone')
        expect(response.status).toBe(404)
    })

    it('does not leak a user across namespaces', async () => {
        const kai = store.workspaceUsers.create({
            namespace: 'default', name: 'Kai', paths: ['/repo']
        })
        const otherNamespace = createApp('other')

        const response = await otherNamespace.request(`/api/tasks?workspaceUser=${kai.id}`)
        expect(response.status).toBe(404)
    })
})
