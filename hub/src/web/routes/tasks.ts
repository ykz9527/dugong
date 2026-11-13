import {
    AdoptTaskRequestSchema,
    ArchiveTaskRequestSchema,
    CreateTaskRequestSchema,
    MoveTaskRequestSchema,
    TaskPullRequestSchema,
    TaskSpawnConfigSchema,
    TASK_RUN_ORIGINS,
    UpdateTaskRequestSchema,
    deriveTaskTitle,
    isPermissionModeAllowedForFlavor,
    isTaskColumn,
    isTaskIsolation,
    isTaskRunStatus,
    type Task,
    type TaskDetailResponse,
    type TaskListResponse,
    type TaskRun,
    type TaskRunOrigin
} from '@hapi/protocol'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { Store, StoredTask, StoredTaskRun } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { AdoptSessionResult, TaskOrchestrator } from '../../sync/taskOrchestrator'
import type { TaskReviewFailure, TaskReviewService } from '../../sync/taskReview'
import type { TaskWorktreeService, WorktreeTeardownResult } from '../../sync/taskWorktree'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine, requireSyncEngine } from './guards'
import { resolveWorkspaceScope, taskInScope, type WorkspaceScope } from './workspaceScope'

/**
 * Task REST surface.
 *
 * Reads go straight to the store; anything that starts, stops, or otherwise
 * moves an agent goes through the orchestrator, which owns that policy. The
 * split matters: two code paths deciding when a task is `running` is how the
 * task list starts lying.
 */

const MAX_LIST_LIMIT = 500
const DEFAULT_RUN_LIMIT = 50

/** Body of `POST /tasks/:id/pr`. Every field is optional: the base defaults to
 *  the task's base ref (or the forge's default branch), the title to the task's. */
const OpenPullRequestBodySchema = z.object({
    baseBranch: z.string().trim().min(1).max(255).optional(),
    title: z.string().trim().min(1).max(256).optional(),
    draft: z.boolean().optional()
})

/**
 * Widen a stored row into its wire type.
 *
 * Returns null for a row whose enum-typed columns no longer parse. Those
 * values are validated on write, so a failure here means the row was edited
 * out of band or written by a newer hub - either way, guessing a substitute
 * would show a task that misrepresents itself.
 */
function toTask(row: StoredTask): Task | null {
    const spawn = TaskSpawnConfigSchema.safeParse(row.spawn)
    if (!spawn.success) return null
    if (!isTaskColumn(row.column)) return null
    if (!isTaskIsolation(row.isolation)) return null
    if (row.lastRunStatus !== null && !isTaskRunStatus(row.lastRunStatus)) return null

    // A stale or unparseable PR snapshot is dropped rather than failing the
    // task: the task itself is still valid, and the next refresh rewrites it.
    const pullRequest = row.pullRequest === null
        ? null
        : TaskPullRequestSchema.safeParse(row.pullRequest)

    return {
        id: row.id,
        namespace: row.namespace,
        title: row.title,
        prompt: row.prompt,
        column: row.column,
        machineId: row.machineId,
        workdir: row.workdir,
        isolation: row.isolation,
        worktreeName: row.worktreeName,
        baseRef: row.baseRef,
        branch: row.branch,
        worktreePath: row.worktreePath,
        spawn: spawn.data,
        currentSessionId: row.currentSessionId,
        lastRunId: row.lastRunId,
        lastRunStatus: row.lastRunStatus,
        lastError: row.lastError,
        pullRequest: pullRequest && pullRequest.success ? pullRequest.data : null,
        archivedAt: row.archivedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        seq: row.seq
    }
}

function toTaskRun(row: StoredTaskRun): TaskRun | null {
    if (!isTaskRunStatus(row.status)) return null
    const origin = (TASK_RUN_ORIGINS as readonly string[]).includes(row.origin) ? row.origin as TaskRunOrigin : 'user'

    return {
        id: row.id,
        taskId: row.taskId,
        sessionId: row.sessionId,
        status: row.status,
        origin,
        baseRef: row.baseRef,
        baseCommit: row.baseCommit,
        branch: row.branch,
        worktreePath: row.worktreePath,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        error: row.error
    }
}

