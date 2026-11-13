import { beforeEach, describe, expect, it } from 'bun:test'
import { Store, type StoredTask } from '../store'
import { TaskOrchestrator, type OrchestratorSession } from './taskOrchestrator'
import { SCHEDULE_IDLE_SETTLE_MS, TaskScheduler } from './taskScheduler'
import type { WorktreeTeardownResult } from './taskWorktree'

const HOUR = 60 * 60_000
const HOURLY = '0 * * * *'

let store: Store
let orchestrator: TaskOrchestrator
let scheduler: TaskScheduler
let sessions: Map<string, OrchestratorSession>
let sentPrompts: Array<{ sessionId: string; text: string }>
let retired: string[]
let removed: Array<{ worktreePath: string }>
let machineOnline: boolean
let clock: number
let spawnCount: number
let reopenCalls: string[]
let reopenImpl: (sessionId: string) => Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }>

/** The top of an hour comfortably in the past, so runs opened at real time
 *  are never "in the future" of the scheduler's clock. */
const BASE = Math.floor(Date.now() / HOUR) * HOUR - 24 * HOUR

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

function schedule(task: StoredTask, nextRunAt: number, overrides: { overlap?: 'skip' | 'queue_one'; catchup?: boolean; sessionMode?: 'fresh' | 'continue' } = {}) {
    return store.taskSchedules.upsert({
        taskId: task.id,
        namespace: 'default',
        cron: HOURLY,
        tz: 'UTC',
        catchup: overrides.catchup ?? true,
        overlap: overrides.overlap ?? 'skip',
        sessionMode: overrides.sessionMode ?? 'fresh',
        maxRunMs: HOUR,
        nextRunAt
    })
}

function slots(task: StoredTask) {
    return store.taskSchedules.listSlots(task.id, 100)
}

/** The task's current session, whether or not a run is open on it. */
function currentSession(task: StoredTask): OrchestratorSession {
    const id = store.tasks.get(task.id)?.currentSessionId
    const session = id ? sessions.get(id) : undefined
    if (!session) throw new Error('no current session')
    return session
}

function activeSession(task: StoredTask): OrchestratorSession {
    const run = store.tasks.getActiveRun(task.id)
    const session = run?.sessionId ? sessions.get(run.sessionId) : undefined
    if (!session) throw new Error('no active session')
    return session
}

beforeEach(() => {
    store = new Store(':memory:')
    sessions = new Map()
    sentPrompts = []
    retired = []
    removed = []
    machineOnline = true
    clock = BASE
    spawnCount = 0
    reopenCalls = []
    reopenImpl = async (sessionId) => {
        const session = sessions.get(sessionId)
        if (!session) return { type: 'error', message: 'gone' }
        Object.assign(session, { active: true, thinking: true })
        return { type: 'success', sessionId }
    }

    orchestrator = new TaskOrchestrator({
        store,
        getSession: (id) => sessions.get(id) ?? null,
        spawnSession: async () => {
            spawnCount += 1
            const id = `sess-${spawnCount}`
            store.sessions.getOrCreateSession(id, { path: '/repo', host: 'box' }, null, 'default', undefined, undefined, undefined, id)
            sessions.set(id, { id, namespace: 'default', active: true, thinking: true })
            return { type: 'success', sessionId: id }
        },
        sendMessage: async (sessionId, text) => {
            sentPrompts.push({ sessionId, text })
        },
        reopenSession: async (sessionId) => {
            reopenCalls.push(sessionId)
            return await reopenImpl(sessionId)
        },
        subscribe: () => () => {},
        reattachWindowMs: 0
    })

    scheduler = new TaskScheduler({
        store,
        startTask: (taskId, namespace, options) => orchestrator.startTask(taskId, namespace, options),
        continueTask: (taskId, namespace, options) => orchestrator.continueTask(taskId, namespace, options),
        getSession: (id) => sessions.get(id) ?? null,
        isMachineOnline: () => machineOnline,
        retireSession: async (task) => {
            if (task.currentSessionId) {
                retired.push(task.currentSessionId)
                const session = sessions.get(task.currentSessionId)
                if (session) session.active = false
            }
            return 'stopped'
        },
        removeRunWorktree: async (_task, worktree): Promise<WorktreeTeardownResult> => {
            removed.push({ worktreePath: worktree.worktreePath })
            return { outcome: 'removed', branch: 'deleted' }
        },
        now: () => clock,
        startDelayMs: 0,
        logger: { error: (message, error) => { throw new Error(`${message}: ${String(error)}`) } }
    })
    scheduler.start()
    scheduler.stop()
})

