import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { CreateTaskRequest, TaskDetailResponse, TaskListResponse, UpdateTaskRequest } from '@hapi/protocol/apiTypes'
import { getFlavorLabel, type PermissionMode, type Task, type TaskColumn } from '@hapi/protocol'
import { readableError, type ApiClient, type CreateTaskResponse, type TaskArchiveResponse } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

/**
 * Task mutations.
 *
 * Every write ends in an invalidation of the `tasks` prefix, which covers all
 * filtered list variants at once. `move` additionally patches the cache up
 * front, so a row's status select shows the new column without waiting a
 * round-trip; a failed move puts every list back.
 */

function patchTaskInLists(queryClient: QueryClient, taskId: string, patch: Partial<Task>): void {
    // `queryKeys.tasks` would also match `task(id)` detail entries, whose data is
    // `{ task, runs }` — reaching for `.tasks` on those throws and silently kills
    // the mutation. Scope to the list prefix, and still guard the shape.
    queryClient.setQueriesData<TaskListResponse>({ queryKey: queryKeys.taskLists }, (previous) => {
        if (!previous || !Array.isArray(previous.tasks)) return previous
        let changed = false
        const tasks = previous.tasks.map((task) => {
            if (task.id !== taskId) return task
            changed = true
            return { ...task, ...patch }
        })
        return changed ? { ...previous, tasks } : previous
    })
}

/** A session started outside dugong, to be taken over by a new task. */
export type AdoptTaskInput = {
    flavor: 'claude' | 'codex'
    /** The agent's own id for the conversation. */
    nativeSessionId: string
    machineId: string
    title?: string
    permissionMode?: PermissionMode
    /** Claude only: the operator confirmed a possibly-open session is closed. */
    force?: boolean
}

/** Write the native transcript into a HAPI session; returns that session's id.
 *  `failed` is the message for an import that gave no reason. */
async function importAdoptedSession(api: ApiClient, input: AdoptTaskInput, failed: string): Promise<string> {
    if (input.flavor === 'codex') {
        const imported = await api.syncCodexSession({
            sessionIds: [input.nativeSessionId],
            machineId: input.machineId,
            yolo: input.permissionMode === 'yolo'
        })
        const hapiSessionId = imported.success ? imported.hapiSessionIds?.[0] : undefined
        if (!hapiSessionId) {
            throw new Error(imported.error ?? failed)
        }
        return hapiSessionId
    }
    const imported = await api.importClaudeSessions({
        sessionIds: [input.nativeSessionId],
        machineId: input.machineId,
        permissionMode: input.permissionMode,
        force: input.force
    })
    const result = imported.results[0]
    if (!result?.hapiSessionId) {
        throw new Error(result?.error?.message ?? imported.error ?? failed)
    }
    return result.hapiSessionId
}

