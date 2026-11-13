import { Cron } from 'croner'
import { z } from 'zod'
import type { TaskSpawnConfig } from './task'

/**
 * Recurring runs for tasks.
 *
 * A schedule hangs off one task and, each time it fires, starts a run of that
 * task (see `TASK_SCHEDULE_SESSION_MODES` for fresh vs. continued runs). The hub owns the
 * clock; this module holds what both the hub and the web need to agree on —
 * the wire shapes, and the cron arithmetic, so the "next runs" the editor
 * previews are the ones the hub will actually fire.
 *
 * Cron math is croner, not `Bun.cron.parse`: the latter only honours a time
 * zone from Bun 1.4, and on the 1.3 line CI and releases build with it ignores
 * the option and silently computes in UTC. croner also runs in the browser.
 */

/** Two fires closer than this are refused: a misconfigured schedule should
 *  not be able to start an agent every minute. */
export const SCHEDULE_MIN_INTERVAL_MS = 10 * 60_000

export const SCHEDULE_DEFAULT_MAX_RUN_MS = 60 * 60_000
export const SCHEDULE_MIN_MAX_RUN_MS = 5 * 60_000
export const SCHEDULE_MAX_MAX_RUN_MS = 24 * 60 * 60_000

/** Consecutive failed scheduled runs that pause the schedule. */
export const SCHEDULE_FAILURE_PAUSE_THRESHOLD = 3

/** What to do when a fire finds the previous run still going. */
export const TASK_SCHEDULE_OVERLAPS = ['skip', 'queue_one'] as const
export type TaskScheduleOverlap = typeof TASK_SCHEDULE_OVERLAPS[number]

/**
 * How each run starts:
 *  - fresh    — a new session in a new worktree, given the task's prompt.
 *  - continue — the task's last session is reopened in its worktree and the
 *               prompt is sent as the next turn, so the run sees everything
 *               said before, follow-ups included. Falls back to fresh when
 *               that conversation cannot be reopened.
 */
export const TASK_SCHEDULE_SESSION_MODES = ['fresh', 'continue'] as const
export type TaskScheduleSessionMode = typeof TASK_SCHEDULE_SESSION_MODES[number]

export const TaskScheduleSchema = z.object({
    taskId: z.string(),
    namespace: z.string(),
    cron: z.string(),
    /** IANA zone the cron fields are read in. */
    tz: z.string(),
    enabled: z.boolean(),
    /** Run once for the latest fire missed while the hub was down, if it is
     *  still within the grace window. Off = missed fires are only recorded. */
    catchup: z.boolean(),
    overlap: z.enum(TASK_SCHEDULE_OVERLAPS),
    sessionMode: z.enum(TASK_SCHEDULE_SESSION_MODES),
    maxRunMs: z.number(),
    /** Null while paused. */
    nextRunAt: z.number().nullable(),
    /** Null when enabled. Otherwise 'user', 'failures', 'archived', or the
     *  code of the check the task stopped passing (e.g. 'not-unattended'). */
    pausedReason: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number()
})
export type TaskSchedule = z.infer<typeof TaskScheduleSchema>

export const TaskScheduleInputSchema = z.object({
    cron: z.string().trim().min(1),
    tz: z.string().trim().min(1),
    catchup: z.boolean().optional(),
    overlap: z.enum(TASK_SCHEDULE_OVERLAPS).optional(),
    sessionMode: z.enum(TASK_SCHEDULE_SESSION_MODES).optional(),
    maxRunMs: z.number().int().min(SCHEDULE_MIN_MAX_RUN_MS).max(SCHEDULE_MAX_MAX_RUN_MS).optional()
})
export type TaskScheduleInput = z.infer<typeof TaskScheduleInputSchema>

export const TASK_SCHEDULE_TRIGGERS = ['cron', 'catchup', 'manual'] as const
export type TaskScheduleTrigger = typeof TASK_SCHEDULE_TRIGGERS[number]

/**
 * What became of one fire.
 *  - started             — a run was opened; its outcome lives on the run.
 *  - waiting_for_runner  — the task's machine was offline; dispatched if it
 *                          comes back before `deadlineAt`.
 *  - queued              — the previous run was still going and the schedule
 *                          is `queue_one`; dispatched once it ends.
 *  - skipped             — not run; `reason` says why.
 *  - missed              — the hub was down at the time, or past the window.
 *  - expired             — waited for the machine past `deadlineAt`.
 *  - dispatch_failed     — the run could not be started.
 */
export const TASK_SCHEDULE_SLOT_STATUSES = [
    'started',
    'waiting_for_runner',
    'queued',
    'skipped',
    'missed',
    'expired',
    'dispatch_failed'
] as const
export type TaskScheduleSlotStatus = typeof TASK_SCHEDULE_SLOT_STATUSES[number]

/** Machine-readable `reason` values the hub writes on a slot. A dispatch
 *  failure carries the raw error text instead. */
export const TASK_SCHEDULE_REASONS = [
    'previous-run-active',
    'superseded',
    'machine-offline',
    'hub-offline',
    'outside-window',
    /** Continue mode could not reopen the last session; ran fresh instead. */
    'continue-fallback',
    'archived',
    'task-not-found'
] as const
export type TaskScheduleReason = typeof TASK_SCHEDULE_REASONS[number]

