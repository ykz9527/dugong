import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import { encodeTaskError } from '@hapi/protocol'
import type { StoredTask, StoredTaskRun } from './types'
import { safeJsonParse } from './json'

/**
 * Task storage.
 *
 * Mental model: a Task is durable *intent* (prompt + where + how), a Session
 * is one *execution* of it, and a TaskRun is the record tying the two
 * together. The task list renders from `tasks` alone - every field it needs
 * (column, last run status, branch) is denormalised onto the row so the list
 * is one indexed query, not a join per task.
 *
 * This layer is deliberately mechanical: it owns row shape, `seq` bumps, and
 * the transactions that keep a task and its run in agreement. It does NOT
 * decide which column a task belongs in - that policy lives in the
 * orchestrator, which passes the column it wants down as a parameter.
 *
 * Namespace scoping matches `sessions`: every read and write that a route can
 * reach takes a `namespace` and filters on it. The by-id lookups that skip it
 * (`getTask`, `getTaskRun`) are for internal callers that have already
 * resolved ownership, same carve-out `getSession` has.
 */

type DbTaskRow = {
    id: string
    namespace: string
    title: string
    prompt: string
    column_id: string
    machine_id: string | null
    workdir: string
    isolation: string
    worktree_name: string | null
    base_ref: string | null
    branch: string | null
    worktree_path: string | null
    spawn_config: string
    current_session_id: string | null
    last_run_id: string | null
    last_run_status: string | null
    last_error: string | null
    pull_request: string | null
    archived_at: number | null
    created_at: number
    updated_at: number
    seq: number
}

type DbTaskRunRow = {
    id: string
    task_id: string
    session_id: string | null
    status: string
    origin: string
    base_ref: string | null
    base_commit: string | null
    branch: string | null
    worktree_path: string | null
    started_at: number
    ended_at: number | null
    error: string | null
}

function toStoredTask(row: DbTaskRow): StoredTask {
    return {
        id: row.id,
        namespace: row.namespace,
        title: row.title,
        prompt: row.prompt,
        column: row.column_id,
        machineId: row.machine_id,
        workdir: row.workdir,
        isolation: row.isolation,
        worktreeName: row.worktree_name,
        baseRef: row.base_ref,
        branch: row.branch,
        worktreePath: row.worktree_path,
        spawn: safeJsonParse(row.spawn_config),
        currentSessionId: row.current_session_id,
        lastRunId: row.last_run_id,
        lastRunStatus: row.last_run_status,
        lastError: row.last_error,
        pullRequest: safeJsonParse(row.pull_request),
        archivedAt: row.archived_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        seq: row.seq
    }
}

function toStoredTaskRun(row: DbTaskRunRow): StoredTaskRun {
    return {
        id: row.id,
        taskId: row.task_id,
        sessionId: row.session_id,
        status: row.status,
        origin: row.origin,
        baseRef: row.base_ref,
        baseCommit: row.base_commit,
        branch: row.branch,
        worktreePath: row.worktree_path,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        error: row.error
    }
}

export type CreateTaskInput = {
    namespace: string
    title: string
    prompt: string
    workdir: string
    /** Parsed `TaskSpawnConfig`. Validate with `TaskSpawnConfigSchema` at the
     *  route layer; this layer only serialises it. */
    spawn: unknown
    column?: string
    machineId?: string | null
    isolation?: string
    worktreeName?: string | null
    baseRef?: string | null
    /** Explicit id, for idempotent creates from a retrying client. */
    id?: string
    createdAt?: number
}

export function createTask(db: Database, input: CreateTaskInput): StoredTask {
    const now = Date.now()
    const id = input.id ?? randomUUID()
    const createdAt = input.createdAt ?? now

    db.prepare(`
        INSERT INTO tasks (
            id, namespace, title, prompt, column_id, machine_id, workdir,
            isolation, worktree_name, base_ref, branch, worktree_path,
            spawn_config, current_session_id,
            last_run_id, last_run_status, last_error,
            pull_request, archived_at, created_at, updated_at, seq
        ) VALUES (
            @id, @namespace, @title, @prompt, @column_id, @machine_id, @workdir,
            @isolation, @worktree_name, @base_ref, NULL, NULL,
            @spawn_config, NULL,
            NULL, NULL, NULL,
            NULL, NULL, @created_at, @updated_at, 0
        )
    `).run({
        id,
        namespace: input.namespace,
        title: input.title,
        prompt: input.prompt,
        column_id: input.column ?? 'backlog',
        machine_id: input.machineId ?? null,
        workdir: input.workdir,
        isolation: input.isolation ?? 'worktree',
        worktree_name: input.worktreeName ?? null,
        base_ref: input.baseRef ?? null,
        spawn_config: JSON.stringify(input.spawn ?? {}),
        created_at: createdAt,
        updated_at: now
    })

    const created = getTask(db, id)
    if (!created) {
        throw new Error(`Failed to read back task ${id} after insert`)
    }
    return created
}