export function useTaskActions(api: ApiClient | null): {
    createTask: (input: CreateTaskRequest) => Promise<CreateTaskResponse>
    adoptTask: (input: AdoptTaskInput) => Promise<{ task: Task }>
    updateTask: (input: { taskId: string; patch: UpdateTaskRequest }) => Promise<{ task: Task }>
    moveTask: (input: { taskId: string; column: TaskColumn }) => Promise<{ task: Task }>
    startTask: (taskId: string) => Promise<unknown>
    cancelTask: (taskId: string) => Promise<unknown>
    archiveTask: (input: {
        taskId: string
        force?: boolean
        stopRun?: boolean
        keepWorktree?: boolean
        forceWorktree?: boolean
    }) => Promise<TaskArchiveResponse>
    unarchiveTask: (taskId: string) => Promise<unknown>
    deleteTask: (input: { taskId: string; force?: boolean; stopRun?: boolean }) => Promise<unknown>
    openPullRequest: (input: { taskId: string; baseBranch?: string; draft?: boolean }) => Promise<unknown>
    refreshPullRequest: (taskId: string) => Promise<unknown>
    isPending: boolean
    error: string | null
    /** Forget the last failure, e.g. when a dialog that shows it opens again. */
    reset: () => void
} {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasks })
    }

    const requireApi = (): ApiClient => {
        if (!api) throw new Error('API unavailable')
        return api
    }

    const createTask = useMutation({
        mutationFn: async (input: CreateTaskRequest) => await requireApi().createTask(input),
        onSuccess: invalidate,
    })

    /**
     * Take over a Claude or Codex session dugong never spawned.
     *
     * Two calls, one operator action: the import writes the native transcript
     * into a HAPI session, and only then can a task point at it. They are kept
     * together here so a failed import never leaves a task referencing a
     * session that does not exist.
     */
    const adoptTask = useMutation({
        mutationFn: async (input: AdoptTaskInput) => {
            const failed = t('board.adopt.importFailed', { agent: getFlavorLabel(input.flavor) })
            const hapiSessionId = await importAdoptedSession(requireApi(), input, failed)
            return await requireApi().adoptTask({
                sessionId: hapiSessionId,
                title: input.title,
                permissionMode: input.permissionMode
            })
        },
        onSuccess: invalidate,
    })

    const updateTask = useMutation({
        mutationFn: async (input: { taskId: string; patch: UpdateTaskRequest }) =>
            await requireApi().updateTask(input.taskId, input.patch),
        onSuccess: ({ task }) => {
            // The hub answers with the saved row; showing it now keeps a renamed
            // title from snapping back to the old one until the refetch lands.
            patchTaskInLists(queryClient, task.id, task)
            queryClient.setQueryData<TaskDetailResponse>(
                queryKeys.task(task.id),
                (previous) => previous ? { ...previous, task } : previous
            )
            invalidate()
        },
    })

    const moveTask = useMutation({
        mutationFn: async (input: { taskId: string; column: TaskColumn }) =>
            await requireApi().moveTask(input.taskId, input.column),
        onMutate: async (input) => {
            await queryClient.cancelQueries({ queryKey: queryKeys.tasks })
            const snapshot = queryClient.getQueriesData<TaskListResponse>({ queryKey: queryKeys.taskLists })
            patchTaskInLists(queryClient, input.taskId, { column: input.column })
            return { snapshot }
        },
        onError: (_error, _input, context) => {
            // Put every list back exactly as it was — a partially rolled-back
            // list is worse than one that snaps to the server's answer.
            for (const [key, data] of context?.snapshot ?? []) {
                queryClient.setQueryData(key, data)
            }
        },
        // Note: the snapshot below is taken from the same list prefix, so the
        // rollback cannot touch detail entries either.
        onSettled: invalidate,
    })

    const startTask = useMutation({
        mutationFn: async (taskId: string) => await requireApi().startTask(taskId),
        onSuccess: invalidate,
        onError: invalidate,
    })

    const cancelTask = useMutation({
        mutationFn: async (taskId: string) => await requireApi().cancelTask(taskId),
        onSuccess: invalidate,
    })

    const archiveTask = useMutation({
        mutationFn: async (input: {
            taskId: string
            force?: boolean
            stopRun?: boolean
            keepWorktree?: boolean
            forceWorktree?: boolean
        }) =>
            await requireApi().archiveTask(input.taskId, {
                force: input.force,
                stopRun: input.stopRun,
                keepWorktree: input.keepWorktree,
                forceWorktree: input.forceWorktree
            }),
        onSuccess: invalidate,
    })

    const unarchiveTask = useMutation({
        mutationFn: async (taskId: string) => await requireApi().unarchiveTask(taskId),
        onSuccess: invalidate,
    })

    const deleteTask = useMutation({
        mutationFn: async (input: { taskId: string; force?: boolean; stopRun?: boolean }) =>
            await requireApi().deleteTask(input.taskId, { force: input.force, stopRun: input.stopRun }),
        onSuccess: invalidate,
    })

    const openPullRequest = useMutation({
        mutationFn: async (input: { taskId: string; baseBranch?: string; draft?: boolean }) =>
            await requireApi().openTaskPullRequest(input.taskId, {
                baseBranch: input.baseBranch,
                draft: input.draft
            }),
        onSuccess: invalidate,
    })

    const refreshPullRequest = useMutation({
        mutationFn: async (taskId: string) => await requireApi().refreshTaskPullRequest(taskId),
        onSuccess: invalidate,
    })

    const mutations = [
        createTask, adoptTask, updateTask, moveTask, startTask, cancelTask,
        archiveTask, unarchiveTask, deleteTask, openPullRequest, refreshPullRequest
    ]

    return {
        createTask: createTask.mutateAsync,
        adoptTask: adoptTask.mutateAsync,
        updateTask: updateTask.mutateAsync,
        moveTask: moveTask.mutateAsync,
        startTask: startTask.mutateAsync,
        cancelTask: cancelTask.mutateAsync,
        archiveTask: archiveTask.mutateAsync,
        unarchiveTask: unarchiveTask.mutateAsync,
        deleteTask: deleteTask.mutateAsync,
        openPullRequest: openPullRequest.mutateAsync,
        refreshPullRequest: refreshPullRequest.mutateAsync,
        isPending: mutations.some((mutation) => mutation.isPending),
        error: (() => {
            const failed = mutations.find((mutation) => mutation.error)
            return failed ? readableError(failed.error) : null
        })(),
        reset: () => {
            for (const mutation of mutations) mutation.reset()
        },
    }
}
