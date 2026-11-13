import {
    TaskScheduleInputSchema,
    type TaskSchedule,
    type TaskScheduleSlot
} from '@hapi/protocol'
import { Hono, type Context } from 'hono'
import { toPublicSchedule, type Store, type StoredTask } from '../../store'
import type { ScheduleWriteResult, TaskScheduler } from '../../sync/taskScheduler'
import type { WebAppEnv } from '../middleware/auth'
import { resolveWorkspaceScope, taskInScope } from './workspaceScope'

/**
 * Schedule REST surface. The scheduler owns every write; reads come straight
 * from the store.
 */

export type TaskScheduleResponse = { schedule: TaskSchedule | null }
export type TaskScheduleListResponse = { schedules: TaskSchedule[] }
export type TaskScheduleSlotsResponse = { slots: TaskScheduleSlot[] }

const DEFAULT_SLOT_LIMIT = 50
const MAX_SLOT_LIMIT = 200

function requireTask(c: Context<WebAppEnv>, store: Store): StoredTask | Response {
    const row = store.tasks.getByNamespace(c.req.param('id') ?? '', c.get('namespace'))
    return row ?? c.json({ error: 'Task not found' }, 404)
}

function requireScheduler(c: Context<WebAppEnv>, getTaskScheduler: () => TaskScheduler | null): TaskScheduler | Response {
    return getTaskScheduler() ?? c.json({ error: 'Not connected' }, 503)
}

function writeResponse(c: Context<WebAppEnv>, result: ScheduleWriteResult): Response {
    switch (result.outcome) {
        case 'ok':
            return c.json({ schedule: toPublicSchedule(result.schedule) } satisfies TaskScheduleResponse)
        case 'task-not-found':
            return c.json({ error: 'Task not found' }, 404)
        case 'invalid':
            return c.json({ error: result.message ?? result.code, code: `schedule_${result.code}` }, 400)
    }
}

export function createTaskScheduleRoutes(options: {
    store: Store
    getTaskScheduler: () => TaskScheduler | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const { store, getTaskScheduler } = options

    app.get('/schedules', (c) => {
        const scope = resolveWorkspaceScope(c, store, c.req.query('workspaceUser'))
        if (scope instanceof Response) return scope
        const schedules = store.taskSchedules.list(c.get('namespace'))
            .filter((schedule) => {
                if (!scope) return true
                const task = store.tasks.get(schedule.taskId)
                return task !== null && taskInScope(task, scope)
            })
            .map(toPublicSchedule)
        return c.json({ schedules } satisfies TaskScheduleListResponse)
    })

    app.get('/tasks/:id/schedule', (c) => {
        const task = requireTask(c, store)
        if (task instanceof Response) return task
        const schedule = store.taskSchedules.get(task.id, c.get('namespace'))
        return c.json({ schedule: schedule ? toPublicSchedule(schedule) : null } satisfies TaskScheduleResponse)
    })

    app.put('/tasks/:id/schedule', async (c) => {
        const task = requireTask(c, store)
        if (task instanceof Response) return task
        const scheduler = requireScheduler(c, getTaskScheduler)
        if (scheduler instanceof Response) return scheduler

        const parsed = TaskScheduleInputSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        return writeResponse(c, scheduler.upsertSchedule(task.id, c.get('namespace'), parsed.data))
    })

    app.delete('/tasks/:id/schedule', (c) => {
        const task = requireTask(c, store)
        if (task instanceof Response) return task
        const scheduler = requireScheduler(c, getTaskScheduler)
        if (scheduler instanceof Response) return scheduler
        scheduler.deleteSchedule(task.id, c.get('namespace'))
        return c.json({ schedule: null } satisfies TaskScheduleResponse)
    })

    app.post('/tasks/:id/schedule/pause', (c) => {
        const task = requireTask(c, store)
        if (task instanceof Response) return task
        const scheduler = requireScheduler(c, getTaskScheduler)
        if (scheduler instanceof Response) return scheduler
        const paused = scheduler.pauseSchedule(task.id, c.get('namespace'))
        if (!paused) return c.json({ error: 'Schedule not found' }, 404)
        return c.json({ schedule: toPublicSchedule(paused) } satisfies TaskScheduleResponse)
    })

    app.post('/tasks/:id/schedule/resume', (c) => {
        const task = requireTask(c, store)
        if (task instanceof Response) return task
        const scheduler = requireScheduler(c, getTaskScheduler)
        if (scheduler instanceof Response) return scheduler
        return writeResponse(c, scheduler.resumeSchedule(task.id, c.get('namespace')))
    })

    app.post('/tasks/:id/schedule/run-now', async (c) => {
        const task = requireTask(c, store)
        if (task instanceof Response) return task
        const scheduler = requireScheduler(c, getTaskScheduler)
        if (scheduler instanceof Response) return scheduler

        const result = await scheduler.runNow(task.id, c.get('namespace'))
        switch (result.outcome) {
            case 'started':
                return c.json({ slot: result.slot })
            case 'task-not-found':
                return c.json({ error: 'Schedule not found' }, 404)
            case 'already-running':
                return c.json({ error: 'Task is already running', code: 'task_running' }, 409)
            case 'machine-offline':
                return c.json({ error: 'The task\'s machine is offline', code: 'machine_offline' }, 409)
            case 'refused':
                return c.json({
                    error: `The task can no longer run on a schedule (${result.code}); the schedule was paused`,
                    code: `schedule_${result.code}`
                }, 409)
            case 'failed':
                return c.json({ error: result.message, code: 'spawn_failed' }, 502)
        }
    })

    app.get('/tasks/:id/schedule/slots', (c) => {
        const task = requireTask(c, store)
        if (task instanceof Response) return task
        const raw = Number(c.req.query('limit') ?? DEFAULT_SLOT_LIMIT)
        const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_SLOT_LIMIT) : DEFAULT_SLOT_LIMIT
        return c.json({ slots: store.taskSchedules.listSlots(task.id, limit) } satisfies TaskScheduleSlotsResponse)
    })

    return app
}