export function getTask(db: Database, id: string): StoredTask | null {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as DbTaskRow | undefined
    return row ? toStoredTask(row) : null
}

export function getTaskByNamespace(db: Database, id: string, namespace: string): StoredTask | null {
    const row = db.prepare(
        'SELECT * FROM tasks WHERE id = ? AND namespace = ?'
    ).get(id, namespace) as DbTaskRow | undefined
    return row ? toStoredTask(row) : null
}

/** Reverse lookup for session-first surfaces: an open chat needs to know which
 *  task it belongs to so it can offer "move to review". Matches on the live
 *  pointer, so a task whose session already ended resolves to null. */
export function getTaskBySession(db: Database, sessionId: string): StoredTask | null {
    const row = db.prepare(
        'SELECT * FROM tasks WHERE current_session_id = ? LIMIT 1'
    ).get(sessionId) as DbTaskRow | undefined
    return row ? toStoredTask(row) : null
}

/**
 * Cards whose current session is named something other than the card.
 *
 * A card and the conversation it runs carry one name. These are the pairs
 * that drifted before that was kept, or while the hub was not there to keep it.
 */
export function listMisnamedTaskSessions(db: Database): Array<{ sessionId: string; title: string }> {
    return db.prepare(
        `SELECT t.current_session_id AS sessionId, t.title AS title
         FROM tasks t JOIN sessions s ON s.id = t.current_session_id
         WHERE json_extract(s.metadata, '$.name') IS NOT t.title`
    ).all() as Array<{ sessionId: string; title: string }>
}

export type ListTasksOptions = {
    column?: string
    machineId?: string
    /** Archived rows are hidden by default - the list shows live work. */
    includeArchived?: boolean
    limit?: number
}

export function listTasks(
    db: Database,
    namespace: string,
    options?: ListTasksOptions
): StoredTask[] {
    const clauses = ['namespace = @namespace']
    const params: Record<string, string | number> = { namespace }

    if (options?.column !== undefined) {
        clauses.push('column_id = @column_id')
        params.column_id = options.column
    }
    if (options?.machineId !== undefined) {
        clauses.push('machine_id = @machine_id')
        params.machine_id = options.machineId
    }
    if (!options?.includeArchived) {
        clauses.push('archived_at IS NULL')
    }

    const limitClause = options?.limit !== undefined ? ' LIMIT @limit' : ''
    if (options?.limit !== undefined) {
        params.limit = options.limit
    }

    const rows = db.prepare(
        `SELECT * FROM tasks
         WHERE ${clauses.join(' AND ')}
         ORDER BY updated_at DESC, id DESC${limitClause}`
    ).all(params) as DbTaskRow[]
    return rows.map(toStoredTask)
}

/** Per-column counts for the list headers. One grouped scan instead of six
 *  `listTasks` calls the UI would only need the length of. */
export function countTasksByColumn(db: Database, namespace: string): Record<string, number> {
    const rows = db.prepare(
        `SELECT column_id, COUNT(*) AS n
         FROM tasks
         WHERE namespace = ? AND archived_at IS NULL
         GROUP BY column_id`
    ).all(namespace) as Array<{ column_id: string; n: number }>

    const counts: Record<string, number> = {}
    for (const row of rows) {
        counts[row.column_id] = row.n
    }
    return counts
}

/**
 * Fields a caller may patch, mapped to their SQL columns. Anything not listed
 * here is owned by the run lifecycle (`last_run_*`, `current_session_id`) or
 * immutable (`id`, `namespace`, `created_at`) and has its own entry point.
 * The map doubles as the injection guard - column names never come from
 * caller-supplied strings.
 */
const PATCHABLE_COLUMNS = {
    title: 'title',
    prompt: 'prompt',
    column: 'column_id',
    machineId: 'machine_id',
    workdir: 'workdir',
    isolation: 'isolation',
    worktreeName: 'worktree_name',
    baseRef: 'base_ref',
    branch: 'branch',
    worktreePath: 'worktree_path'
} as const