/** Resolve `:id` within the caller's namespace, or produce the 404. */
function requireTask(
    c: Context<WebAppEnv>,
    store: Store
): { row: StoredTask; task: Task } | Response {
    const row = store.tasks.getByNamespace(c.req.param('id') ?? '', c.get('namespace'))
    if (!row) {
        return c.json({ error: 'Task not found' }, 404)
    }
    const task = toTask(row)
    if (!task) {
        return c.json({ error: 'Task row is not readable', code: 'task_corrupt' }, 500)
    }
    return { row, task }
}

function requireOrchestrator(
    c: Context<WebAppEnv>,
    getTaskOrchestrator: () => TaskOrchestrator | null
): TaskOrchestrator | Response {
    const orchestrator = getTaskOrchestrator()
    if (!orchestrator) {
        return c.json({ error: 'Not connected' }, 503)
    }
    return orchestrator
}

/** Machines are namespaced; a task must not be able to name one it cannot see. */
function checkMachineAccess(
    c: Context<WebAppEnv>,
    getSyncEngine: () => SyncEngine | null,
    machineId: string
): Response | null {
    const engine = requireSyncEngine(c, getSyncEngine)
    if (engine instanceof Response) return engine
    const machine = requireMachine(c, engine, machineId)
    return machine instanceof Response ? machine : null
}

/**
 * Map a review-flow failure onto a status and a machine-readable code.
 *
 * Each of these is a different thing for the operator to do — add a token,
 * resume the session, fix a rejected push — so they get distinct codes rather
 * than one generic 500.
 */
function reviewFailureResponse(c: Context<WebAppEnv>, failure: TaskReviewFailure): Response {
    switch (failure.outcome) {
        case 'task-not-found':
            return c.json({ error: 'Task not found' }, 404)
        case 'no-branch':
            return c.json({ error: failure.message, code: 'task_no_branch' }, 400)
        case 'no-session':
            return c.json({ error: failure.message, code: 'session_offline' }, 409)
        case 'push-failed':
            return c.json({ error: failure.message, code: 'push_failed' }, 502)
        case 'no-pull-request':
            return c.json({ error: failure.message, code: 'no_pull_request' }, 404)
        case 'no-token':
            return c.json({
                error: `No access token configured for ${failure.host}`,
                code: 'git_host_no_token',
                host: failure.host
            }, 400)
        case 'unsupported-host':
            return c.json({
                error: `${failure.host} is not supported yet; only GitHub and GitHub Enterprise are`,
                code: 'git_host_unsupported',
                host: failure.host
            }, 400)
        case 'unauthorized':
            return c.json({ error: failure.message, code: 'git_host_unauthorized' }, 403)
        case 'not-found':
            return c.json({ error: failure.message, code: 'git_host_not_found' }, 404)
        case 'already-exists':
            return c.json({ error: failure.message, code: 'pull_request_exists', url: failure.url }, 409)
        case 'owner-only':
            return c.json({
                error: 'Pull requests use the hub owner\'s git host tokens and are only available to the owner',
                code: 'git_host_owner_only'
            }, 403)
        case 'rejected':
        case 'network-error':
            return c.json({ error: failure.message, code: 'git_host_error' }, 502)
    }
}

