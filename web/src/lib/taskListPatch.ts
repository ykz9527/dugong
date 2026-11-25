import type { QueryClient } from '@tanstack/react-query'
import { TaskSchema, type Task } from '@hapi/protocol'
import type { TaskListResponse } from '@hapi/protocol/apiTypes'
import { queryKeys } from '@/lib/query-keys'

/**
 * Apply a `task-updated` event to every cached task list.
 *
 * The event carries the whole task, so a list that already holds the card is
 * patched in place - refetching it would pull every task again (~50 KB gzip
 * for a few dozen cards, through the relay on a phone) to learn one row.
 * A list that does not hold it (a new task, or one entering a filter) is
 * left to a refetch: only the server knows where it belongs.
 *
 * Returns the list query keys that still need a refetch.
 */
export function applyTaskUpdateToLists(queryClient: QueryClient, data: unknown): ReadonlyArray<readonly unknown[]> | 'all' {
    const parsed = TaskSchema.safeParse(data)
    if (!parsed.success) {
        return 'all'
    }
    const task = parsed.data
    const stale: Array<readonly unknown[]> = []
    for (const [queryKey, list] of queryClient.getQueriesData<TaskListResponse>({ queryKey: queryKeys.taskLists })) {
        if (!list || !Array.isArray(list.tasks)) continue
        const index = list.tasks.findIndex((row) => row.id === task.id)
        if (index === -1) {
            stale.push(queryKey)
            continue
        }
        queryClient.setQueryData<TaskListResponse>(queryKey, patchList(list, index, task, parseFilter(queryKey)))
    }
    return stale
}

type ListFilter = { column: string | null; machineId: string | null; includeArchived: boolean }

/** Reverse of `filterKey` in `useTasks`: `column:machine:archived|live:user`. */
function parseFilter(queryKey: readonly unknown[]): ListFilter {
    const [column, machineId, archived] = String(queryKey[2] ?? '').split(':')
    return {
        column: column && column !== 'all' ? column : null,
        machineId: machineId && machineId !== 'any' ? machineId : null,
        includeArchived: archived === 'archived'
    }
}

function patchList(list: TaskListResponse, index: number, task: Task, filter: ListFilter): TaskListResponse {
    const previous = list.tasks[index]
    const stillListed = (filter.includeArchived || task.archivedAt == null)
        && (filter.column === null || task.column === filter.column)
        && (filter.machineId === null || task.machineId === filter.machineId)
    const tasks = list.tasks.filter((_, i) => i !== index)
    if (stillListed) {
        tasks.push(task)
        // Same order as the hub's list query.
        tasks.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    }
    const counts = { ...list.counts }
    if (previous && previous.archivedAt == null) {
        counts[previous.column] = Math.max(0, (counts[previous.column] ?? 0) - 1)
    }
    if (task.archivedAt == null) {
        counts[task.column] = (counts[task.column] ?? 0) + 1
    }
    return { ...list, tasks, counts }
}