/** Why a task can't run on a schedule. Written as the error code when a
 *  schedule is saved, as a slot's reason when a fire is refused, and as the
 *  schedule's `pausedReason` when the task stops qualifying. */
export const TASK_SCHEDULE_REFUSALS = [
    'archived',
    'invalid-spawn-config',
    'adopted-task',
    'not-worktree',
    'no-machine',
    'not-unattended'
] as const
export type TaskScheduleRefusal = typeof TASK_SCHEDULE_REFUSALS[number]

export const TaskScheduleSlotSchema = z.object({
    id: z.string(),
    taskId: z.string(),
    scheduledFor: z.number(),
    trigger: z.enum(TASK_SCHEDULE_TRIGGERS),
    status: z.enum(TASK_SCHEDULE_SLOT_STATUSES),
    reason: z.string().nullable(),
    deadlineAt: z.number().nullable(),
    runId: z.string().nullable(),
    createdAt: z.number()
})
export type TaskScheduleSlot = z.infer<typeof TaskScheduleSlotSchema>

// --- Cron arithmetic ---------------------------------------------------

const NICKNAMES = new Set(['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly'])

function cronFor(cron: string, tz: string): Cron {
    return new Cron(cron, { timezone: tz, paused: true })
}

/** First fire strictly after `from` (epoch ms), or null if it never fires. */
export function nextScheduleRun(cron: string, tz: string, from: number): number | null {
    const next = cronFor(cron, tz).nextRun(new Date(from))
    return next ? next.getTime() : null
}

/** The next `count` fires strictly after `from`. */
export function nextScheduleRuns(cron: string, tz: string, from: number, count: number): number[] {
    return cronFor(cron, tz).nextRuns(count, new Date(from)).map((date) => date.getTime())
}

export type ScheduleValidation =
    | { ok: true }
    | { ok: false; code: 'invalid-cron' | 'invalid-timezone' | 'never-fires' | 'too-frequent'; message?: string }

/**
 * Whether a cron + zone pair can be saved.
 *
 * Five fields or a nickname only: croner also takes a seconds and a year
 * field, and a stray sixth field would otherwise be read as seconds and fire
 * sixty times as often as meant.
 */
export function validateSchedule(cron: string, tz: string, now: number = Date.now()): ScheduleValidation {
    const trimmed = cron.trim()
    const isNickname = trimmed.startsWith('@')
    if (isNickname ? !NICKNAMES.has(trimmed.toLowerCase()) : trimmed.split(/\s+/).length !== 5) {
        return { ok: false, code: 'invalid-cron' }
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz })
    } catch {
        return { ok: false, code: 'invalid-timezone' }
    }

    let runs: number[]
    try {
        runs = nextScheduleRuns(trimmed, tz, now, 8)
    } catch (error) {
        return { ok: false, code: 'invalid-cron', message: error instanceof Error ? error.message : String(error) }
    }
    if (runs.length === 0) return { ok: false, code: 'never-fires' }
    for (let i = 1; i < runs.length; i++) {
        if (runs.at(i)! - runs.at(i - 1)! < SCHEDULE_MIN_INTERVAL_MS) {
            return { ok: false, code: 'too-frequent' }
        }
    }
    return { ok: true }
}

/**
 * How late a fire may still start: half its period, capped at an hour, never
 * under a minute. Half the period keeps a catch-up from landing on top of the
 * next regular fire; the hour cap keeps a daily 09:00 job from running at
 * 20:00 because the hub came back late.
 */
export function scheduleGraceMs(cron: string, tz: string, at: number): number {
    const [next, after] = nextScheduleRuns(cron, tz, at, 2)
    const period = next !== undefined && after !== undefined ? after - next : 60 * 60_000
    return Math.max(60_000, Math.min(60 * 60_000, Math.floor(period / 2)))
}

// --- Unattended runs ---------------------------------------------------

/** Modes in which an agent does not stop to ask before acting. `auto` still
 *  asks about what it judges risky; the run's time limit covers that case. */
const UNATTENDED_PERMISSION_MODES = new Set([
    'bypassPermissions',
    'yolo',
    'safe-yolo',
    'always-proceed',
    'auto',
    'autoReview'
])

/** Flavors whose unset mode resolves to `auto` (see `modes.ts`). */
const AUTO_BY_DEFAULT_FLAVORS = new Set(['claude', 'codex'])

/**
 * Whether a task's spawn config can run with nobody watching. A scheduled run
 * that stops on a permission prompt sits there until its time limit, so the
 * schedule is refused up front instead.
 */
export function isUnattendedSpawn(spawn: Pick<TaskSpawnConfig, 'flavor' | 'permissionMode' | 'yolo'>): boolean {
    if (spawn.yolo === true) return true
    if (spawn.permissionMode) return UNATTENDED_PERMISSION_MODES.has(spawn.permissionMode)
    return AUTO_BY_DEFAULT_FLAVORS.has(spawn.flavor)
}