export type TaskPatch = Partial<{
    title: string
    prompt: string
    column: string
    machineId: string | null
    workdir: string
    isolation: string
    worktreeName: string | null
    baseRef: string | null
    branch: string | null
    worktreePath: string | null
    /** Replaced wholesale, not merged - a spawn config is a unit. */
    spawn: unknown
}>

export function updateTask(
    db: Database,
    id: string,
    namespace: string,
    patch: TaskPatch
): StoredTask | null {
    const setClauses: string[] = []
    const params: Record<string, string | number | null> = { id, namespace, updated_at: Date.now() }

    for (const [key, column] of Object.entries(PATCHABLE_COLUMNS)) {
        // Every patchable field is `string | null` (see PATCHABLE_COLUMNS);
        // `spawn` is the one non-string field and is handled separately below.
        const value = patch[key as keyof typeof PATCHABLE_COLUMNS] as string | null | undefined
        if (value === undefined) continue
        setClauses.push(`${column} = @${column}`)
        params[column] = value
    }

    if (patch.spawn !== undefined) {
        setClauses.push('spawn_config = @spawn_config')
        params.spawn_config = JSON.stringify(patch.spawn)
    }

    if (setClauses.length === 0) {
        return getTaskByNamespace(db, id, namespace)
    }

    const result = db.prepare(`
        UPDATE tasks
        SET ${setClauses.join(', ')},
            updated_at = @updated_at,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace
    `).run(params)

    return result.changes === 1 ? getTaskByNamespace(db, id, namespace) : null
}

/** Column moves are frequent enough (operator, orchestrator) to deserve
 *  their own entry point rather than a `{ column }` patch at every call site. */
export function moveTask(
    db: Database,
    id: string,
    namespace: string,
    column: string
): StoredTask | null {
    return updateTask(db, id, namespace, { column })
}

export function archiveTask(db: Database, id: string, namespace: string): StoredTask | null {
    const now = Date.now()
    const result = db.prepare(`
        UPDATE tasks
        SET archived_at = @archived_at,
            updated_at = @updated_at,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace AND archived_at IS NULL
    `).run({ id, namespace, archived_at: now, updated_at: now })

    return result.changes === 1 ? getTaskByNamespace(db, id, namespace) : null
}

export function unarchiveTask(db: Database, id: string, namespace: string): StoredTask | null {
    const now = Date.now()
    const result = db.prepare(`
        UPDATE tasks
        SET archived_at = NULL,
            updated_at = @updated_at,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace AND archived_at IS NOT NULL
    `).run({ id, namespace, updated_at: now })

    return result.changes === 1 ? getTaskByNamespace(db, id, namespace) : null
}

/**
 * What `sessions.task_id` holds once the task that owned the session is
 * deleted. Not a task id, so nothing resolves through it; it only has to be
 * non-NULL so the session is never adopted as a task again.
 */
export const DELETED_TASK_MARKER = 'deleted'

/**
 * Delete a task and its run history (`task_runs` cascades). Sessions the task
 * spawned are deliberately left behind - their chat history outlives the task.
 * The task's schedule and its slots go with it (`ON DELETE CASCADE`).
 * Callers that also want the worktree gone must tear it down first; this layer
 * does not touch the filesystem.
 */
export function deleteTask(db: Database, id: string, namespace: string): boolean {
    return db.transaction(() => {
        const owned = db.prepare(
            'SELECT 1 AS ok FROM tasks WHERE id = ? AND namespace = ?'
        ).get(id, namespace) as { ok: number } | undefined
        if (!owned) return false

        // Tombstoned rather than cleared: an unlinked session with a transcript
        // is adopted as a task on sight, so NULL here would bring the task the
        // operator just deleted straight back.
        db.prepare('UPDATE sessions SET task_id = ? WHERE task_id = ?').run(DELETED_TASK_MARKER, id)
        const result = db.prepare('DELETE FROM tasks WHERE id = ? AND namespace = ?').run(id, namespace)
        // `changes` counts cascaded `task_runs` deletes too, so this is `> 0`
        // rather than the `=== 1` the UPDATE paths use. Ownership was already
        // established by the SELECT above.
        return result.changes > 0
    })()
}

