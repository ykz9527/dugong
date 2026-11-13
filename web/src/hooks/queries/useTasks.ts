import { useQuery } from '@tanstack/react-query'
import type { Task, TaskColumn } from '@hapi/protocol'
import { readableError, type ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { useActiveWorkspaceUserId } from '@/lib/activeWorkspaceUser'

export type TaskFilter = {
    column?: TaskColumn
    machineId?: string
    includeArchived?: boolean
}

/** Stable cache key for a filter combination. The workspace user is part of it
 *  rather than an invalidation trigger: switching lens must show the new user's
 *  tasks immediately, not the previous one's until a refetch lands. */
function filterKey(filter: TaskFilter | undefined, workspaceUserId: string | null): string {
    return [
        filter?.column ?? 'all',
        filter?.machineId ?? 'any',
        filter?.includeArchived ? 'archived' : 'live',
        workspaceUserId ?? 'everyone'
    ].join(':')
}

export function useTasks(api: ApiClient | null, filter?: TaskFilter): {
    tasks: Task[]
    counts: Record<string, number>
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const workspaceUserId = useActiveWorkspaceUserId()
    const query = useQuery({
        queryKey: queryKeys.taskList(filterKey(filter, workspaceUserId)),
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getTasks({ ...filter, workspaceUserId })
        },
        enabled: Boolean(api),
    })

    return {
        tasks: query.data?.tasks ?? [],
        counts: query.data?.counts ?? {},
        isLoading: query.isLoading,
        error: query.error ? readableError(query.error) : null,
        refetch: query.refetch,
    }
}

export function useTask(api: ApiClient | null, taskId: string | null) {
    return useQuery({
        queryKey: queryKeys.task(taskId ?? ''),
        queryFn: async () => {
            if (!api || !taskId) {
                throw new Error('API unavailable')
            }
            return await api.getTask(taskId)
        },
        enabled: Boolean(api && taskId),
    })
}
