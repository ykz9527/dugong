import {
    SCHEDULE_DEFAULT_MAX_RUN_MS,
    SCHEDULE_FAILURE_PAUSE_THRESHOLD,
    TaskScheduleInputSchema,
    TaskSpawnConfigSchema,
    encodeTaskError,
    isUnattendedSpawn,
    nextScheduleRun,
    scheduleGraceMs,
    validateSchedule,
    type ScheduleValidation,
    type TaskScheduleInput,
    type TaskScheduleRefusal,
    type TaskScheduleSlot
} from '@hapi/protocol'
import type { Store, StoredTask, StoredTaskSchedule } from '../store'
import type { NewSlot } from '../store/taskSchedules'
import {
    REATTACH_WINDOW_MS,
    STARTUP_GRACE_MS,
    columnForLiveSession,
    hasPendingRequests,
    type OrchestratorSession,
    type ContinueTaskResult,
    type RetireSessionOutcome,
    type StartTaskResult
} from './taskOrchestrator'
import type { WorktreeTeardownResult } from './taskWorktree'

/**
 * Recurring runs for tasks: a cron schedule on a task starts a run of it each
 * time it fires, with the hub owning the clock.
 *
 * This class decides *when* a task runs and *whether* a given fire runs at
 * all; starting the run is the orchestrator's `startTask`, unchanged, so a
 * scheduled run is the same worktree + session + prompt a Start press gives.
 *
 * Policy, for runs that cost money and act on a repo:
 *  - a fire missed while the hub was down runs once, for the latest one, and
 *    only within its grace window; older ones are recorded as missed
 *  - a fire that finds the previous run still going is skipped, or held as
 *    the single queued fire (`queue_one`) — never run alongside it
 *  - a fire whose machine is offline waits for it until the grace window ends
 *  - a run that goes idle is ended by the hub: an idle session would keep the
 *    run open, and every later fire would be skipped behind it
 *  - a run past its time limit is stopped and counted as a failure; three
 *    failures in a row pause the schedule
 *  - nothing is retried: a second agent run is not idempotent
 */

/** How long a scheduled run must sit idle before the hub calls it done. Long
 *  enough that a turn boundary between two tool calls does not end it. */
export const SCHEDULE_IDLE_SETTLE_MS = 30_000
/** Later than this and a fire counts as caught up rather than on time. */
const ON_TIME_SLACK_MS = 60_000
const TICK_MS = 5_000
/** Missed fires recorded individually per catch-up; older ones are dropped. */
const MAX_MISSED_RECORDED = 10
const MAX_FIRES_SCANNED = 10_000

const FAILED_RUN_STATUSES = new Set(['failed', 'orphaned', 'timed_out'])

export type TaskSchedulerDeps = {
    store: Store
    startTask: (
        taskId: string,
        namespace: string,
        options: { origin: 'scheduled'; prompt: string }
    ) => Promise<StartTaskResult>
    /** Reopen the task's last session and send the prompt into it. Optional:
     *  without it continue-mode schedules run fresh. */
    continueTask?: (
        taskId: string,
        namespace: string,
        options: { origin: 'scheduled'; prompt: string }
    ) => Promise<ContinueTaskResult>
    getSession: (sessionId: string) => OrchestratorSession | null | undefined
    isMachineOnline: (machineId: string) => boolean
    retireSession: (task: StoredTask) => Promise<RetireSessionOutcome>
    abortSession?: (sessionId: string) => Promise<void>
    /** Remove a finished run's worktree unless it holds work. Optional so a
     *  headless harness can leave worktrees alone. */
    removeRunWorktree?: (
        task: StoredTask,
        worktree: { branch: string | null; worktreePath: string }
    ) => Promise<WorktreeTeardownResult>
    notify?: (sessionId: string, summary: string) => void
    onTaskChanged?: (task: StoredTask) => void
    now?: () => number
    /** Hold fires until agents from before a restart have had their chance to
     *  reconnect. Defaults to the orchestrator's reattach window. */
    startDelayMs?: number
    logger?: { error: (message: string, error?: unknown) => void }
}