/**
 * Follow a session that was merged into another one.
 *
 * Resuming an agent does not reopen its session row — the CLI reports a *new*
 * id and the hub folds the old row into it, transcript and all. Every other
 * owner of that id is moved across first (messages, usage, scratchlist, the
 * notify chain); tasks were not, so a task whose conversation was resumed
 * anywhere else lost its session pointer the moment the old row was deleted
 * (`tasks.current_session_id` is `ON DELETE SET NULL`). The task then offered
 * `Start`, which resumed the same transcript a second time — one task, two
 * agents on one conversation.
 *
 * All four places that name a session are rewritten, and the caller must do it
 * *before* the delete, while the old id is still the one on the rows.
 * Returns the tasks that moved, so the caller can announce them.
 */
export function reassignTaskSession(db: Database, oldSessionId: string, newSessionId: string): string[] {
    if (oldSessionId === newSessionId) return []

    return db.transaction((): string[] => {
        const affected = db.prepare(
            `SELECT DISTINCT id FROM (
                 SELECT id FROM tasks WHERE current_session_id = @old
                 UNION
                 SELECT id FROM tasks WHERE json_extract(spawn_config, '$.adoptedSessionId') = @old
                 UNION
                 SELECT task_id AS id FROM task_runs WHERE session_id = @old
             )`
        ).all({ old: oldSessionId }) as Array<{ id: string }>
        if (affected.length === 0) return []

        db.prepare('UPDATE task_runs SET session_id = @new WHERE session_id = @old')
            .run({ old: oldSessionId, new: newSessionId })
        db.prepare(
            `UPDATE tasks
             SET current_session_id = @new, updated_at = @updated_at, seq = seq + 1
             WHERE current_session_id = @old`
        ).run({ old: oldSessionId, new: newSessionId, updated_at: Date.now() })
        // An adopted task resumes by native id, but it still names the row it
        // was taken over from — left dangling it points at a session nobody
        // can open.
        db.prepare(
            `UPDATE tasks
             SET spawn_config = json_set(spawn_config, '$.adoptedSessionId', @new)
             WHERE json_extract(spawn_config, '$.adoptedSessionId') = @old`
        ).run({ old: oldSessionId, new: newSessionId })
        // The back-pointer only moves onto a session that is not already
        // claimed: the merge target may well be a task's own session already.
        db.prepare(
            `UPDATE sessions
             SET task_id = (SELECT task_id FROM sessions WHERE id = @old)
             WHERE id = @new AND task_id IS NULL`
        ).run({ old: oldSessionId, new: newSessionId })

        return affected.map((row) => row.id)
    })()
}

/**
 * Store (or clear) the cached pull request for a task.
 *
 * Kept out of `TaskPatch` on purpose: a PR snapshot is written by the forge
 * sync path, never by an operator editing a task, and mixing the two would let
 * a stale client PATCH overwrite a fresher refresh.
 */
export function setTaskPullRequest(
    db: Database,
    id: string,
    namespace: string,
    pullRequest: unknown | null
): StoredTask | null {
    const result = db.prepare(`
        UPDATE tasks
        SET pull_request = @pull_request,
            updated_at = @updated_at,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace
    `).run({
        id,
        namespace,
        pull_request: pullRequest === null ? null : JSON.stringify(pullRequest),
        updated_at: Date.now()
    })

    return result.changes === 1 ? getTaskByNamespace(db, id, namespace) : null
}

// --- Runs -------------------------------------------------------------

export type StartTaskRunInput = {
    taskId: string
    namespace: string
    origin: string
    sessionId?: string | null
    baseRef?: string | null
    baseCommit?: string | null
    branch?: string | null
    worktreePath?: string | null
    /** Column to put the task in as the run starts. Defaults to `running`;
     *  pass an explicit value when the orchestrator wants something else. */
    column?: string
    id?: string
    startedAt?: number
}

export type StartTaskRunResult =
    | { outcome: 'started'; run: StoredTaskRun; task: StoredTask }
    | { outcome: 'task-not-found' }
    | { outcome: 'already-running'; run: StoredTaskRun }

/**
 * Open a run and flip the task to match, atomically.
 *
 * The `already-running` guard is what keeps a double-clicked Start from
 * spawning two agents against one worktree. It is enforced here rather than in
 * the orchestrator because only a transaction can make the check and the
 * insert indivisible.
 *
 * `baseRef` defaults to the task's pinned ref so re-runs inherit the same
 * starting point without every caller remembering to copy it.
 */