/** Map the orchestrator's refusal to adopt a session onto an HTTP answer. */
function adoptFailureResponse(
    c: Context<WebAppEnv>,
    result: Exclude<AdoptSessionResult, { outcome: 'adopted' }>,
    machineDenied: Response | null
): Response {
    if (result.outcome === 'not-found') {
        return c.json({ error: 'Session not found' }, 404)
    }
    if (result.outcome === 'already-on-board') {
        return c.json({ error: 'This session already belongs to a task', taskId: result.task?.id }, 409)
    }
    switch (result.reason) {
        case 'machine-not-allowed':
            return machineDenied ?? c.json({ error: 'Machine not found' }, 404)
        case 'not-resumable':
            return c.json({
                error: result.flavor === 'claude' || result.flavor === 'codex'
                    ? 'Session has no native session id to resume'
                    : `Adopting a ${result.flavor ?? 'unknown'} session is not supported yet`
            }, 400)
        case 'no-workdir':
            return c.json({ error: 'Session has no working directory to adopt' }, 400)
        case 'no-machine':
            return c.json({ error: 'Session is not bound to a machine' }, 400)
        case 'unknown-flavor':
            return c.json({ error: 'Session has an unknown agent flavor' }, 400)
        case 'assistant':
            return c.json({ error: 'An assistant session cannot be adopted' }, 400)
    }
}

/**
 * Live task count per column.
 *
 * Unscoped this is one grouped scan in SQL. Scoped it cannot be: ownership is
 * a path-prefix test the schema knows nothing about, so the rows are counted
 * in memory instead. There are hundreds of tasks, not millions, and a header
 * that counted somebody else's work would undo the filter it sits above.
 */
function countColumns(store: Store, namespace: string, scope: WorkspaceScope): Record<string, number> {
    if (!scope) return store.tasks.countByColumn(namespace)

    const counts: Record<string, number> = {}
    for (const row of store.tasks.list(namespace, {})) {
        if (!taskInScope(row, scope)) continue
        counts[row.column] = (counts[row.column] ?? 0) + 1
    }
    return counts
}