describe('upsertSchedule', () => {
    it('refuses a cron that fires more often than every ten minutes', () => {
        const task = makeTask()
        const result = scheduler.upsertSchedule(task.id, 'default', { cron: '*/5 * * * *', tz: 'UTC' })
        expect(result).toMatchObject({ outcome: 'invalid', code: 'too-frequent' })
    })

    it('refuses a task that would stop on permission prompts', () => {
        const task = makeTask({ spawn: { flavor: 'gemini' } })
        const result = scheduler.upsertSchedule(task.id, 'default', { cron: HOURLY, tz: 'UTC' })
        expect(result).toMatchObject({ outcome: 'invalid', code: 'not-unattended' })
    })

    it('places the cursor on the next fire in the schedule\'s zone', () => {
        const task = makeTask()
        const result = scheduler.upsertSchedule(task.id, 'default', { cron: '0 9 * * *', tz: 'Asia/Shanghai' })
        expect(result.outcome).toBe('ok')
        if (result.outcome !== 'ok') return
        expect(new Date(result.schedule.nextRunAt!).getUTCHours()).toBe(1)
    })
})

describe('firing', () => {
    it('starts one scheduled run per fire, however often it ticks', async () => {
        const task = makeTask()
        schedule(task, BASE)

        await scheduler.tick()
        await scheduler.tick()

        expect(spawnCount).toBe(1)
        expect(slots(task)).toHaveLength(1)
        expect(slots(task)[0]).toMatchObject({ status: 'started', trigger: 'cron', scheduledFor: BASE })
        expect(store.tasks.getActiveRun(task.id)?.origin).toBe('scheduled')
        expect(sentPrompts[0]?.text).toContain('Nobody is watching this run')
        expect(sentPrompts[0]?.text).toContain('Check dependencies.')
        expect(store.taskSchedules.get(task.id)?.nextRunAt).toBe(BASE + HOUR)
    })

    it('runs the latest missed fire once after downtime and records the rest', async () => {
        const task = makeTask()
        schedule(task, BASE)
        clock = BASE + 2 * HOUR + 10 * 60_000

        await scheduler.tick()

        expect(spawnCount).toBe(1)
        const byTime = slots(task).sort((a, b) => a.scheduledFor - b.scheduledFor)
        expect(byTime.map((slot) => slot.status)).toEqual(['missed', 'missed', 'started'])
        expect(byTime[2]).toMatchObject({ trigger: 'catchup', scheduledFor: BASE + 2 * HOUR })
        expect(store.taskSchedules.get(task.id)?.nextRunAt).toBe(BASE + 3 * HOUR)
    })

    it('does not catch up a fire past its grace window', async () => {
        const task = makeTask()
        schedule(task, BASE)
        clock = BASE + 40 * 60_000

        await scheduler.tick()

        expect(spawnCount).toBe(0)
        expect(slots(task)[0]).toMatchObject({ status: 'missed', reason: 'outside-window' })
    })

    it('skips a fire while the previous run is going, and still moves on', async () => {
        const task = makeTask()
        schedule(task, BASE)
        await scheduler.tick()

        clock = BASE + HOUR
        await scheduler.tick()

        expect(spawnCount).toBe(1)
        expect(slots(task).find((slot) => slot.scheduledFor === BASE + HOUR))
            .toMatchObject({ status: 'skipped', reason: 'previous-run-active' })
        expect(store.taskSchedules.get(task.id)?.nextRunAt).toBe(BASE + 2 * HOUR)
    })

    it('holds one fire for queue_one and runs it when the previous run ends', async () => {
        const task = makeTask()
        schedule(task, BASE, { overlap: 'queue_one' })
        await scheduler.tick()

        clock = BASE + HOUR
        await scheduler.tick()
        expect(slots(task).find((slot) => slot.scheduledFor === BASE + HOUR)?.status).toBe('queued')

        // Canceling aborts the turn; the agent stays up, idle.
        await orchestrator.cancelTask(task.id, 'default')
        currentSession(task).thinking = false
        await scheduler.tick()

        expect(spawnCount).toBe(2)
        expect(slots(task).find((slot) => slot.scheduledFor === BASE + HOUR)?.status).toBe('started')
    })

    it('waits for an offline machine within the window, then gives up', async () => {
        const task = makeTask()
        schedule(task, BASE)
        machineOnline = false

        await scheduler.tick()
        expect(slots(task)[0]).toMatchObject({ status: 'waiting_for_runner', deadlineAt: BASE + 30 * 60_000 })

        clock = BASE + 31 * 60_000
        machineOnline = true
        await scheduler.tick()

        expect(spawnCount).toBe(0)
        expect(slots(task)[0]?.status).toBe('expired')
    })

    it('dispatches a waiting fire once its machine is back', async () => {
        const task = makeTask()
        schedule(task, BASE)
        machineOnline = false
        await scheduler.tick()

        clock = BASE + 5 * 60_000
        machineOnline = true
        await scheduler.tick()

        expect(spawnCount).toBe(1)
        expect(slots(task)[0]?.status).toBe('started')
    })
})

