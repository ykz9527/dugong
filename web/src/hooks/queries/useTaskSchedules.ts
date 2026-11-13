import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TaskSchedule } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { useActiveWorkspaceUserId } from '@/lib/activeWorkspaceUser'

/** Every schedule in the active workspace lens, keyed by task id. One shared
 *  query, so every row of the task list costs one request between them. */
export function useTaskSchedules(api: ApiClient | null): Map<string, TaskSchedule> {
    const workspaceUserId = useActiveWorkspaceUserId()
    const query = useQuery({
        queryKey: queryKeys.taskSchedules(workspaceUserId ?? 'everyone'),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return (await api.getTaskSchedules(workspaceUserId)).schedules
        },
        enabled: Boolean(api),
        // A cursor moves without any task changing; refresh "next run" now and then.
        refetchInterval: 60_000
    })
    return useMemo(
        () => new Map((query.data ?? []).map((schedule) => [schedule.taskId, schedule])),
        [query.data]
    )
}
