import { useState } from 'react'
import { ApiError, type ApiClient } from '@/api/client'
import type { TaskColumn } from '@hapi/protocol'
import { useTaskActions } from '@/hooks/mutations/useTaskActions'

export type ArchiveOptions = { force: boolean; stopRun: boolean; forceWorktree: boolean }
export type DeleteOptions = { force: boolean; stopRun: boolean }

/** Pull the `changedFiles` count out of a `worktree_dirty` 409 body. */
function readChangedFiles(error: unknown): number | null {
    if (!(error instanceof ApiError) || error.code !== 'worktree_dirty' || !error.body) return null
    try {
        const parsed = JSON.parse(error.body) as { changedFiles?: unknown }
        return typeof parsed.changedFiles === 'number' ? parsed.changedFiles : null
    } catch {
        return null
    }
}

/**
 * The task actions that end or undo a task's life, as every host runs them.
 *
 * Two contracts: a dirty worktree is refused once and overridden on the
 * second press, and an archive whose agent could not be stopped is announced,
 * because the task that pointed at it is gone.
 */
export function useTaskLifecycle(api: ApiClient | null) {
    const actions = useTaskActions(api)
    // Per-task count of uncommitted files, set when the hub refuses. Keyed by
    // task so one refusal does not arm the override on every task.
    const [dirtyWarnings, setDirtyWarnings] = useState<Record<string, number>>({})
    // Set when an archive succeeded but the agent behind it did not stop.
    const [orphanWarning, setOrphanWarning] = useState<string | null>(null)

    const clearDirty = (taskId: string) => {
        setDirtyWarnings((previous) => {
            if (!(taskId in previous)) return previous
            const next = { ...previous }
            delete next[taskId]
            return next
        })
    }

    const rememberDirty = (taskId: string, error: unknown) => {
        const changedFiles = readChangedFiles(error)
        if (changedFiles !== null) {
            setDirtyWarnings((previous) => ({ ...previous, [taskId]: changedFiles }))
        }
    }

    // `mutateAsync` rejects on failure. Every caller reports through
    // `actions.error` instead, so the rejection has to be absorbed - a bare
    // `void` would leave an unhandled rejection behind on every failed action.
    const run = (promise: Promise<unknown>) => {
        void promise.catch(() => {})
    }

    const archive = async (taskId: string, options: ArchiveOptions) => {
        try {
            const result = await actions.archiveTask({ taskId, ...options })
            clearDirty(taskId)
            // The runner could not reach the agent -- it keeps running, and the
            // task that pointed at it has just been hidden. Nothing else will
            // mention it again, so it gets said here.
            setOrphanWarning(result.session === 'still-alive' ? taskId : null)
        } catch (error) {
            // Archiving removes the checkout, so it hits the same refusal
            // deleting does, and earns the same second press.
            rememberDirty(taskId, error)
        }
    }

    /** Resolves true once the task is gone, so a panel showing it can close. */
    const remove = async (taskId: string, options: DeleteOptions): Promise<boolean> => {
        try {
            await actions.deleteTask({ taskId, ...options })
            clearDirty(taskId)
            return true
        } catch (error) {
            rememberDirty(taskId, error)
            return false
        }
    }

    /** Resolves true once saved, so an editor showing the draft can close. */
    const rename = async (taskId: string, title: string): Promise<boolean> => {
        try {
            await actions.updateTask({ taskId, patch: { title } })
            return true
        } catch {
            return false
        }
    }

    return {
        actions,
        run,
        dirtyWarnings,
        orphanWarning,
        dismissOrphanWarning: () => setOrphanWarning(null),
        start: (taskId: string) => run(actions.startTask(taskId)),
        cancel: (taskId: string) => run(actions.cancelTask(taskId)),
        move: (taskId: string, column: TaskColumn) => run(actions.moveTask({ taskId, column })),
        archive: (taskId: string, options: ArchiveOptions) => run(archive(taskId, options)),
        unarchive: (taskId: string) => run(actions.unarchiveTask(taskId)),
        remove,
        rename,
        openPullRequest: (taskId: string) => run(actions.openPullRequest({ taskId })),
        refreshPullRequest: (taskId: string) => run(actions.refreshPullRequest(taskId))
    }
}
