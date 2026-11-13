import type { Database } from 'bun:sqlite'

import type { StoredTask, StoredTaskRun } from './types'
import {
    archiveTask,
    attachRunSession,
    countTasksByColumn,
    createTask,
    deleteTask,
    finishTaskRun,
    getActiveTaskRun,
    getActiveTaskRunBySession,
    getTask,
    getTaskByNamespace,
    getTaskBySession,
    getTaskRun,
    hasNativeSessionSibling,
    isSessionOnBoard,
    listOffBoardSessionIds,
    listTaskRuns,
    listTasks,
    moveTask,
    reassignTaskSession,
    reconcileOrphanedTaskRuns,
    setTaskPullRequest,
    setTaskRunWorktree,
    startTaskRun,
    unarchiveTask,
    updateTask,
    type CreateTaskInput,
    type FinishTaskRunInput,
    type FinishTaskRunResult,
    type ListTasksOptions,
    type ReconcileOrphanedRunsResult,
    type StartTaskRunInput,
    type StartTaskRunResult,
    type TaskPatch,
    listRunningTaskRuns
} from './tasks'

export class TaskStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    create(input: CreateTaskInput): StoredTask {
        return createTask(this.db, input)
    }

    get(id: string): StoredTask | null {
        return getTask(this.db, id)
    }

    getByNamespace(id: string, namespace: string): StoredTask | null {
        return getTaskByNamespace(this.db, id, namespace)
    }

    getBySession(sessionId: string): StoredTask | null {
        return getTaskBySession(this.db, sessionId)
    }

    list(namespace: string, options?: ListTasksOptions): StoredTask[] {
        return listTasks(this.db, namespace, options)
    }

    countByColumn(namespace: string): Record<string, number> {
        return countTasksByColumn(this.db, namespace)
    }

    update(id: string, namespace: string, patch: TaskPatch): StoredTask | null {
        return updateTask(this.db, id, namespace, patch)
    }

    move(id: string, namespace: string, column: string): StoredTask | null {
        return moveTask(this.db, id, namespace, column)
    }

    archive(id: string, namespace: string): StoredTask | null {
        return archiveTask(this.db, id, namespace)
    }

    unarchive(id: string, namespace: string): StoredTask | null {
        return unarchiveTask(this.db, id, namespace)
    }

    /** Drops the task and its run history. Worktree teardown is the caller's
     *  job — see `deleteTask` for why this layer stays off the filesystem. */
    delete(id: string, namespace: string): boolean {
        return deleteTask(this.db, id, namespace)
    }

    /** Write the cached forge pull request; pass null to forget it. */
    setPullRequest(id: string, namespace: string, pullRequest: unknown | null): StoredTask | null {
        return setTaskPullRequest(this.db, id, namespace, pullRequest)
    }

    /** Follow a session merged into another id — see `reassignTaskSession`.
     *  Returns the tasks that moved. */
    reassignSession(oldSessionId: string, newSessionId: string): string[] {
        return reassignTaskSession(this.db, oldSessionId, newSessionId)
    }

    startRun(input: StartTaskRunInput): StartTaskRunResult {
        return startTaskRun(this.db, input)
    }

    attachRunSession(runId: string, sessionId: string): StoredTaskRun | null {
        return attachRunSession(this.db, runId, sessionId)
    }

    finishRun(runId: string, input: FinishTaskRunInput): FinishTaskRunResult {
        return finishTaskRun(this.db, runId, input)
    }

    setRunWorktree(runId: string, worktree: { branch?: string | null; worktreePath?: string | null }): void {
        setTaskRunWorktree(this.db, runId, worktree)
    }

    getRun(id: string): StoredTaskRun | null {
        return getTaskRun(this.db, id)
    }

    getActiveRun(taskId: string): StoredTaskRun | null {
        return getActiveTaskRun(this.db, taskId)
    }

    /** Reverse lookup that survives session deletion — see
     *  `getActiveTaskRunBySession` for why the task pointer cannot be used. */
    getActiveRunBySession(sessionId: string): StoredTaskRun | null {
        return getActiveTaskRunBySession(this.db, sessionId)
    }

    listRuns(taskId: string, limit?: number): StoredTaskRun[] {
        return listTaskRuns(this.db, taskId, limit)
    }

    /** Every run still marked `running`, with its session. For the reattach
     *  sweep, which decides liveness outside SQL. */
    listRunningRuns(): Array<{ runId: string; sessionId: string | null }> {
        return listRunningTaskRuns(this.db)
    }

    /** See `isSessionOnBoard`. */
    isSessionOnBoard(sessionId: string): boolean {
        return isSessionOnBoard(this.db, sessionId)
    }

    /** See `listOffBoardSessionIds`. */
    listOffBoardSessionIds(): string[] {
        return listOffBoardSessionIds(this.db)
    }

    /** See `hasNativeSessionSibling`. */
    hasNativeSessionSibling(
        sessionId: string,
        nativeSessionId: string,
        namespace: string,
        options?: { onBoardOnly?: boolean }
    ): boolean {
        return hasNativeSessionSibling(this.db, sessionId, nativeSessionId, namespace, options)
    }

    /** Boot / runner-reconnect sweep for stuck `running` rows. */
    reconcileOrphanedRuns(
        options?: {
            machineId?: string
            namespace?: string
            column?: string
            error?: string
            sessionGoneOnly?: boolean
            runIds?: readonly string[]
        }
    ): ReconcileOrphanedRunsResult {
        return reconcileOrphanedTaskRuns(this.db, options)
    }
}