export function startTaskRun(db: Database, input: StartTaskRunInput): StartTaskRunResult {
    return db.transaction((): StartTaskRunResult => {
        const task = getTaskByNamespace(db, input.taskId, input.namespace)
        if (!task) return { outcome: 'task-not-found' }

        const active = getActiveTaskRun(db, input.taskId)
        if (active) return { outcome: 'already-running', run: active }

        const now = Date.now()
        const startedAt = input.startedAt ?? now
        const id = input.id ?? randomUUID()

        db.prepare(`
            INSERT INTO task_runs (
                id, task_id, session_id, status, origin,
                base_ref, base_commit, branch, worktree_path,
                started_at, ended_at, error
            ) VALUES (
                @id, @task_id, @session_id, 'running', @origin,
                @base_ref, @base_commit, @branch, @worktree_path,
                @started_at, NULL, NULL
            )
        `).run({
            id,
            task_id: input.taskId,
            session_id: input.sessionId ?? null,
            origin: input.origin,
            base_ref: input.baseRef ?? task.baseRef,
            base_commit: input.baseCommit ?? null,
            branch: input.branch ?? null,
            worktree_path: input.worktreePath ?? null,
            started_at: startedAt
        })

        db.prepare(`
            UPDATE tasks
            SET column_id = @column_id,
                last_run_id = @last_run_id,
                last_run_status = 'running',
                last_error = NULL,
                current_session_id = COALESCE(@session_id, current_session_id),
                branch = COALESCE(@branch, branch),
                worktree_path = COALESCE(@worktree_path, worktree_path),
                updated_at = @updated_at,
                seq = seq + 1
            WHERE id = @id AND namespace = @namespace
        `).run({
            id: input.taskId,
            namespace: input.namespace,
            column_id: input.column ?? 'running',
            last_run_id: id,
            session_id: input.sessionId ?? null,
            branch: input.branch ?? null,
            worktree_path: input.worktreePath ?? null,
            updated_at: now
        })

        if (input.sessionId) {
            db.prepare('UPDATE sessions SET task_id = ? WHERE id = ?').run(input.taskId, input.sessionId)
        }

        const run = getTaskRun(db, id)
        const updated = getTaskByNamespace(db, input.taskId, input.namespace)
        if (!run || !updated) {
            throw new Error(`Failed to read back run ${id} after insert`)
        }
        return { outcome: 'started', run, task: updated }
    })()
}

/**
 * Bind a spawned session to an in-flight run. Spawn is asynchronous, so a run
 * usually opens with `sessionId: null` and gets it back a moment later; this
 * writes the id to all three places that need it (run, task pointer, session
 * back-pointer) in one transaction.
 */
export function attachRunSession(db: Database, runId: string, sessionId: string): StoredTaskRun | null {
    return db.transaction((): StoredTaskRun | null => {
        const run = getTaskRun(db, runId)
        if (!run) return null

        db.prepare('UPDATE task_runs SET session_id = ? WHERE id = ?').run(sessionId, runId)
        db.prepare(`
            UPDATE tasks
            SET current_session_id = @session_id,
                updated_at = @updated_at,
                seq = seq + 1
            WHERE id = @task_id
        `).run({ session_id: sessionId, task_id: run.taskId, updated_at: Date.now() })
        db.prepare('UPDATE sessions SET task_id = ? WHERE id = ?').run(run.taskId, sessionId)

        return getTaskRun(db, runId)
    })()
}

export type FinishTaskRunInput = {
    status: string
    error?: string | null
    endedAt?: number
    /** Column the task lands in. Omit to leave the column untouched - useful
     *  when the operator has already moved the task somewhere. */
    column?: string
    /** Clear the live session pointer (a finished run whose session is gone).
     *  Run history keeps its own copy either way. */
    clearSession?: boolean
}

export type FinishTaskRunResult =
    | { outcome: 'finished'; run: StoredTaskRun; task: StoredTask | null }
    | { outcome: 'run-not-found' }
    | { outcome: 'already-finished'; run: StoredTaskRun }

