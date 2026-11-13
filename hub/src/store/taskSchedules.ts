import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type {
    TaskSchedule,
    TaskScheduleOverlap,
    TaskScheduleSessionMode,
    TaskScheduleSlot,
    TaskScheduleSlotStatus,
    TaskScheduleTrigger
} from '@hapi/protocol'

/**
 * Persistence for task schedules.
 *
 * `next_run_at` is the cursor: the scheduler claims a fire by moving it
 * forward with a compare-and-set in the same transaction that writes the
 * fire's slot row, and `UNIQUE(task_id, scheduled_for, trigger)` on slots is
 * the backstop. Duplicate protection therefore never depends on slot history
 * surviving, so slots can be pruned freely.
 */

type DbScheduleRow = {
    task_id: string
    namespace: string
    cron: string
    tz: string
    enabled: number
    catchup: number
    overlap: string
    session_mode: string | null
    max_run_ms: number
    next_run_at: number | null
    failures_since: number
    paused_reason: string | null
    created_at: number
    updated_at: number
}

type DbSlotRow = {
    id: string
    task_id: string
    scheduled_for: number
    trigger: string
    status: string
    reason: string | null
    deadline_at: number | null
    run_id: string | null
    created_at: number
}

/** The wire shape plus the column only the scheduler reads. */
export type StoredTaskSchedule = TaskSchedule & {
    /** Failures before this are not counted toward the auto-pause. Moved on
     *  every resume so a resumed schedule is not paused again at once. */
    failuresSince: number
}

function toSchedule(row: DbScheduleRow): StoredTaskSchedule {
    return {
        taskId: row.task_id,
        namespace: row.namespace,
        cron: row.cron,
        tz: row.tz,
        enabled: row.enabled === 1,
        catchup: row.catchup === 1,
        overlap: row.overlap as TaskScheduleOverlap,
        sessionMode: row.session_mode === 'continue' ? 'continue' : 'fresh',
        maxRunMs: row.max_run_ms,
        nextRunAt: row.next_run_at,
        pausedReason: row.paused_reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        failuresSince: row.failures_since
    }
}

function toSlot(row: DbSlotRow): TaskScheduleSlot {
    return {
        id: row.id,
        taskId: row.task_id,
        scheduledFor: row.scheduled_for,
        trigger: row.trigger as TaskScheduleTrigger,
        status: row.status as TaskScheduleSlotStatus,
        reason: row.reason,
        deadlineAt: row.deadline_at,
        runId: row.run_id,
        createdAt: row.created_at
    }
}

/** Public shape: the scheduler-only columns stay on the hub. */
export function toPublicSchedule(schedule: StoredTaskSchedule): TaskSchedule {
    const { failuresSince: _since, ...rest } = schedule
    return rest
}

export type UpsertScheduleInput = {
    taskId: string
    namespace: string
    cron: string
    tz: string
    catchup: boolean
    overlap: TaskScheduleOverlap
    sessionMode: TaskScheduleSessionMode
    maxRunMs: number
    /** Where the cursor goes if the schedule is (or stays) enabled. */
    nextRunAt: number
}

export type NewSlot = {
    taskId: string
    scheduledFor: number
    trigger: TaskScheduleTrigger
    status: TaskScheduleSlotStatus
    reason?: string | null
    deadlineAt?: number | null
    runId?: string | null
}

export type SlotPatch = {
    status?: TaskScheduleSlotStatus
    reason?: string | null
    deadlineAt?: number | null
    runId?: string | null
}

const SLOT_RETENTION = 200

