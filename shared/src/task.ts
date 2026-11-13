import { z } from 'zod'
import { AgentFlavorSchema } from './modes'
import {
    CodexCollaborationModeSchema,
    CopilotAgentModeSchema,
    PermissionModeSchema
} from './schemas'

/**
 * Tasks: the orchestration layer over sessions.
 *
 * A Task is the durable *intent* — a prompt plus where and how to run it.
 * A Session is one *execution* of that intent. The two are deliberately
 * separate: a task exists before any session is spawned (backlog), survives
 * the session it spawned (review / done), and can spawn several over its
 * lifetime (retry, follow-up). `Task.currentSessionId` points at the live
 * one; `TaskRun` records the history.
 *
 * Column (the task's state) is stored on the task, not derived from session
 * state. The orchestrator writes it from session signals; the operator can
 * also move a task by hand. Keeping it stored means the task list renders from
 * one indexed query instead of recomputing over every session's agentState.
 */

export const TASK_COLUMNS = ['backlog', 'ready', 'running', 'blocked', 'review', 'done'] as const
export type TaskColumn = typeof TASK_COLUMNS[number]
export const TaskColumnSchema = z.enum(TASK_COLUMNS)

/** Columns whose tasks are waiting on a human, not on an agent. Drives the
 *  attention badge and the "needs you" push/Telegram notification. */
export const TASK_ATTENTION_COLUMNS: readonly TaskColumn[] = ['blocked', 'review']

/**
 * Isolation mode for a task's sessions. Mirrors `SpawnSessionRequest.sessionType`
 * — same two values, same meaning — because starting a task is ultimately a
 * spawn call. Kept as its own schema so tasks can evolve (e.g. a future
 * 'container') without widening the spawn wire type.
 */
export const TaskIsolationSchema = z.enum(['simple', 'worktree'])
export type TaskIsolation = z.infer<typeof TaskIsolationSchema>

/**
 * Agent launch parameters, frozen at task-create time and replayed verbatim
 * on every run. This is what makes a re-run reproducible: same flavor, same
 * model, same permission mode. Field names and shapes track
 * `SpawnSessionRequestSchema` (apiTypes.ts) minus `directory` / `sessionType` /
 * `worktreeName`, which live on the task itself.
 *
 * Deliberately NOT a re-use of `SpawnSessionRequestSchema`: that one is a wire
 * request type that may gain transport-only fields (`startingMode`), and a
 * stored config should not silently absorb them.
 */
export const TaskSpawnConfigSchema = z.object({
    flavor: AgentFlavorSchema,
    model: z.string().optional(),
    effort: z.string().optional(),
    modelReasoningEffort: z.string().optional(),
    permissionMode: PermissionModeSchema.optional(),
    yolo: z.boolean().optional(),
    serviceTier: z.enum(['fast', 'standard']).optional(),
    collaborationMode: CodexCollaborationModeSchema.optional(),
    copilotAgentMode: CopilotAgentModeSchema.optional(),
    /**
     * Set when the task was adopted from a session no task spawned —
     * typically a Claude Code or Codex session someone started from a bare
     * terminal and then imported. Holds the HAPI session id that import
     * produced, which is where the transcript lives and what the task first
     * points at.
     */
    adoptedSessionId: z.string().min(1).optional(),
    /**
     * The agent's own session id for an adopted task — what gets handed to
     * `claude --resume` or `codex resume`.
     *
     * Kept separately from `adoptedSessionId` because a start does not reuse
     * the import row: every start of an adopted task opens a new HAPI session
     * that continues the same native conversation. The import row keeps the
     * history; the native id is the thread.
     */
    adoptedNativeSessionId: z.string().min(1).optional()
})

export type TaskSpawnConfig = z.infer<typeof TaskSpawnConfigSchema>

export const TASK_RUN_STATUSES = ['running', 'succeeded', 'failed', 'canceled', 'orphaned', 'timed_out'] as const
export type TaskRunStatus = typeof TASK_RUN_STATUSES[number]
export const TaskRunStatusSchema = z.enum(TASK_RUN_STATUSES)

/**
 * Run outcomes that leave a transcript worth reopening. A cancelled or failed
 * run is not on the list: there is nothing in it to go back and read, so such
 * a task gets Start rather than an invitation to open a conversation that
 * never happened.
 *
 * Asked of `lastRunStatus` only, not of the whole run history: a task that
 * succeeded once and was cancelled since offers Start. The last run is the one
 * the operator just watched, so it is the better guide to what they mean to do
 * next.
 */
export const OPENABLE_RUN_STATUSES: readonly TaskRunStatus[] = ['succeeded', 'running', 'orphaned']

/** Whether a task's last run left a conversation worth going back into. */
export function hasOpenableRun(status: TaskRunStatus | null): boolean {
    return status !== null && OPENABLE_RUN_STATUSES.includes(status)
}