export function finishTaskRun(
    db: Database,
    runId: string,
    input: FinishTaskRunInput
): FinishTaskRunResult {
    return db.transaction((): FinishTaskRunResult => {
        const run = getTaskRun(db, runId)
        if (!run) return { outcome: 'run-not-found' }
        if (run.status !== 'running') return { outcome: 'already-finished', run }

        const now = Date.now()
        db.prepare(`
            UPDATE task_runs
            SET status = @status,
                ended_at = @ended_at,
                error = @error
            WHERE id = @id
        `).run({
            id: runId,
            status: input.status,
            ended_at: input.endedAt ?? now,
            error: input.error ?? null
        })

        // Only the *latest* run gets to write the task's denormalised status.
        // A late-settling older run must not overwrite a newer one's outcome.
        //
        // A card the operator put in Done stays there. Moving a card does not
        // end its run -- a Claude Code session lives on after its turn, so a
        // finished card routinely has a `running` run behind it -- and when
        // that run settled later (a cancel, the agent being killed) the
        // finished-run column used to drag the card from Done back to Ready.
        db.prepare(`
            UPDATE tasks
            SET last_run_status = @status,
                last_error = @error,
                column_id = CASE WHEN column_id = 'done' THEN column_id ELSE COALESCE(@column_id, column_id) END,
                current_session_id = CASE WHEN @clear_session = 1 THEN NULL ELSE current_session_id END,
                updated_at = @updated_at,
                seq = seq + 1
            WHERE id = @task_id AND last_run_id = @run_id
        `).run({
            task_id: run.taskId,
            run_id: runId,
            status: input.status,
            error: input.error ?? null,
            column_id: input.column ?? null,
            clear_session: input.clearSession ? 1 : 0,
            updated_at: now
        })

        const settled = getTaskRun(db, runId)
        if (!settled) {
            throw new Error(`Failed to read back run ${runId} after settle`)
        }
        return { outcome: 'finished', run: settled, task: getTask(db, run.taskId) }
    })()
}

/**
 * Record the worktree a run's session came up in. Only fills blanks: a run
 * has one worktree for its whole life, and the runner reports it once the
 * session's metadata lands — usually after the spawn call has returned.
 */
export function setTaskRunWorktree(
    db: Database,
    runId: string,
    worktree: { branch?: string | null; worktreePath?: string | null }
): void {
    db.prepare(`
        UPDATE task_runs
        SET branch = COALESCE(branch, @branch),
            worktree_path = COALESCE(worktree_path, @worktree_path)
        WHERE id = @id
    `).run({ id: runId, branch: worktree.branch ?? null, worktree_path: worktree.worktreePath ?? null })
}

export function getTaskRun(db: Database, id: string): StoredTaskRun | null {
    const row = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as DbTaskRunRow | undefined
    return row ? toStoredTaskRun(row) : null
}

export function getActiveTaskRun(db: Database, taskId: string): StoredTaskRun | null {
    const row = db.prepare(
        `SELECT * FROM task_runs
         WHERE task_id = ? AND status = 'running'
         ORDER BY started_at DESC, rowid DESC
         LIMIT 1`
    ).get(taskId) as DbTaskRunRow | undefined
    return row ? toStoredTaskRun(row) : null
}

/**
 * Find the in-flight run for a session.
 *
 * This is the reliable direction for session-driven lookups: `tasks.
 * current_session_id` is an FK with `ON DELETE SET NULL`, so by the time a
 * `session-removed` event is handled the pointer is already gone. `task_runs`
 * has no FK precisely so this reverse lookup still works.
 */
export function getActiveTaskRunBySession(db: Database, sessionId: string): StoredTaskRun | null {
    const row = db.prepare(
        `SELECT * FROM task_runs
         WHERE session_id = ? AND status = 'running'
         ORDER BY started_at DESC, rowid DESC
         LIMIT 1`
    ).get(sessionId) as DbTaskRunRow | undefined
    return row ? toStoredTaskRun(row) : null
}

/**
 * Run history, newest first.
 *
 * Ties on `started_at` break on `rowid`, not on `id`: cancel-then-restart
 * lands both runs in the same millisecond, and a random UUID would order them
 * arbitrarily — sometimes showing the older run as the newer one. `rowid` is
 * insertion order. (Valid as long as `task_runs` is not WITHOUT ROWID.)
 */
export function listTaskRuns(db: Database, taskId: string, limit?: number): StoredTaskRun[] {
    const limitClause = limit !== undefined ? ' LIMIT @limit' : ''
    const params: Record<string, string | number> = { task_id: taskId }
    if (limit !== undefined) {
        params.limit = limit
    }

    const rows = db.prepare(
        `SELECT * FROM task_runs
         WHERE task_id = @task_id
         ORDER BY started_at DESC, rowid DESC${limitClause}`
    ).all(params) as DbTaskRunRow[]
    return rows.map(toStoredTaskRun)
}

