import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store, type StoredTask } from '../../store'
import type { StartTaskResult } from '../../sync/taskOrchestrator'
import { TaskScheduler } from '../../sync/taskScheduler'
import type { WebAppEnv } from '../middleware/auth'
import { createTaskScheduleRoutes } from './taskSchedules'

const HOURLY = '0 * * * *'

let store: Store
let scheduler: TaskScheduler | null
let machineOnline: boolean
let startImpl: (taskId: string) => Promise<StartTaskResult>
let app: Hono<WebAppEnv>

function createApp(namespace = 'default'): Hono<WebAppEnv> {
    const instance = new Hono<WebAppEnv>()
    instance.use('*', async (c, next) => {
        c.set('namespace', namespace)
        c.set('userId', 1)
        await next()
    })
    instance.route('/api', createTaskScheduleRoutes({ store, getTaskScheduler: () => scheduler }))
    return instance
}

function makeTask(overrides: Partial<Parameters<Store['tasks']['create']>[0]> = {}): StoredTask {
    return store.tasks.create({
        namespace: 'default',
        title: 'Nightly deps check',
        prompt: 'Check dependencies.',
        workdir: '/repo',
        machineId: 'box-1',
        isolation: 'worktree',
        spawn: { flavor: 'claude', permissionMode: 'bypassPermissions' },
        ...overrides
    })
}

async function request(method: string, path: string, body?: unknown, on: Hono<WebAppEnv> = app): Promise<Response> {
    return await on.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    })
}

async function scheduled(): Promise<StoredTask> {
    const task = makeTask()
    expect((await request('PUT', `/api/tasks/${task.id}/schedule`, { cron: HOURLY, tz: 'UTC' })).status).toBe(200)
    return task
}

beforeEach(() => {
    store = new Store(':memory:')
    machineOnline = true
    startImpl = async () => { throw new Error('startTask not stubbed') }
    scheduler = new TaskScheduler({
        store,
        startTask: async (taskId) => await startImpl(taskId),
        getSession: () => null,
        isMachineOnline: () => machineOnline,
        retireSession: async () => 'none',
        logger: { error: () => {} }
    })
    app = createApp()
})

afterEach(() => {
    store.close()
})

describe('schedule writes', () => {
    it('saves a schedule and reads it back', async () => {
        const task = await scheduled()
        const body = await (await request('GET', `/api/tasks/${task.id}/schedule`)).json() as {
            schedule: { cron: string; enabled: boolean } | null
        }
        expect(body.schedule).toMatchObject({ cron: HOURLY, enabled: true })
    })

    it('maps a refused spec onto a schedule_ code', async () => {
        const task = makeTask()
        const response = await request('PUT', `/api/tasks/${task.id}/schedule`, { cron: '*/5 * * * *', tz: 'UTC' })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ code: 'schedule_too-frequent' })
    })

    it('maps a refused task onto a schedule_ code', async () => {
        const task = makeTask({ isolation: 'simple' })
        const response = await request('PUT', `/api/tasks/${task.id}/schedule`, { cron: HOURLY, tz: 'UTC' })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ code: 'schedule_not-worktree' })
    })

    it('400s a malformed body', async () => {
        const task = makeTask()
        expect((await request('PUT', `/api/tasks/${task.id}/schedule`, { cron: '' })).status).toBe(400)
    })

    it('503s when the scheduler is not up', async () => {
        const task = makeTask()
        scheduler = null
        expect((await request('PUT', `/api/tasks/${task.id}/schedule`, { cron: HOURLY, tz: 'UTC' })).status).toBe(503)
    })

    it('pauses and resumes', async () => {
        const task = await scheduled()
        const paused = await (await request('POST', `/api/tasks/${task.id}/schedule/pause`)).json() as {
            schedule: { enabled: boolean; pausedReason: string | null }
        }
        expect(paused.schedule).toMatchObject({ enabled: false, pausedReason: 'user' })

        const resumed = await (await request('POST', `/api/tasks/${task.id}/schedule/resume`)).json() as {
            schedule: { enabled: boolean }
        }
        expect(resumed.schedule.enabled).toBe(true)
    })

    it('404s pausing a task with no schedule', async () => {
        const task = makeTask()
        expect((await request('POST', `/api/tasks/${task.id}/schedule/pause`)).status).toBe(404)
    })
})

describe('namespaces', () => {
    it('404s another namespace\'s task on every route', async () => {
        const task = await scheduled()
        const tenant = createApp('tenant')

        for (const [method, path, body] of [
            ['GET', `/api/tasks/${task.id}/schedule`, undefined],
            ['PUT', `/api/tasks/${task.id}/schedule`, { cron: HOURLY, tz: 'UTC' }],
            ['DELETE', `/api/tasks/${task.id}/schedule`, undefined],
            ['POST', `/api/tasks/${task.id}/schedule/pause`, undefined],
            ['POST', `/api/tasks/${task.id}/schedule/resume`, undefined],
            ['POST', `/api/tasks/${task.id}/schedule/run-now`, undefined],
            ['GET', `/api/tasks/${task.id}/schedule/slots`, undefined]
        ] as const) {
            expect((await request(method, path, body, tenant)).status).toBe(404)
        }
        // And nothing was changed through them.
        expect(store.taskSchedules.get(task.id)?.enabled).toBe(true)
    })

    it('lists only the caller\'s schedules', async () => {
        await scheduled()
        const tenant = createApp('tenant')
        const body = await (await request('GET', '/api/schedules', undefined, tenant)).json() as { schedules: unknown[] }
        expect(body.schedules).toEqual([])
    })
})

describe('run-now', () => {
    it('starts a run and returns its slot', async () => {
        const task = await scheduled()
        startImpl = async () => ({ outcome: 'started', task, runId: 'run-1', sessionId: 'sess-1' })

        const response = await request('POST', `/api/tasks/${task.id}/schedule/run-now`)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ slot: { trigger: 'manual', status: 'started', runId: 'run-1' } })
    })

    it('404s a task without a schedule', async () => {
        const task = makeTask()
        expect((await request('POST', `/api/tasks/${task.id}/schedule/run-now`)).status).toBe(404)
    })

    it('409s while a run is going', async () => {
        const task = await scheduled()
        store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user' })

        const response = await request('POST', `/api/tasks/${task.id}/schedule/run-now`)
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'task_running' })
    })

    it('409s when the machine is offline', async () => {
        const task = await scheduled()
        machineOnline = false

        const response = await request('POST', `/api/tasks/${task.id}/schedule/run-now`)
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'machine_offline' })
    })

    it('409s a task that can no longer run on a schedule', async () => {
        const task = await scheduled()
        store.tasks.update(task.id, 'default', { isolation: 'simple' })

        const response = await request('POST', `/api/tasks/${task.id}/schedule/run-now`)
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'schedule_not-worktree' })
        expect(store.taskSchedules.get(task.id)?.pausedReason).toBe('not-worktree')
    })

    it('502s a run that could not be started', async () => {
        const task = await scheduled()
        startImpl = async () => ({ outcome: 'spawn-failed', task, message: 'runner refused' })

        const response = await request('POST', `/api/tasks/${task.id}/schedule/run-now`)
        expect(response.status).toBe(502)
        expect(await response.json()).toMatchObject({ code: 'spawn_failed', error: 'runner refused' })
    })
})