/**
 * Why a run was started:
 *  - 'user'      — the operator hit Start / Retry.
 *  - 'followup'  — a message sent to an already-finished task resumed it.
 *  - 'reconcile' — the hub restarted a run it found orphaned at boot.
 *  - 'scheduled' — the task's schedule fired (`taskSchedule.ts`).
 * Recorded so the UI can distinguish an operator retry from an automatic
 * one when showing run history.
 */
export const TASK_RUN_ORIGINS = ['user', 'followup', 'reconcile', 'scheduled'] as const
export type TaskRunOrigin = typeof TASK_RUN_ORIGINS[number]
export const TaskRunOriginSchema = z.enum(TASK_RUN_ORIGINS)

export const TaskRunSchema = z.object({
    id: z.string(),
    taskId: z.string(),
    /** The session this run drove. Null while the spawn is still in flight,
     *  and stays null if the spawn failed outright. */
    sessionId: z.string().nullable(),
    status: TaskRunStatusSchema,
    origin: TaskRunOriginSchema,
    /** Ref the run was asked to branch from (`main`, a tag, a sha). Copied
     *  from `Task.baseRef` at start so editing the task later doesn't
     *  rewrite history. */
    baseRef: z.string().nullable(),
    /** The commit `baseRef` actually resolved to. This is the reproducibility
     *  anchor — re-running from `baseCommit` gives the same starting tree even
     *  after `main` has moved. */
    baseCommit: z.string().nullable(),
    branch: z.string().nullable(),
    worktreePath: z.string().nullable(),
    startedAt: z.number(),
    endedAt: z.number().nullable(),
    /** User-facing failure reason. Null on success and while running. */
    error: z.string().nullable()
})

export type TaskRun = z.infer<typeof TaskRunSchema>

/**
 * Review-column state: the pull request a finished task produced.
 *
 * A snapshot, not a live view — refreshed on demand from the forge and cached
 * on the task so the UI can render a task without an API call per task.
 * `checkedAt` is what tells the UI how stale it is.
 */
export const TASK_PR_STATES = ['open', 'merged', 'closed'] as const
export type TaskPullRequestState = typeof TASK_PR_STATES[number]
export const TaskPullRequestStateSchema = z.enum(TASK_PR_STATES)

/**
 * Rolled-up CI verdict:
 *  - 'none'    — the forge reports no checks for the head commit.
 *  - 'pending' — at least one check is queued or running.
 *  - 'failing' — at least one concluded check failed.
 *  - 'passing' — every check concluded successfully.
 * Null means the state was never fetched (older row, or a forge that does not
 * expose checks).
 */
export const TASK_PR_CHECK_STATES = ['none', 'pending', 'passing', 'failing'] as const
export type TaskPullRequestChecks = typeof TASK_PR_CHECK_STATES[number]
export const TaskPullRequestChecksSchema = z.enum(TASK_PR_CHECK_STATES)

export const TaskPullRequestSchema = z.object({
    url: z.string(),
    number: z.number(),
    state: TaskPullRequestStateSchema,
    title: z.string(),
    /** Source branch, as the forge sees it. Mirrors `Task.branch` at open time. */
    headBranch: z.string(),
    baseBranch: z.string(),
    isDraft: z.boolean(),
    /** Forge's mergeability verdict. Null while it is still computing one —
     *  GitHub answers `null` for a few seconds after every push. */
    mergeable: z.boolean().nullable(),
    checks: TaskPullRequestChecksSchema.nullable(),
    /** Epoch ms of the last successful refresh. */
    checkedAt: z.number()
})

export type TaskPullRequest = z.infer<typeof TaskPullRequestSchema>

export const TaskSchema = z.object({
    id: z.string(),
    namespace: z.string(),
    /** Short label. Derived from `prompt` at create time when the
     *  operator doesn't supply one; editable afterwards. */
    title: z.string(),
    prompt: z.string(),
    column: TaskColumnSchema,
    /** Machine the task runs on. Nullable so a task can be drafted in the
     *  backlog before picking one. Not an FK — machines can be forgotten
     *  while their tasks stay (same rule as `sessions.machineId`). */
    machineId: z.string().nullable(),
    /** Repo / directory the agent starts in. For `isolation: 'worktree'` this
     *  is the *source* repo; the session runs in `worktreePath`. */
    workdir: z.string(),
    isolation: TaskIsolationSchema,
    /** Operator-supplied worktree name hint, passed through to spawn. Null
     *  lets the runner auto-name it. */
    worktreeName: z.string().nullable(),
    /** Pinned at create time so every run starts from the same place even
     *  after the default branch moves. Null means "whatever HEAD is". */
    baseRef: z.string().nullable(),
    /** Resolved on the most recent run; mirrors `TaskRun.branch` for cheap
     *  rendering without a join. */
    branch: z.string().nullable(),
    worktreePath: z.string().nullable(),
    spawn: TaskSpawnConfigSchema,
    /** The live session, when the task has one. Cleared when the session is
     *  deleted (`ON DELETE SET NULL`) so a stale id never leaks to the UI. */
    currentSessionId: z.string().nullable(),
    lastRunId: z.string().nullable(),
    lastRunStatus: TaskRunStatusSchema.nullable(),
    /** Failure reason from the last run, kept on the task so a `blocked` /
     *  `ready`-after-failure task can explain itself without a runs query. */
    lastError: z.string().nullable(),
    /** Set once a PR has been opened for this task. Survives the run that
     *  produced it — the task stays reviewable after the agent is gone. */
    pullRequest: TaskPullRequestSchema.nullable(),
    archivedAt: z.number().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    /** Monotonic per-write counter, same role as `Session.seq`: lets SSE
     *  consumers drop out-of-order patches. */
    seq: z.number()
})