export type ReconcileOrphanedRunsResult = {
    /** Run ids flipped to `orphaned`. */
    runIds: string[]
    /** Tasks whose denormalised state changed - the orchestrator broadcasts these. */
    taskIds: string[]
}

/**
 * Every run still marked `running`, with the session it was attached to.
 *
 * Exists for the reattach sweep, which cannot decide liveness in SQL: the
 * `sessions.active` column is only ever written *false* (on session-end and on
 * keep-alive expiry) — a live session's `active = true` lives in the sync
 * engine's memory and never reaches the row. So the caller pairs this list
 * with what the engine actually knows and hands back the runs to settle.
 */
export function listRunningTaskRuns(db: Database): Array<{ runId: string; sessionId: string | null }> {
    const rows = db.prepare(
        "SELECT id, session_id FROM task_runs WHERE status = 'running'"
    ).all() as Array<{ id: string; session_id: string | null }>
    return rows.map((row) => ({ runId: row.id, sessionId: row.session_id }))
}

/**
 * Boot reconciliation: settle runs whose agent is provably gone.
 *
 * Deliberately narrow. A CLI outlives the hub — that is the whole point of the
 * split — so a hub restart alone does NOT mean the work stopped. Sweeping every
 * `running` row would settle runs whose agent is still working, and the next
 * Start would spawn a second agent beside the first: one task, two live
 * sessions, two worktrees.
 *
 * So only runs whose session is already inactive (or gone entirely) are
 * settled here. Runs whose session is still alive stay running; if that session
 * later goes quiet, the orchestrator settles it from the session event instead.
 */
export function reconcileOrphanedTaskRuns(
    db: Database,
    options?: {
        machineId?: string
        namespace?: string
        column?: string
        error?: string
        /**
         * Skip runs whose session row still exists but is merely inactive —
         * the ones a reconnecting CLI can still claim. Used for the sweep the
         * hub runs the instant it boots, before any agent has had a chance to
         * report in. See `REATTACH_WINDOW_MS` in the orchestrator.
         */
        sessionGoneOnly?: boolean
        /**
         * Restrict the sweep to these runs. The reattach sweep uses it to
         * settle exactly the runs it decided were unreclaimable, having asked
         * the sync engine rather than the `sessions` table. An empty array
         * sweeps nothing.
         */
        runIds?: readonly string[]
    }
): ReconcileOrphanedRunsResult {
    return db.transaction((): ReconcileOrphanedRunsResult => {
        const clauses = ["r.status = 'running'"]
        const params: Record<string, string> = {}

        if (options?.machineId !== undefined) {
            clauses.push('t.machine_id = @machine_id')
            params.machine_id = options.machineId
        }
        if (options?.namespace !== undefined) {
            clauses.push('t.namespace = @namespace')
            params.namespace = options.namespace
        }
        if (options?.runIds !== undefined) {
            if (options.runIds.length === 0) return { runIds: [], taskIds: [] }
            const names = options.runIds.map((runId, index) => {
                params[`run_${index}`] = runId
                return `@run_${index}`
            })
            clauses.push(`r.id IN (${names.join(', ')})`)
        }

        // `s.active IS NULL` covers a run whose session row is gone, and a run
        // that never got one (spawn died before the link was made). Neither can
        // ever come back, so both are swept even under `sessionGoneOnly`. The
        // third case — a session row that is merely inactive — is the one a
        // reconnecting CLI can still claim, so it is held back when asked.
        clauses.push(options?.sessionGoneOnly
            ? '(r.session_id IS NULL OR s.active IS NULL)'
            : '(r.session_id IS NULL OR s.active IS NULL OR s.active = 0)')

        const stale = db.prepare(
            `SELECT r.id AS run_id, r.task_id AS task_id
             FROM task_runs r
             JOIN tasks t ON t.id = r.task_id
             LEFT JOIN sessions s ON s.id = r.session_id
             WHERE ${clauses.join(' AND ')}`
        ).all(params) as Array<{ run_id: string; task_id: string }>

        if (stale.length === 0) {
            return { runIds: [], taskIds: [] }
        }

        const now = Date.now()
        const error = options?.error ?? encodeTaskError('run.interrupted')
        const column = options?.column ?? 'ready'
        const taskIds = new Set<string>()

        const settleRun = db.prepare(
            "UPDATE task_runs SET status = 'orphaned', ended_at = @ended_at, error = @error WHERE id = @id"
        )
        // The column only moves for a task still sitting in `running`. A run
        // row can stay `running` long after the task left that column — a
        // Claude Code session does not exit when its turn ends, so a task in
        // review routinely has a `running` run behind it. Without the guard,
        // every hub restart dragged every task in review back to `ready` and
        // threw away work the operator had not looked at yet.
        //
        // `current_session_id` is deliberately left alone. Of the three ways a
        // run lands in this sweep, two — no session, session row gone — have
        // nothing to clear (the FK already fired for the second). The third,
        // `s.active = 0`, is the common one after a hub restart: the session
        // row and its whole transcript are still there, the agent just went
        // quiet. Nulling the pointer there took away the task's only route
        // into the chat and left it with no history and no way to resume.
        // `startTask` retires a stale session before it spawns, so a surviving
        // pointer cannot produce two live sessions on one task.
        const settleTask = db.prepare(`
            UPDATE tasks
            SET last_run_status = 'orphaned',
                last_error = @error,
                column_id = CASE WHEN column_id = 'running' THEN @column_id ELSE column_id END,
                updated_at = @updated_at,
                seq = seq + 1
            WHERE id = @task_id AND last_run_id = @run_id
        `)

        for (const row of stale) {
            settleRun.run({ id: row.run_id, ended_at: now, error })
            const changed = settleTask.run({
                task_id: row.task_id,
                run_id: row.run_id,
                error,
                column_id: column,
                updated_at: now
            })
            if (changed.changes === 1) {
                taskIds.add(row.task_id)
            }
        }

        return { runIds: stale.map((row) => row.run_id), taskIds: [...taskIds] }
    })()
}

