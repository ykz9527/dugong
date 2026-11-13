import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { WorkspaceUser } from '@hapi/protocol'
import { readableError, type ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { useActiveWorkspaceUserId } from '@/lib/activeWorkspaceUser'

export function useWorkspaceUsers(api: ApiClient | null): {
    workspaceUsers: WorkspaceUser[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.workspaceUsers,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getWorkspaceUsers()
        },
        enabled: Boolean(api),
    })

    return {
        workspaceUsers: query.data?.workspaceUsers ?? [],
        isLoading: query.isLoading,
        error: query.error ? readableError(query.error) : null,
        refetch: query.refetch,
    }
}

/**
 * The selected user, resolved against the hub's list.
 *
 * Returns null both when nobody is selected and when the selected id no longer
 * exists — a user deleted on another device leaves this browser holding a
 * dangling id, and falling back to "everyone" is the honest reading of it. The
 * `id` is reported separately so a caller can tell the two apart before asking
 * the hub for a scope it will 404 on.
 */
export function useActiveWorkspaceUser(api: ApiClient | null): {
    activeId: string | null
    activeUser: WorkspaceUser | null
    workspaceUsers: WorkspaceUser[]
    isLoading: boolean
} {
    const activeId = useActiveWorkspaceUserId()
    const { workspaceUsers, isLoading } = useWorkspaceUsers(api)

    const activeUser = useMemo(
        () => (activeId ? workspaceUsers.find((user) => user.id === activeId) ?? null : null),
        [activeId, workspaceUsers]
    )

    return { activeId, activeUser, workspaceUsers, isLoading }
}