export class TaskScheduleStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    get(taskId: string, namespace?: string): StoredTaskSchedule | null {
        const row = (namespace === undefined
            ? this.db.prepare('SELECT * FROM task_schedules WHERE task_id = ?').get(taskId)
            : this.db.prepare('SELECT * FROM task_schedules WHERE task_id = ? AND namespace = ?').get(taskId, namespace)
        ) as DbScheduleRow | undefined
        return row ? toSchedule(row) : null
    }

    list(namespace: string): StoredTaskSchedule[] {
        const rows = this.db.prepare(
            'SELECT * FROM task_schedules WHERE namespace = ? ORDER BY created_at'
        ).all(namespace) as DbScheduleRow[]
        return rows.map(toSchedule)
    }

    listDue(now: number): StoredTaskSchedule[] {
        const rows = this.db.prepare(
            'SELECT * FROM task_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at'
        ).all(now) as DbScheduleRow[]
        return rows.map(toSchedule)
    }

    listEnabled(): StoredTaskSchedule[] {
        const rows = this.db.prepare('SELECT * FROM task_schedules WHERE enabled = 1').all() as DbScheduleRow[]
        return rows.map(toSchedule)
    }

    /** Create, or replace the config of, a task's schedule. A paused schedule
     *  stays paused: editing it is not the same as resuming it. */
    upsert(input: UpsertScheduleInput): StoredTaskSchedule {
        const now = Date.now()
        this.db.prepare(`
            INSERT INTO task_schedules (
                task_id, namespace, cron, tz, enabled, catchup, overlap, session_mode, max_run_ms,
                next_run_at, failures_since, paused_reason, created_at, updated_at
            ) VALUES (
                @task_id, @namespace, @cron, @tz, 1, @catchup, @overlap, @session_mode, @max_run_ms,
                @next_run_at, @now, NULL, @now, @now
            )
            ON CONFLICT(task_id) DO UPDATE SET
                cron = excluded.cron,
                tz = excluded.tz,
                catchup = excluded.catchup,
                overlap = excluded.overlap,
                session_mode = excluded.session_mode,
                max_run_ms = excluded.max_run_ms,
                next_run_at = CASE WHEN task_schedules.enabled = 1 THEN excluded.next_run_at ELSE NULL END,
                updated_at = excluded.updated_at
        `).run({
            task_id: input.taskId,
            namespace: input.namespace,
            cron: input.cron,
            tz: input.tz,
            catchup: input.catchup ? 1 : 0,
            overlap: input.overlap,
            session_mode: input.sessionMode,
            max_run_ms: input.maxRunMs,
            next_run_at: input.nextRunAt,
            now
        })
        const stored = this.get(input.taskId)
        if (!stored) throw new Error(`Failed to read back schedule for task ${input.taskId}`)
        return stored
    }

    delete(taskId: string, namespace: string): boolean {
        return this.db.prepare('DELETE FROM task_schedules WHERE task_id = ? AND namespace = ?')
            .run(taskId, namespace).changes > 0
    }

    pause(taskId: string, reason: string): StoredTaskSchedule | null {
        this.db.prepare(`
            UPDATE task_schedules
            SET enabled = 0, next_run_at = NULL, paused_reason = ?, updated_at = ?
            WHERE task_id = ?
        `).run(reason, Date.now(), taskId)
        return this.get(taskId)
    }

    resume(taskId: string, nextRunAt: number): StoredTaskSchedule | null {
        const now = Date.now()
        this.db.prepare(`
            UPDATE task_schedules
            SET enabled = 1, next_run_at = ?, paused_reason = NULL, failures_since = ?, updated_at = ?
            WHERE task_id = ?
        `).run(nextRunAt, now, now, taskId)
        return this.get(taskId)
    }

    /**
     * Claim the fire at `expectedNextRunAt`: move the cursor to `nextRunAt`
     * and record `slots`, all or nothing. Returns the inserted slots, or null
     * when the cursor had already moved (another tick, an edit, a pause).
     */
    claim(
        taskId: string,
        expectedNextRunAt: number,
        nextRunAt: number | null,
        slots: readonly NewSlot[]
    ): TaskScheduleSlot[] | null {
        return this.db.transaction((): TaskScheduleSlot[] | null => {
            const moved = this.db.prepare(`
                UPDATE task_schedules SET next_run_at = ?, updated_at = ?
                WHERE task_id = ? AND enabled = 1 AND next_run_at = ?
            `).run(nextRunAt, Date.now(), taskId, expectedNextRunAt)
            if (moved.changes === 0) return null
            const inserted: TaskScheduleSlot[] = []
            for (const slot of slots) {
                const row = this.insertSlot(slot)
                if (row) inserted.push(row)
            }
            return inserted
        })()
    }

    /** Null when a slot for that fire already exists. */
    insertSlot(input: NewSlot): TaskScheduleSlot | null {
        const id = randomUUID()
        const result = this.db.prepare(`
            INSERT OR IGNORE INTO task_schedule_slots (
                id, task_id, scheduled_for, trigger, status, reason, deadline_at, run_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            input.taskId,
            input.scheduledFor,
            input.trigger,
            input.status,
            input.reason ?? null,
            input.deadlineAt ?? null,
            input.runId ?? null,
            Date.now()
        )
        if (result.changes === 0) return null
        this.pruneSlots(input.taskId)
        return this.getSlot(id)
    }

    getSlot(id: string): TaskScheduleSlot | null {
        const row = this.db.prepare('SELECT * FROM task_schedule_slots WHERE id = ?').get(id) as DbSlotRow | undefined
        return row ? toSlot(row) : null
    }

    updateSlot(id: string, patch: SlotPatch): TaskScheduleSlot | null {
        const current = this.getSlot(id)
        if (!current) return null
        this.db.prepare(`
            UPDATE task_schedule_slots SET status = ?, reason = ?, deadline_at = ?, run_id = ? WHERE id = ?
        `).run(
            patch.status ?? current.status,
            patch.reason !== undefined ? patch.reason : current.reason,
            patch.deadlineAt !== undefined ? patch.deadlineAt : current.deadlineAt,
            patch.runId !== undefined ? patch.runId : current.runId,
            id
        )
        return this.getSlot(id)
    }

    listSlots(taskId: string, limit: number = 50): TaskScheduleSlot[] {
        const rows = this.db.prepare(
            'SELECT * FROM task_schedule_slots WHERE task_id = ? ORDER BY scheduled_for DESC, created_at DESC LIMIT ?'
        ).all(taskId, limit) as DbSlotRow[]
        return rows.map(toSlot)
    }

    listSlotsByStatus(status: TaskScheduleSlotStatus): TaskScheduleSlot[] {
        const rows = this.db.prepare(
            'SELECT * FROM task_schedule_slots WHERE status = ? ORDER BY scheduled_for'
        ).all(status) as DbSlotRow[]
        return rows.map(toSlot)
    }

    listSlotsForTaskByStatus(taskId: string, status: TaskScheduleSlotStatus): TaskScheduleSlot[] {
        const rows = this.db.prepare(
            'SELECT * FROM task_schedule_slots WHERE task_id = ? AND status = ? ORDER BY scheduled_for'
        ).all(taskId, status) as DbSlotRow[]
        return rows.map(toSlot)
    }

    /** When the task's latest successful scheduled run started, for telling
     *  the next one what it can skip. */
    lastSucceededScheduledRunAt(taskId: string): number | null {
        const row = this.db.prepare(`
            SELECT started_at FROM task_runs
            WHERE task_id = ? AND origin = 'scheduled' AND status = 'succeeded'
            ORDER BY started_at DESC LIMIT 1
        `).get(taskId) as { started_at: number } | undefined
        return row?.started_at ?? null
    }

    /**
     * Statuses of the task's scheduled runs that started at or after `since`,
     * newest first. Drives the consecutive-failure pause.
     */
    recentScheduledRunStatuses(taskId: string, since: number, limit: number): string[] {
        const rows = this.db.prepare(`
            SELECT status FROM task_runs
            WHERE task_id = ? AND origin = 'scheduled' AND status != 'running' AND started_at >= ?
            ORDER BY started_at DESC, rowid DESC
            LIMIT ?
        `).all(taskId, since, limit) as Array<{ status: string }>
        return rows.map((row) => row.status)
    }

    private pruneSlots(taskId: string): void {
        this.db.prepare(`
            DELETE FROM task_schedule_slots
            WHERE task_id = ? AND id NOT IN (
                SELECT id FROM task_schedule_slots WHERE task_id = ?
                ORDER BY scheduled_for DESC, created_at DESC LIMIT ?
            )
        `).run(taskId, taskId, SLOT_RETENTION)
    }
}