describe('run supervision', () => {
    it('ends a run that stays idle, then clears its worktree', async () => {
        const task = makeTask()
        schedule(task, BASE)
        clock = Date.now()
        store.taskSchedules.upsert({ taskId: task.id, namespace: 'default', cron: HOURLY, tz: 'UTC', catchup: true, overlap: 'skip', sessionMode: 'fresh', maxRunMs: HOUR, nextRunAt: clock - 1000 })
        await scheduler.tick()
        const run = store.tasks.getActiveRun(task.id)!
        store.tasks.setRunWorktree(run.id, { branch: 'dugong-nightly', worktreePath: '/repo-wt/nightly' })

        activeSession(task).thinking = false
        clock += 60_000
        await scheduler.tick()
        expect(store.tasks.getRun(run.id)?.status).toBe('running')

        clock += SCHEDULE_IDLE_SETTLE_MS
        await scheduler.tick()

        expect(store.tasks.getRun(run.id)?.status).toBe('succeeded')
        expect(store.tasks.get(task.id)?.column).toBe('review')
        expect(retired).toEqual([run.sessionId!])
        expect(removed).toEqual([{ worktreePath: '/repo-wt/nightly' }])
    })

    it('does not end a run whose agent is still holding background work', async () => {
        const task = makeTask()
        clock = Date.now()
        schedule(task, clock - 1000)
        await scheduler.tick()

        Object.assign(activeSession(task), { thinking: false, backgroundAwaitedCount: 1 })
        clock += 60_000
        await scheduler.tick()
        clock += SCHEDULE_IDLE_SETTLE_MS
        await scheduler.tick()

        expect(store.tasks.getActiveRun(task.id)?.status).toBe('running')
    })

    it('stops a run past its time limit and counts it as a failure', async () => {
        const task = makeTask()
        clock = Date.now()
        schedule(task, clock - 1000)
        await scheduler.tick()
        const run = store.tasks.getActiveRun(task.id)!

        clock += HOUR + 1000
        await scheduler.tick()

        expect(store.tasks.getRun(run.id)).toMatchObject({ status: 'timed_out', error: 'hapi:run.timedOut' })
        expect(removed).toEqual([])
    })

    it('pauses a schedule after three failed runs in a row', async () => {
        const task = makeTask()
        const created = schedule(task, BASE + 100 * HOUR)
        for (let i = 0; i < 3; i++) {
            const started = store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'scheduled', startedAt: created.failuresSince + i })
            if (started.outcome !== 'started') throw new Error('run did not open')
            store.tasks.finishRun(started.run.id, { status: 'failed' })
        }
        await scheduler.tick()

        expect(store.taskSchedules.get(task.id)).toMatchObject({ enabled: false, pausedReason: 'failures', nextRunAt: null })
    })
})