export type Task = z.infer<typeof TaskSchema>

/**
 * Derive a task label from a prompt.
 *
 * Task lists are scanned, not read: the title is the only part of a task most
 * glances take in. First line, collapsed whitespace, truncated on a word
 * boundary. Exported so the web composer can preview the same title the hub
 * will store when the operator leaves the field blank.
 */
export const TASK_TITLE_MAX_LENGTH = 80

export function deriveTaskTitle(prompt: string): string {
    const firstLine = prompt.split('\n').find((line) => line.trim().length > 0) ?? ''
    const collapsed = firstLine.trim().replace(/\s+/g, ' ')
    if (collapsed.length <= TASK_TITLE_MAX_LENGTH) {
        return collapsed
    }

    const clipped = collapsed.slice(0, TASK_TITLE_MAX_LENGTH)
    const lastSpace = clipped.lastIndexOf(' ')
    // Only break on a word boundary if one sits reasonably near the end -
    // otherwise a long unbroken token would collapse the title to nothing.
    const body = lastSpace > TASK_TITLE_MAX_LENGTH * 0.6 ? clipped.slice(0, lastSpace) : clipped
    return `${body.trimEnd()}...`
}

/**
 * Machine-readable prefix for failures the hub itself authored.
 *
 * `Task.lastError` is a mixed field: it carries both these, and raw output from
 * the agent or git ("protected branch hook declined"). The latter must reach
 * the operator verbatim — translating it would destroy the evidence — so the
 * hub's own messages are tagged instead, and only tagged ones get localised.
 *
 * Wire shape: `hapi:<code>` or `hapi:<code>|<detail>`.
 */
export const TASK_ERROR_PREFIX = 'hapi:'

export const TASK_ERROR_CODES = [
    /** The hub restarted while the run was in flight. */
    'run.interrupted',
    /** The session backing the run was deleted out from under it. */
    'run.sessionDeleted',
    /** The agent started but never received the task prompt. */
    'run.promptUndelivered',
    /** The session ended reporting an error. */
    'run.sessionError',
    /** A scheduled run went past its schedule's time limit and was stopped. */
    'run.timedOut'
] as const

export type TaskErrorCode = typeof TASK_ERROR_CODES[number]

export function encodeTaskError(code: TaskErrorCode, detail?: string): string {
    return detail ? `${TASK_ERROR_PREFIX}${code}|${detail}` : `${TASK_ERROR_PREFIX}${code}`
}

/** Null for anything the hub did not author — display those unchanged. */
export function decodeTaskError(raw: string | null | undefined): { code: TaskErrorCode; detail?: string } | null {
    if (!raw || !raw.startsWith(TASK_ERROR_PREFIX)) return null
    const body = raw.slice(TASK_ERROR_PREFIX.length)
    const separator = body.indexOf('|')
    const code = (separator === -1 ? body : body.slice(0, separator)) as TaskErrorCode
    if (!(TASK_ERROR_CODES as readonly string[]).includes(code)) return null
    const detail = separator === -1 ? undefined : body.slice(separator + 1)
    return detail ? { code, detail } : { code }
}

export function isTaskColumn(value: string | null | undefined): value is TaskColumn {
    return typeof value === 'string' && (TASK_COLUMNS as readonly string[]).includes(value)
}

export function isTaskRunStatus(value: string | null | undefined): value is TaskRunStatus {
    return typeof value === 'string' && (TASK_RUN_STATUSES as readonly string[]).includes(value)
}

export function isTaskIsolation(value: string | null | undefined): value is TaskIsolation {
    return value === 'simple' || value === 'worktree'
}

export function taskNeedsAttention(task: Pick<Task, 'column' | 'archivedAt'>): boolean {
    return task.archivedAt === null && TASK_ATTENTION_COLUMNS.includes(task.column)
}

/**
 * A task is "live" when it owns a session that should still be running.
 * Used by the boot reconciler to find rows to flip to `orphaned`, and by the
 * UI to decide whether Start or Cancel is the primary action.
 */
export function isTaskRunning(task: Pick<Task, 'column' | 'lastRunStatus'>): boolean {
    return task.column === 'running' && task.lastRunStatus === 'running'
}