/**
 * Whether any task already names this session: the back-pointer, a run, or a
 * task's live pointer. All three are checked because they are written at
 * different moments — a task spawn opens its run before the session exists
 * and links it afterwards.
 */
export function isSessionOnBoard(db: Database, sessionId: string): boolean {
    const row = db.prepare(
        `SELECT 1 AS ok FROM sessions WHERE id = @id AND task_id IS NOT NULL
         UNION ALL SELECT 1 FROM task_runs WHERE session_id = @id
         UNION ALL SELECT 1 FROM tasks WHERE current_session_id = @id
         LIMIT 1`
    ).get({ id: sessionId }) as { ok: number } | undefined
    return Boolean(row)
}

/**
 * Sessions with a transcript that no task owns, oldest first so tasks are
 * created in the order the conversations happened. An empty row is left out:
 * it is a spawn that never got as far as a message, and a task for it would
 * be a task about nothing.
 */
export function listOffBoardSessionIds(db: Database): string[] {
    const rows = db.prepare(
        `SELECT s.id FROM sessions s
         WHERE s.task_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM task_runs r WHERE r.session_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.current_session_id = s.id)
           AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
         ORDER BY s.created_at ASC`
    ).all() as Array<{ id: string }>
    return rows.map((row) => row.id)
}

/**
 * Whether another session row in the same namespace carries the same native
 * conversation id.
 *
 * Without `onBoardOnly` any sibling counts: for a live session that is a resume
 * or dedupe the session cache has not folded together yet. With it, only a
 * sibling some task already owns counts — the conversation already has a task
 * under another row. Another namespace's rows never count: the same native id
 * there is someone else's copy, and must not hide this one.
 */
export function hasNativeSessionSibling(
    db: Database,
    sessionId: string,
    nativeSessionId: string,
    namespace: string,
    options?: { onBoardOnly?: boolean }
): boolean {
    const boardClause = options?.onBoardOnly
        ? `AND (s.task_id IS NOT NULL
                OR EXISTS (SELECT 1 FROM task_runs r WHERE r.session_id = s.id)
                OR EXISTS (SELECT 1 FROM tasks t WHERE t.current_session_id = s.id))`
        : ''
    const row = db.prepare(
        `SELECT 1 AS ok FROM sessions s
         WHERE s.id != @id
           AND s.namespace = @namespace
           AND (json_extract(s.metadata, '$.claudeSessionId') = @native
                OR json_extract(s.metadata, '$.codexSessionId') = @native)
           ${boardClause}
         LIMIT 1`
    ).get({ id: sessionId, native: nativeSessionId, namespace }) as { ok: number } | undefined
    return Boolean(row)
}