describe('continue mode', () => {
    /** Run one fire to completion: start it, then let it sit idle until the
     *  hub ends it. */
    async function runOnce(task: StoredTask) {
        await scheduler.tick()
        activeSession(task).thinking = false
        clock += 60_000
        await scheduler.tick()
        clock += SCHEDULE_IDLE_SETTLE_MS
        await scheduler.tick()
    }

    it('reopens the last session for the next fire and keeps its worktree', async () => {
        const task = makeTask()
        clock = Date.now()
        schedule(task, clock - 1000, { sessionMode: 'continue' })
        await runOnce(task)
        const first = store.tasks.listRuns(task.id, 1)[0]!
        expect(first.status).toBe('succeeded')
        expect(removed).toEqual([])

        store.taskSchedules.upsert({ taskId: task.id, namespace: 'default', cron: HOURLY, tz: 'UTC', catchup: true, overlap: 'skip', sessionMode: 'continue', maxRunMs: HOUR, nextRunAt: clock - 1000 })
        await scheduler.tick()

        expect(spawnCount).toBe(1)
        expect(reopenCalls).toEqual([first.sessionId!])
        const second = store.tasks.getActiveRun(task.id)!
        expect(second.sessionId).toBe(first.sessionId)
        expect(second.origin).toBe('scheduled')
        expect(sentPrompts.at(-1)?.text).toContain('This continues the conversation above')
    })

    it('runs fresh when the last session cannot be reopened', async () => {
        const task = makeTask()
        clock = Date.now()
        schedule(task, clock - 1000, { sessionMode: 'continue' })
        await runOnce(task)
        reopenImpl = async () => ({ type: 'error', message: 'No conversation found' })

        store.taskSchedules.upsert({ taskId: task.id, namespace: 'default', cron: HOURLY, tz: 'UTC', catchup: true, overlap: 'skip', sessionMode: 'continue', maxRunMs: HOUR, nextRunAt: clock - 1000 })
        await scheduler.tick()

        expect(spawnCount).toBe(2)
        const latest = store.taskSchedules.listSlots(task.id, 1)[0]!
        expect(latest).toMatchObject({ status: 'started', reason: 'continue-fallback' })
        expect(store.tasks.listRuns(task.id, 5).filter((run) => run.status === 'failed')).toEqual([])
    })
})

describe('a session someone is using', () => {
    it('counts as the previous run still going', async () => {
        const task = makeTask()
        clock = Date.now()
        schedule(task, clock - 1000)
        await scheduler.tick()
        await orchestrator.cancelTask(task.id, 'default')
        // The run is over, but the operator is mid-turn in the conversation.
        Object.assign(sessions.get(store.tasks.get(task.id)!.currentSessionId!)!, { active: true, thinking: true })

        store.taskSchedules.upsert({ taskId: task.id, namespace: 'default', cron: HOURLY, tz: 'UTC', catchup: true, overlap: 'skip', sessionMode: 'fresh', maxRunMs: HOUR, nextRunAt: clock - 500 })
        await scheduler.tick()

        expect(spawnCount).toBe(1)
        expect(store.taskSchedules.listSlots(task.id, 1)[0]).toMatchObject({ status: 'skipped', reason: 'previous-run-active' })
    })
})

describe('a task that can no longer run on its schedule', () => {
    it('does not fire for an archived task, and pauses the schedule', async () => {
        const task = makeTask()
        schedule(task, BASE)
        store.tasks.archive(task.id, 'default')

        await scheduler.tick()

        expect(spawnCount).toBe(0)
        expect(store.taskSchedules.get(task.id)).toMatchObject({ enabled: false, pausedReason: 'archived' })
        expect(slots(task)[0]).toMatchObject({ status: 'skipped', reason: 'archived' })
        expect(scheduler.resumeSchedule(task.id, 'default')).toMatchObject({ outcome: 'invalid', code: 'archived' })
        expect(await scheduler.runNow(task.id, 'default')).toEqual({ outcome: 'refused', code: 'archived' })
    })

    it('re-checks eligibility at fire time after the task was edited', async () => {
        const task = makeTask()
        schedule(task, BASE)
        store.tasks.update(task.id, 'default', { isolation: 'simple' })

        await scheduler.tick()

        expect(spawnCount).toBe(0)
        expect(store.taskSchedules.get(task.id)).toMatchObject({ enabled: false, pausedReason: 'not-worktree' })
    })

    it('re-checks a fire that waited for its machine', async () => {
        const task = makeTask()
        schedule(task, BASE)
        machineOnline = false
        await scheduler.tick()
        expect(slots(task)[0]?.status).toBe('waiting_for_runner')

        // Switched to a mode that stops on prompts while the fire waited.
        store.tasks.update(task.id, 'default', { spawn: { flavor: 'claude', permissionMode: 'default' } })
        clock = BASE + 5 * 60_000
        machineOnline = true
        await scheduler.tick()

        expect(spawnCount).toBe(0)
        expect(slots(task)[0]).toMatchObject({ status: 'skipped', reason: 'not-unattended' })
        expect(store.taskSchedules.get(task.id)?.pausedReason).toBe('not-unattended')
    })
})