export type ScheduleWriteResult =
    | { outcome: 'ok'; schedule: StoredTaskSchedule }
    | { outcome: 'task-not-found' }
    | { outcome: 'invalid'; code: string; message?: string }

type Refusal = { outcome: 'invalid'; code: TaskScheduleRefusal }

export type RunNowResult =
    | { outcome: 'started'; slot: TaskScheduleSlot }
    | { outcome: 'task-not-found' }
    | { outcome: 'already-running' }
    | { outcome: 'machine-offline' }
    /** The task can no longer run on a schedule (archived, or edited into a
     *  config `refuseTask` rejects); the schedule has been paused. */
    | { outcome: 'refused'; code: string }
    | { outcome: 'failed'; message: string }

export class TaskScheduler {
    private readonly deps: TaskSchedulerDeps
    private timer: ReturnType<typeof setInterval> | null = null
    private readyAt = 0
    private ticking = false
    /** Run id -> when it was first seen idle. In memory on purpose: after a
     *  restart an idle run simply waits one more settle period. */
    private readonly idleSince = new Map<string, number>()

    constructor(deps: TaskSchedulerDeps) {
        this.deps = deps
    }

    start(): void {
        if (this.timer) return
        this.readyAt = this.now() + (this.deps.startDelayMs ?? REATTACH_WINDOW_MS)
        this.timer = setInterval(() => {
            void this.tick()
        }, TICK_MS)
        this.timer.unref?.()
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    // --- Commands (routes) ---------------------------------------------

    upsertSchedule(taskId: string, namespace: string, raw: TaskScheduleInput): ScheduleWriteResult {
        const input = TaskScheduleInputSchema.parse(raw)
        const task = this.deps.store.tasks.getByNamespace(taskId, namespace)
        if (!task) return { outcome: 'task-not-found' }

        const refusal = this.refuseTask(task) ?? this.refuseSpec(input.cron, input.tz)
        if (refusal) return refusal

        const now = this.now()
        const nextRunAt = nextScheduleRun(input.cron, input.tz, now)
        if (nextRunAt === null) return { outcome: 'invalid', code: 'never-fires' }

        const schedule = this.deps.store.taskSchedules.upsert({
            taskId: task.id,
            namespace,
            cron: input.cron,
            tz: input.tz,
            catchup: input.catchup ?? true,
            overlap: input.overlap ?? 'skip',
            sessionMode: input.sessionMode ?? 'fresh',
            maxRunMs: input.maxRunMs ?? SCHEDULE_DEFAULT_MAX_RUN_MS,
            nextRunAt
        })
        return { outcome: 'ok', schedule }
    }

    deleteSchedule(taskId: string, namespace: string): boolean {
        return this.deps.store.taskSchedules.delete(taskId, namespace)
    }

    pauseSchedule(taskId: string, namespace: string): StoredTaskSchedule | null {
        if (!this.deps.store.taskSchedules.get(taskId, namespace)) return null
        return this.deps.store.taskSchedules.pause(taskId, 'user')
    }

    /** Resume from now: time spent paused is not made up. */
    resumeSchedule(taskId: string, namespace: string): ScheduleWriteResult {
        const schedule = this.deps.store.taskSchedules.get(taskId, namespace)
        if (!schedule) return { outcome: 'task-not-found' }
        const task = this.deps.store.tasks.getByNamespace(taskId, namespace)
        if (!task) return { outcome: 'task-not-found' }
        const refusal = this.refuseTask(task)
        if (refusal) return refusal
        const nextRunAt = nextScheduleRun(schedule.cron, schedule.tz, this.now())
        if (nextRunAt === null) return { outcome: 'invalid', code: 'never-fires' }
        const resumed = this.deps.store.taskSchedules.resume(taskId, nextRunAt)
        return resumed ? { outcome: 'ok', schedule: resumed } : { outcome: 'task-not-found' }
    }

    /** Fire now, outside the cadence. Refused rather than queued while a run
     *  is going: the operator pressing it wants to see a run start. */
    async runNow(taskId: string, namespace: string): Promise<RunNowResult> {
        const store = this.deps.store
        const task = store.tasks.getByNamespace(taskId, namespace)
        if (!task || !store.taskSchedules.get(taskId, namespace)) return { outcome: 'task-not-found' }
        const refusal = this.pauseIfIneligible(task)
        if (refusal) return { outcome: 'refused', code: refusal }
        if (this.isBusy(task)) return { outcome: 'already-running' }
        if (!task.machineId || !this.deps.isMachineOnline(task.machineId)) return { outcome: 'machine-offline' }

        const slot = store.taskSchedules.insertSlot({
            taskId: task.id,
            scheduledFor: this.now(),
            trigger: 'manual',
            status: 'started'
        })
        if (!slot) return { outcome: 'already-running' }
        const dispatched = await this.dispatch(slot)
        if (dispatched.status === 'started') return { outcome: 'started', slot: dispatched }
        if (dispatched.reason === 'previous-run-active') return { outcome: 'already-running' }
        return { outcome: 'failed', message: dispatched.reason ?? 'unknown' }
    }

    // --- Clock ------------------------------------------------------------

    async tick(): Promise<void> {
        if (this.ticking) return
        const now = this.now()
        if (now < this.readyAt) return
        this.ticking = true
        try {
            for (const schedule of this.deps.store.taskSchedules.listDue(now)) {
                await this.guard(`fire schedule for task ${schedule.taskId}`, () => this.fire(schedule, now))
            }
            await this.guard('dispatch waiting fires', () => this.dispatchWaiting(now))
            await this.guard('dispatch queued fires', () => this.dispatchQueued())
            await this.guard('supervise scheduled runs', () => this.superviseRuns(now))
            this.guardSync('pause failing schedules', () => this.pauseFailing())
        } finally {
            this.ticking = false
        }
    }

    /**
     * Claim the due fire and decide what becomes of it.
     *
     * Only the latest fire at or before `now` is a candidate; anything older
     * was missed while the hub was not ticking and is recorded as such.
     */
    private async fire(schedule: StoredTaskSchedule, now: number): Promise<void> {
        const store = this.deps.store
        const due = schedule.nextRunAt
        if (due === null) return

        const missed: number[] = []
        let latest = due
        for (let i = 0; i < MAX_FIRES_SCANNED; i++) {
            const next = nextScheduleRun(schedule.cron, schedule.tz, latest)
            if (next === null || next > now) break
            missed.push(latest)
            latest = next
        }
        const nextRunAt = nextScheduleRun(schedule.cron, schedule.tz, now)

        const slots: NewSlot[] = missed.slice(-MAX_MISSED_RECORDED).map((scheduledFor) => ({
            taskId: schedule.taskId,
            scheduledFor,
            trigger: 'cron',
            status: 'missed',
            reason: 'hub-offline'
        }))

        const late = now - latest > ON_TIME_SLACK_MS
        const grace = scheduleGraceMs(schedule.cron, schedule.tz, latest)
        const task = store.tasks.get(schedule.taskId)
        const trigger = late ? 'catchup' : 'cron'
        let dispatchNow = false
        let refusal: TaskScheduleRefusal | null = null

        if (!task) {
            return
        } else if ((refusal = this.dispatchRefusal(task)) !== null) {
            slots.push({ taskId: task.id, scheduledFor: latest, trigger, status: 'skipped', reason: refusal })
        } else if (late && (!schedule.catchup || now - latest > grace)) {
            slots.push({ taskId: task.id, scheduledFor: latest, trigger: 'cron', status: 'missed', reason: schedule.catchup ? 'outside-window' : 'hub-offline' })
        } else if (this.isBusy(task)) {
            if (schedule.overlap === 'queue_one') {
                for (const queued of store.taskSchedules.listSlotsForTaskByStatus(task.id, 'queued')) {
                    store.taskSchedules.updateSlot(queued.id, { status: 'skipped', reason: 'superseded' })
                }
                slots.push({ taskId: task.id, scheduledFor: latest, trigger, status: 'queued', reason: 'previous-run-active' })
            } else {
                slots.push({ taskId: task.id, scheduledFor: latest, trigger, status: 'skipped', reason: 'previous-run-active' })
            }
        } else if (!task.machineId || !this.deps.isMachineOnline(task.machineId)) {
            slots.push({
                taskId: task.id,
                scheduledFor: latest,
                trigger,
                status: 'waiting_for_runner',
                reason: 'machine-offline',
                deadlineAt: latest + grace
            })
        } else {
            slots.push({ taskId: task.id, scheduledFor: latest, trigger, status: 'started' })
            dispatchNow = true
        }

        const claimed = store.taskSchedules.claim(schedule.taskId, due, nextRunAt, slots)
        if (refusal !== null) {
            store.taskSchedules.pause(schedule.taskId, refusal)
            return
        }
        if (!claimed || !dispatchNow) return
        const slot = claimed.find((entry) => entry.status === 'started')
        if (slot) await this.dispatch(slot)
    }

    private async dispatchWaiting(now: number): Promise<void> {
        const store = this.deps.store
        for (const slot of store.taskSchedules.listSlotsByStatus('waiting_for_runner')) {
            const task = store.tasks.get(slot.taskId)
            if (!task) continue
            // Paused or removed while it waited: the operator no longer wants it.
            if (!store.taskSchedules.get(slot.taskId)?.enabled) {
                store.taskSchedules.updateSlot(slot.id, { status: 'skipped', reason: 'superseded' })
                continue
            }
            if (slot.deadlineAt !== null && now > slot.deadlineAt) {
                store.taskSchedules.updateSlot(slot.id, { status: 'expired' })
                continue
            }
            if (!task.machineId || !this.deps.isMachineOnline(task.machineId)) continue
            if (this.isBusy(task)) {
                store.taskSchedules.updateSlot(slot.id, { status: 'skipped', reason: 'previous-run-active' })
                continue
            }
            const claimed = store.taskSchedules.updateSlot(slot.id, { status: 'started', reason: null })
            if (claimed) await this.dispatch(claimed)
        }
    }

    private async dispatchQueued(): Promise<void> {
        const store = this.deps.store
        for (const slot of store.taskSchedules.listSlotsByStatus('queued')) {
            const task = store.tasks.get(slot.taskId)
            const schedule = store.taskSchedules.get(slot.taskId)
            if (!task || !schedule?.enabled) {
                store.taskSchedules.updateSlot(slot.id, { status: 'skipped', reason: 'superseded' })
                continue
            }
            if (this.isBusy(task)) continue
            if (!task.machineId || !this.deps.isMachineOnline(task.machineId)) continue
            const claimed = store.taskSchedules.updateSlot(slot.id, { status: 'started', reason: null })
            if (claimed) await this.dispatch(claimed)
        }
    }

    /** Start the run for a slot already marked `started`; settle the slot. */
    private async dispatch(slot: TaskScheduleSlot): Promise<TaskScheduleSlot> {
        const store = this.deps.store
        const task = store.tasks.get(slot.taskId)
        if (!task) {
            return store.taskSchedules.updateSlot(slot.id, { status: 'dispatch_failed', reason: 'task-not-found' }) ?? slot
        }
        // Checked again here, not only when the schedule was saved: the task
        // may have been archived or edited since, and a waiting or queued
        // fire would otherwise run it as it is now.
        const refusal = this.pauseIfIneligible(task)
        if (refusal) {
            return store.taskSchedules.updateSlot(slot.id, { status: 'skipped', reason: refusal }) ?? slot
        }

        const schedule = store.taskSchedules.get(task.id)
        let fallbackReason: string | null = null
        if (schedule?.sessionMode === 'continue' && task.currentSessionId && this.deps.continueTask) {
            let continued: ContinueTaskResult
            try {
                continued = await this.deps.continueTask(task.id, task.namespace, {
                    origin: 'scheduled',
                    prompt: this.buildPrompt(task, slot, true)
                })
            } catch (error) {
                continued = { outcome: 'unavailable', message: error instanceof Error ? error.message : String(error) }
            }
            switch (continued.outcome) {
                case 'started':
                    return store.taskSchedules.updateSlot(slot.id, { runId: continued.runId }) ?? slot
                case 'already-running':
                    return store.taskSchedules.updateSlot(slot.id, { status: 'skipped', reason: 'previous-run-active' }) ?? slot
                case 'archived':
                    return store.taskSchedules.updateSlot(slot.id, { status: 'skipped', reason: 'archived' }) ?? slot
                case 'prompt-failed':
                    return store.taskSchedules.updateSlot(slot.id, { status: 'dispatch_failed', reason: continued.message }) ?? slot
                case 'task-not-found':
                    return store.taskSchedules.updateSlot(slot.id, { status: 'dispatch_failed', reason: 'task-not-found' }) ?? slot
                case 'unavailable':
                    // Nothing to reopen: run fresh rather than not at all.
                    fallbackReason = 'continue-fallback'
                    break
            }
        }

        let result: StartTaskResult
        try {
            result = await this.deps.startTask(task.id, task.namespace, {
                origin: 'scheduled',
                prompt: this.buildPrompt(task, slot, false)
            })
        } catch (error) {
            result = { outcome: 'spawn-failed', task, message: error instanceof Error ? error.message : String(error) }
        }

        switch (result.outcome) {
            case 'started':
                return store.taskSchedules.updateSlot(slot.id, { runId: result.runId, reason: fallbackReason }) ?? slot
            case 'already-running':
                return store.taskSchedules.updateSlot(slot.id, { status: 'skipped', reason: 'previous-run-active' }) ?? slot
            case 'archived':
                return store.taskSchedules.updateSlot(slot.id, { status: 'skipped', reason: 'archived' }) ?? slot
            case 'spawn-failed':
            case 'prompt-failed':
            case 'invalid-spawn-config':
                return store.taskSchedules.updateSlot(slot.id, { status: 'dispatch_failed', reason: result.message }) ?? slot
            default:
                return store.taskSchedules.updateSlot(slot.id, { status: 'dispatch_failed', reason: result.outcome }) ?? slot
        }
    }

    /**
     * The task's prompt, prefixed with what an unattended run needs to know:
     * nobody is there to answer, and when it last ran, so it can limit itself
     * to what changed since.
     */
    private buildPrompt(task: StoredTask, slot: TaskScheduleSlot, continuing: boolean): string {
        const schedule = this.deps.store.taskSchedules.get(task.id)
        const tz = schedule?.tz ?? 'UTC'
        const format = (at: number) => new Date(at).toLocaleString('sv-SE', { timeZone: tz }) + ` (${tz})`
        const previous = this.deps.store.taskSchedules.lastSucceededScheduledRunAt(task.id)
        const header = `[Scheduled run for ${format(slot.scheduledFor)}. `
            + `Previous successful scheduled run: ${previous === null ? 'none' : format(previous)}.]`
        if (continuing) {
            // The task's prompt is already earlier in this conversation; what
            // the run needs is the cue to do it again, now.
            return [
                header,
                'This continues the conversation above. Nobody is watching this run: do the task below again '
                    + 'for this run, building on what was done and said before. Do not ask questions or wait for '
                    + 'confirmation. End with a short summary of what you did.',
                '',
                task.prompt
            ].join('\n')
        }
        return [
            header,
            'Nobody is watching this run. Do not ask questions or wait for confirmation: decide and proceed. '
                + 'End with a short summary of what you did.',
            '',
            task.prompt
        ].join('\n')
    }

    // --- Run supervision --------------------------------------------------

    private async superviseRuns(now: number): Promise<void> {
        const store = this.deps.store
        const seen = new Set<string>()
        for (const { runId } of store.tasks.listRunningRuns()) {
            const run = store.tasks.getRun(runId)
            if (!run || run.origin !== 'scheduled') continue
            seen.add(run.id)

            const schedule = store.taskSchedules.get(run.taskId)
            const maxRunMs = schedule?.maxRunMs ?? SCHEDULE_DEFAULT_MAX_RUN_MS
            if (now - run.startedAt > maxRunMs) {
                await this.endRun(run.id, 'timed_out')
                continue
            }

            const session = run.sessionId ? this.deps.getSession(run.sessionId) : null
            if (!session?.active) {
                // Not ours to settle: the orchestrator orphans a silent run.
                this.idleSince.delete(run.id)
                continue
            }
            const idle = !hasPendingRequests(session)
                && columnForLiveSession(session, { startupGraceUntil: run.startedAt + STARTUP_GRACE_MS, now }) === 'review'
            if (!idle) {
                this.idleSince.delete(run.id)
                continue
            }
            const since = this.idleSince.get(run.id) ?? now
            this.idleSince.set(run.id, since)
            if (now - since >= SCHEDULE_IDLE_SETTLE_MS) {
                await this.endRun(run.id, 'succeeded')
            }
        }
        for (const runId of this.idleSince.keys()) {
            if (!seen.has(runId)) this.idleSince.delete(runId)
        }
    }

    /**
     * Settle a scheduled run, then stop its session and drop its worktree if
     * the run left nothing in it. The run is settled first so the session's
     * own `session-ended` (a termination) finds nothing left to mark.
     */
    private async endRun(runId: string, status: 'succeeded' | 'timed_out'): Promise<void> {
        const store = this.deps.store
        this.idleSince.delete(runId)
        const run = store.tasks.getRun(runId)
        if (!run) return

        if (status === 'timed_out' && run.sessionId) {
            const task = store.tasks.get(run.taskId)
            this.deps.notify?.(run.sessionId, `Scheduled run of "${task?.title ?? run.taskId}" hit its time limit and was stopped`)
            try {
                await this.deps.abortSession?.(run.sessionId)
            } catch (error) {
                this.logError(`Failed to abort timed-out session ${run.sessionId}`, error)
            }
        }

        const settled = store.tasks.finishRun(run.id, {
            status,
            error: status === 'timed_out' ? encodeTaskError('run.timedOut') : null,
            column: status === 'succeeded' ? 'review' : 'ready'
        })
        if (settled.outcome !== 'finished' || !settled.task) return
        this.deps.onTaskChanged?.(settled.task)

        await this.deps.retireSession(settled.task)

        // A continue-mode schedule comes back to this worktree next time.
        if (store.taskSchedules.get(run.taskId)?.sessionMode === 'continue') return
        const worktreePath = store.tasks.getRun(run.id)?.worktreePath ?? null
        if (!worktreePath || !this.deps.removeRunWorktree || settled.task.isolation !== 'worktree') return
        const removal = await this.deps.removeRunWorktree(settled.task, {
            branch: store.tasks.getRun(run.id)?.branch ?? null,
            worktreePath
        })
        // Gone from disk: stop pointing the task at it.
        if (removal.outcome === 'removed' && settled.task.worktreePath === worktreePath) {
            const cleared = store.tasks.update(settled.task.id, settled.task.namespace, {
                worktreePath: null,
                ...(removal.branch === 'deleted' ? { branch: null } : {})
            })
            if (cleared) this.deps.onTaskChanged?.(cleared)
        }
    }

    /** Pause a schedule whose last few runs since it was (re)enabled all
     *  failed. Runs the operator canceled do not count either way. */
    private pauseFailing(): void {
        const store = this.deps.store
        for (const schedule of store.taskSchedules.listEnabled()) {
            const statuses = store.taskSchedules
                .recentScheduledRunStatuses(schedule.taskId, schedule.failuresSince, SCHEDULE_FAILURE_PAUSE_THRESHOLD * 2)
                .filter((status) => status !== 'canceled')
                .slice(0, SCHEDULE_FAILURE_PAUSE_THRESHOLD)
            if (statuses.length < SCHEDULE_FAILURE_PAUSE_THRESHOLD) continue
            if (statuses.every((status) => FAILED_RUN_STATUSES.has(status))) {
                store.taskSchedules.pause(schedule.taskId, 'failures')
            }
        }
    }

    /**
     * Whether the task already has an agent at work: an open run, or its
     * session mid-turn, holding background work, or waiting on an answer —
     * someone driving it by hand. An idle live session is not busy: a
     * continue-mode run takes its next turn there, a fresh one retires it.
     */
    private isBusy(task: StoredTask): boolean {
        if (this.deps.store.tasks.getActiveRun(task.id)) return true
        const session = task.currentSessionId ? this.deps.getSession(task.currentSessionId) : null
        if (!session?.active) return false
        return hasPendingRequests(session) || columnForLiveSession(session) === 'running'
    }

    // --- Validation -------------------------------------------------------

    /**
     * Whether a task can run unattended on a schedule. Checked when the
     * schedule is saved or resumed, and again before every fire, since the
     * task can be archived or edited (isolation, spawn mode) in between.
     */
    private refuseTask(task: StoredTask): Refusal | null {
        if (task.archivedAt !== null) return { outcome: 'invalid', code: 'archived' }
        const spawn = TaskSpawnConfigSchema.safeParse(task.spawn)
        if (!spawn.success) return { outcome: 'invalid', code: 'invalid-spawn-config' }
        if (spawn.data.adoptedSessionId || spawn.data.adoptedNativeSessionId) {
            return { outcome: 'invalid', code: 'adopted-task' }
        }
        if (task.isolation !== 'worktree') return { outcome: 'invalid', code: 'not-worktree' }
        if (!task.machineId) return { outcome: 'invalid', code: 'no-machine' }
        if (!isUnattendedSpawn(spawn.data)) return { outcome: 'invalid', code: 'not-unattended' }
        return null
    }

    private dispatchRefusal(task: StoredTask): TaskScheduleRefusal | null {
        return this.refuseTask(task)?.code ?? null
    }

    /** Pause the schedule of a task that can no longer run on it, with the
     *  refusal as the reason. Returns that reason, or null if it can run. */
    private pauseIfIneligible(task: StoredTask): TaskScheduleRefusal | null {
        const refusal = this.dispatchRefusal(task)
        if (refusal) this.deps.store.taskSchedules.pause(task.id, refusal)
        return refusal
    }

    private refuseSpec(cron: string, tz: string): ScheduleWriteResult | null {
        const validation: ScheduleValidation = validateSchedule(cron, tz, this.now())
        return validation.ok ? null : { outcome: 'invalid', code: validation.code, message: validation.message }
    }

    // --- Helpers ----------------------------------------------------------

    private now(): number {
        return this.deps.now?.() ?? Date.now()
    }

    private async guard(label: string, action: () => Promise<void>): Promise<void> {
        try {
            await action()
        } catch (error) {
            this.logError(`Failed to ${label}`, error)
        }
    }

    private guardSync(label: string, action: () => void): void {
        try {
            action()
        } catch (error) {
            this.logError(`Failed to ${label}`, error)
        }
    }

    private logError(message: string, error?: unknown): void {
        if (this.deps.logger) {
            this.deps.logger.error(`[TaskScheduler] ${message}`, error)
            return
        }
        console.error(`[TaskScheduler] ${message}`, error)
    }
}