export function createTasksRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
    getTaskOrchestrator: () => TaskOrchestrator | null
    getTaskReview: () => TaskReviewService | null
    getTaskWorktree: () => TaskWorktreeService | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const { store, getSyncEngine, getTaskOrchestrator, getTaskReview, getTaskWorktree } = options

    const requireReview = (c: Context<WebAppEnv>): TaskReviewService | Response => {
        const review = getTaskReview()
        return review ?? c.json({ error: 'Not connected' }, 503)
    }

    /** Uncommitted file count in the task's worktree, or null when it is clean
     *  or cannot be asked (no worktree, machine offline: teardown reports those). */
    const probeDirtyWorktree = async (row: StoredTask): Promise<number | null> => {
        const service = getTaskWorktree()
        if (!service) return null
        const probe = await service.probe(row)
        return probe.outcome === 'dirty' ? probe.changedFiles : null
    }

    app.get('/tasks', (c) => {
        const namespace = c.get('namespace')
        const query = c.req.query()

        if (query.column !== undefined && !isTaskColumn(query.column)) {
            return c.json({ error: 'Unknown column' }, 400)
        }

        const parsedLimit = query.limit !== undefined ? Number(query.limit) : undefined
        if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
            return c.json({ error: 'limit must be a positive integer' }, 400)
        }

        const scope = resolveWorkspaceScope(c, store, query.workspaceUser)
        if (scope instanceof Response) return scope

        const rows = store.tasks.list(namespace, {
            column: query.column,
            machineId: query.machineId,
            includeArchived: query.includeArchived === 'true',
            // A scoped list pages in the store's terms and filters in the
            // user's, so the limit has to be applied after ownership - taking
            // 50 rows first would hand back 50 tasks minus everyone else's.
            limit: scope
                ? undefined
                : parsedLimit === undefined ? undefined : Math.min(parsedLimit, MAX_LIST_LIMIT)
        }).filter((row) => taskInScope(row, scope))

        const limited = scope && parsedLimit !== undefined
            ? rows.slice(0, Math.min(parsedLimit, MAX_LIST_LIMIT))
            : rows

        // Unreadable rows are dropped rather than failing the whole list -
        // one bad task should not blank the view.
        const tasks = limited.map(toTask).filter((task): task is Task => task !== null)
        const response: TaskListResponse = { tasks, counts: countColumns(store, namespace, scope) }
        return c.json(response)
    })

    app.post('/tasks', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = CreateTaskRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const body = parsed.data
        if (body.start && !body.machineId) {
            return c.json({ error: 'start requires a machineId' }, 400)
        }
        if (body.machineId) {
            const denied = checkMachineAccess(c, getSyncEngine, body.machineId)
            if (denied) return denied
        }

        const title = body.title ?? deriveTaskTitle(body.prompt)
        if (!title) {
            return c.json({ error: 'Could not derive a title from the prompt; supply one' }, 400)
        }

        // Checked before creating: a 503 must not leave a task behind.
        const orchestrator = body.start ? requireOrchestrator(c, getTaskOrchestrator) : null
        if (orchestrator instanceof Response) return orchestrator

        const row = store.tasks.create({
            namespace: c.get('namespace'),
            title,
            prompt: body.prompt,
            workdir: body.workdir,
            spawn: body.spawn,
            column: body.column,
            machineId: body.machineId,
            isolation: body.isolation,
            worktreeName: body.worktreeName,
            baseRef: body.baseRef
        })

        if (!orchestrator) {
            const created = toTask(row)
            return created ? c.json({ task: created }, 201) : c.json({ error: 'Task row is not readable' }, 500)
        }

        const started = await orchestrator.startTask(row.id, c.get('namespace'))
        const refreshed = store.tasks.get(row.id)
        const task = refreshed ? toTask(refreshed) : null
        if (!task) {
            return c.json({ error: 'Task row is not readable' }, 500)
        }

        // The task exists either way - a failed start is reported alongside it
        // rather than as an error, so the client keeps the task it just made.
        return c.json({
            task,
            start: started.outcome === 'started'
                ? { outcome: started.outcome, runId: started.runId, sessionId: started.sessionId }
                : { outcome: started.outcome, message: 'message' in started ? started.message : undefined }
        }, 201)
    })

    /**
     * Adopt an existing session as a task.
     *
     * The session is the source of truth for everything the task needs, so the
     * body carries only its id. Isolation is forced to `simple`: the
     * conversation is anchored to the directory it already ran in, and a
     * worktree would move the task somewhere the agent's own history does not
     * point.
     *
     * The task lands with one finished run already attached, which is what
     * makes it offer `Open chat` rather than `Start` — for a conversation that
     * already happened, reading it is the likely next move.
     */
    app.post('/tasks/adopt', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = AdoptTaskRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const orchestrator = requireOrchestrator(c, getTaskOrchestrator)
        if (orchestrator instanceof Response) return orchestrator

        // The orchestrator owns the adoption rules; this only maps its answer.
        const machineDenial: { response: Response | null } = { response: null }
        const result = orchestrator.adoptSession(parsed.data.sessionId, {
            namespace: c.get('namespace'),
            title: parsed.data.title,
            permissionMode: parsed.data.permissionMode,
            column: parsed.data.column,
            origin: 'user',
            requireResumable: true,
            allowMachine: (machineId) => {
                machineDenial.response = checkMachineAccess(c, getSyncEngine, machineId)
                return machineDenial.response === null
            }
        })
        if (result.outcome !== 'adopted') {
            return adoptFailureResponse(c, result, machineDenial.response)
        }
        const task = toTask(result.task)
        if (!task) {
            return c.json({ error: 'Task row is not readable' }, 500)
        }
        return c.json({ task }, 201)
    })

    app.get('/tasks/:id', (c) => {
        const resolved = requireTask(c, store)
        if (resolved instanceof Response) return resolved

        const runs = store.tasks
            .listRuns(resolved.row.id, DEFAULT_RUN_LIMIT)
            .map(toTaskRun)
            .filter((run): run is TaskRun => run !== null)

        const response: TaskDetailResponse = { task: resolved.task, runs }
        return c.json(response)
    })

    app.patch('/tasks/:id', async (c) => {
        const resolved = requireTask(c, store)
        if (resolved instanceof Response) return resolved

        const json = await c.req.json().catch(() => null)
        const parsed = UpdateTaskRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const body = parsed.data
        if (body.machineId) {
            const denied = checkMachineAccess(c, getSyncEngine, body.machineId)
            if (denied) return denied
        }

        // Editing where or how a task runs while it is running would describe
        // one thing and execute another. The live fields stay frozen until the
        // run settles; title and prompt remain editable.
        const touchesExecution = body.workdir !== undefined
            || body.isolation !== undefined
            || body.worktreeName !== undefined
            || body.baseRef !== undefined
            || body.spawn !== undefined
            || body.machineId !== undefined
        if (touchesExecution && store.tasks.getActiveRun(resolved.row.id)) {
            return c.json({
                error: 'Cannot change how a running task executes; cancel it first',
                code: 'task_running'
            }, 409)
        }

        const updated = store.tasks.update(resolved.row.id, c.get('namespace'), body)
        if (!updated) {
            return c.json({ error: 'Task not found' }, 404)
        }

        const task = toTask(updated)
        return task ? c.json({ task }) : c.json({ error: 'Task row is not readable' }, 500)
    })

    app.post('/tasks/:id/move', async (c) => {
        const resolved = requireTask(c, store)
        if (resolved instanceof Response) return resolved

        const json = await c.req.json().catch(() => null)
        const parsed = MoveTaskRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const moved = store.tasks.move(resolved.row.id, c.get('namespace'), parsed.data.column)
        if (!moved) {
            return c.json({ error: 'Task not found' }, 404)
        }

        const task = toTask(moved)
        return task ? c.json({ task }) : c.json({ error: 'Task row is not readable' }, 500)
    })

    app.post('/tasks/:id/start', async (c) => {
        const resolved = requireTask(c, store)
        if (resolved instanceof Response) return resolved

        const orchestrator = requireOrchestrator(c, getTaskOrchestrator)
        if (orchestrator instanceof Response) return orchestrator

        const result = await orchestrator.startTask(resolved.row.id, c.get('namespace'))
        switch (result.outcome) {
            case 'started': {
                const task = toTask(result.task)
                return task
                    ? c.json({ task, runId: result.runId, sessionId: result.sessionId })
                    : c.json({ error: 'Task row is not readable' }, 500)
            }
            case 'task-not-found':
                return c.json({ error: 'Task not found' }, 404)
            case 'already-running':
                return c.json({ error: 'Task is already running', code: 'task_running' }, 409)
            case 'archived':
                return c.json({ error: 'Task is archived; unarchive it first', code: 'task_archived' }, 409)
            case 'no-machine':
                return c.json({ error: 'Task has no machine assigned', code: 'task_no_machine' }, 400)
            case 'invalid-spawn-config':
                return c.json({ error: `Invalid agent config: ${result.message}` }, 400)
            case 'spawn-failed':
                // The runner refused or was unreachable: upstream failure. The
                // run is already settled as failed and the task is in `blocked`.
                return c.json({ error: result.message, code: 'spawn_failed' }, 502)
            case 'prompt-failed':
                // The agent came up but never received the task. The run is
                // already settled as failed and the task is in `blocked`;
                // Start again to retry.
                return c.json({
                    error: `Agent started but the prompt could not be delivered: ${result.message}`,
                    code: 'prompt_delivery_failed'
                }, 502)
        }
    })

    app.post('/tasks/:id/cancel', async (c) => {
        const resolved = requireTask(c, store)
        if (resolved instanceof Response) return resolved

        const orchestrator = requireOrchestrator(c, getTaskOrchestrator)
        if (orchestrator instanceof Response) return orchestrator

        const result = await orchestrator.cancelTask(resolved.row.id, c.get('namespace'))
        if (result.outcome === 'task-not-found') {
            return c.json({ error: 'Task not found' }, 404)
        }
        if (result.outcome === 'not-running') {
            return c.json({ error: 'Task is not running', code: 'task_not_running' }, 409)
        }

        const task = toTask(result.task)
        return task ? c.json({ task }) : c.json({ error: 'Task row is not readable' }, 500)
    })

    /**
     * Archive, the last step of `review -> done -> archive`.
     *
     * Two gates: a task must be in Done, and its run must be finished. Each
     * has an opt-out (`force`, `stopRun`) rather than being silently
     * permissive, because both describe something the operator meant to do --
     * retiring an unfinished task, or ending a live agent.
     *
     * `stopRun` is the common case, not an edge: a Claude Code session does not
     * exit between turns, so *every* task in Review still owns a `running` run
     * and would hit the active-run gate -- without `stopRun` the finish flow is
     * unreachable by design.
     *
     * Uncommitted work in the worktree is checked before anything is stopped:
     * the operator is asked first, and a refusal leaves the agent running.
     */
    app.post('/tasks/:id/archive', async (c) => {
        const resolved = requireTask(c, store)
        if (resolved instanceof Response) return resolved

        // An empty body is the common case (the archive button on an
        // already-settled task), so absent JSON means "no opt-outs", not a 400.
        const parsed = ArchiveTaskRequestSchema.safeParse(await c.req.json().catch(() => ({})))
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        const {
            force = false,
            stopRun = false,
            keepWorktree = false,
            forceWorktree = false
        } = parsed.data

        // Checked here rather than left to `store.tasks.archive` returning
        // null: from this point on the request tears things down, and a second
        // archive of the same task must not pay that price again.
        if (resolved.row.archivedAt !== null) {
            return c.json({ error: 'Task is already archived' }, 409)
        }

        if (resolved.row.column !== 'done' && !force) {
            return c.json({
                error: 'Only a task in Done can be archived',
                code: 'task_not_done',
                column: resolved.row.column
            }, 409)
        }

        const activeRun = store.tasks.getActiveRun(resolved.row.id)
        if (activeRun && !stopRun) {
            return c.json({ error: 'Cannot archive a running task; cancel it first', code: 'task_running' }, 409)
        }
        const canceller = activeRun ? requireOrchestrator(c, getTaskOrchestrator) : null
        if (canceller instanceof Response) return canceller

        // Asked before anything is stopped: refusing over uncommitted work
        // after the agent had been killed would cost the operator the session
        // for nothing. The same rule as deleting a task -- uncommitted work
        // stops the request instead of being reported -- and the task stays
        // reachable, so the operator can still commit or discard.
        if (!keepWorktree && !forceWorktree) {
            const dirty = await probeDirtyWorktree(resolved.row)
            if (dirty !== null) {
                return c.json({
                    error: `The worktree has ${dirty} uncommitted change(s). `
                        + 'Commit them, or re-run with forceWorktree=true to archive anyway.',
                    code: 'worktree_dirty',
                    changedFiles: dirty
                }, 409)
            }
        }

        // An archived task is out of sight; it must not keep running on its
        // schedule. Paused before the teardown below, so no fire can start a
        // run while it is under way. Unarchiving does not resume it -- that
        // stays a decision.
        if (store.taskSchedules.get(resolved.row.id, c.get('namespace'))?.enabled) {
            store.taskSchedules.pause(resolved.row.id, 'archived')
        }

        if (canceller) {
            // Cancelling settles the run into `ready` -- that is the rule for a
            // run the operator stopped. It is the wrong answer here only
            // because the cancel was an implementation detail of archiving,
            // not a decision to un-finish the task, so the column the caller
            // archived from is put back before we continue.
            const columnBefore = resolved.row.column
            const cancelled = await canceller.cancelTask(resolved.row.id, c.get('namespace'))
            if (cancelled.outcome === 'task-not-found') {
                return c.json({ error: 'Task not found' }, 404)
            }
            if (cancelled.outcome === 'canceled') {
                store.tasks.move(resolved.row.id, c.get('namespace'), columnBefore)
            }
        }

        // Archiving hides the task, and nothing in the UI can reach a hidden
        // task's session again -- so a session still running under it has to be
        // retired here or not at all. The gate above does not cover this: it
        // only sees runs the store still calls `running`, and the session that
        // outlives a settled run (a restart is the usual way) is invisible to
        // it while the agent keeps going.
        const orchestrator = getTaskOrchestrator()
        const session = orchestrator ? await orchestrator.retireSession(resolved.row) : 'none'

        // Then the checkout, to reclaim the space. The branch is deliberately
        // kept -- `deleteBranch: false` -- because archiving is reversible:
        // every commit survives, and the runner rebuilds the worktree at the
        // same deterministic path if the task ever runs again. Deleting the
        // branch is `DELETE /tasks/:id`'s job, and that one is not reversible.
        let worktree: WorktreeTeardownResult = { outcome: 'skipped', reason: 'no-worktree' }
        const service = getTaskWorktree()
        if (!keepWorktree && service) {
            worktree = await service.teardown(resolved.row, {
                force: forceWorktree,
                deleteBranch: false
            })

            // Probed clean above, but the agent may have written since; the
            // runner still refuses, and the task stays unarchived.
            if (worktree.outcome === 'dirty') {
                return c.json({
                    error: `The worktree has ${worktree.changedFiles} uncommitted change(s). `
                        + 'Commit them, or re-run with forceWorktree=true to archive anyway.',
                    code: 'worktree_dirty',
                    changedFiles: worktree.changedFiles,
                    session
                }, 409)
            }
        }

        const archived = store.tasks.archive(resolved.row.id, c.get('namespace'))
        if (!archived) {
            return c.json({ error: 'Task is already archived' }, 409)
        }

        const task = toTask(archived)
        // The teardown outcomes ride along for the same reason they do on
        // delete: a branch left behind, or a machine that was offline, is
        // something the operator has to know rather than discover from `ps`.
        return task
            ? c.json({ task, worktree, session })
            : c.json({ error: 'Task row is not readable' }, 500)
    })

    app.post('/tasks/:id/unarchive', (c) => {
        const resolved = requireTask(c, store)
        if (resolved instanceof Response) return resolved

        const restored = store.tasks.unarchive(resolved.row.id, c.get('namespace'))
        if (!restored) {
            return c.json({ error: 'Task is not archived' }, 409)
        }

        const task = toTask(restored)
        return task ? c.json({ task }) : c.json({ error: 'Task row is not readable' }, 500)
    })

    app.post('/tasks/:id/pr', async (c) => {
        const resolved = requireTask(c, store)
        if (resolved instanceof Response) return resolved

        const review = requireReview(c)
        if (review instanceof Response) return review

        // An empty body means "all defaults", like archive.
        const parsed = OpenPullRequestBodySchema.safeParse(await c.req.json().catch(() => ({})))
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        const result = await review.openPullRequest(resolved.row.id, c.get('namespace'), {
            baseBranch: parsed.data.baseBranch,
            title: parsed.data.title,
            draft: parsed.data.draft === true
        })
        if (result.outcome !== 'ok') return reviewFailureResponse(c, result)

        const refreshed = store.tasks.get(resolved.row.id)
        const task = refreshed ? toTask(refreshed) : null
        return task
            ? c.json({ task, pullRequest: result.value }, 201)
            : c.json({ error: 'Task row is not readable' }, 500)
    })

    app.post('/tasks/:id/pr/refresh', async (c) => {
        const resolved = requireTask(c, store)
        if (resolved instanceof Response) return resolved

        const review = requireReview(c)
        if (review instanceof Response) return review

        const result = await review.refreshPullRequest(resolved.row.id, c.get('namespace'))
        if (result.outcome !== 'ok') return reviewFailureResponse(c, result)

        const refreshed = store.tasks.get(resolved.row.id)
        const task = refreshed ? toTask(refreshed) : null
        return task
            ? c.json({ task, pullRequest: result.value })
            : c.json({ error: 'Task row is not readable' }, 500)
    })

    app.delete('/tasks/:id/pr', (c) => {
        const resolved = requireTask(c, store)
        if (resolved instanceof Response) return resolved

        const review = requireReview(c)
        if (review instanceof Response) return review

        const result = review.forgetPullRequest(resolved.row.id, c.get('namespace'))
        if (result.outcome !== 'ok') return reviewFailureResponse(c, result)

        const task = toTask(result.value)
        return task ? c.json({ task }) : c.json({ error: 'Task row is not readable' }, 500)
    })

    app.get('/tasks/:id/runs', (c) => {
        const resolved = requireTask(c, store)
        if (resolved instanceof Response) return resolved

        const query = c.req.query()
        const parsedLimit = query.limit !== undefined ? Number(query.limit) : undefined
        if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
            return c.json({ error: 'limit must be a positive integer' }, 400)
        }

        const runs = store.tasks
            .listRuns(resolved.row.id, Math.min(parsedLimit ?? DEFAULT_RUN_LIMIT, MAX_LIST_LIMIT))
            .map(toTaskRun)
            .filter((run): run is TaskRun => run !== null)

        return c.json({ runs })
    })

    app.delete('/tasks/:id', async (c) => {
        const resolved = requireTask(c, store)
        if (resolved instanceof Response) return resolved

        const query = c.req.query()
        const keepWorktree = query.worktree === 'keep'
        const force = query.force === 'true'
        const stopRun = query.stopRun === 'true'

        const activeRun = store.tasks.getActiveRun(resolved.row.id)
        if (activeRun && !stopRun) {
            return c.json({ error: 'Cannot delete a running task; cancel it first', code: 'task_running' }, 409)
        }
        const canceller = activeRun ? requireOrchestrator(c, getTaskOrchestrator) : null
        if (canceller instanceof Response) return canceller

        // Uncommitted work is the one thing that stops a delete, and it is
        // asked about before the run is cancelled or the agent stopped: a
        // refused delete must leave the task exactly as it was.
        if (!keepWorktree && !force) {
            const dirty = await probeDirtyWorktree(resolved.row)
            if (dirty !== null) {
                return c.json({
                    error: `The worktree has ${dirty} uncommitted change(s). Re-run with force=true to delete anyway.`,
                    code: 'worktree_dirty',
                    changedFiles: dirty
                }, 409)
            }
        }

        if (canceller) {
            const cancelled = await canceller.cancelTask(resolved.row.id, c.get('namespace'))
            if (cancelled.outcome === 'task-not-found') {
                return c.json({ error: 'Task not found' }, 404)
            }
        }

        // A deleted task can no longer expose its session controls. Retire the
        // attached session even when the stored run was already settled (for
        // example after a hub restart), or the agent can outlive the only UI
        // that knows how to stop it.
        const orchestrator = getTaskOrchestrator()
        const session = orchestrator ? await orchestrator.retireSession(resolved.row) : 'none'

        let worktree: WorktreeTeardownResult = { outcome: 'skipped', reason: 'no-worktree' }
        const service = getTaskWorktree()
        if (!keepWorktree && service) {
            worktree = await service.teardown(resolved.row, { force })

            // Probed clean above, but the agent may have written since. Every
            // other outcome leaves disk state behind at worst; this one would
            // destroy work the operator may not know exists, so it becomes a
            // question instead of an action.
            if (worktree.outcome === 'dirty') {
                return c.json({
                    error: `The worktree has ${worktree.changedFiles} uncommitted change(s). Re-run with force=true to delete anyway.`,
                    code: 'worktree_dirty',
                    changedFiles: worktree.changedFiles
                }, 409)
            }
        }

        const deleted = store.tasks.delete(resolved.row.id, c.get('namespace'))
        if (!deleted) {
            return c.json({ error: 'Task not found' }, 404)
        }

        // 200 rather than 204: the teardown outcome is worth reporting — a
        // branch kept because it was unmerged is something the operator needs
        // to know about, not something to swallow.
        return c.json({ deleted: true, worktree, session })
    })

    return app
}
