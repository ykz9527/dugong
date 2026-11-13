import { useCallback, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import {
    setActiveWorkspaceRoots,
    setActiveWorkspaceUserId,
    subscribeWorkspaceUserSwitchedElsewhere
} from '@/lib/activeWorkspaceUser'
import { useActiveWorkspaceUser } from '@/hooks/queries/useWorkspaceUsers'

/**
 * Keeps the SSE-visible copy of the selected user's roots current, and drops
 * the cached session list when another tab switches the user.
 *
 * Mount once, at app level, next to the SSE subscription itself. Anywhere
 * lower and the mirror would only be accurate while the task list or the
 * session list happened to be on screen — and the stream keeps delivering
 * other people's sessions the whole time you are reading a chat.
 */
export function useWorkspaceUserScopeSync(api: ApiClient | null): void {
    const queryClient = useQueryClient()
    const { activeId, activeUser } = useActiveWorkspaceUser(api)

    useEffect(() => {
        setActiveWorkspaceRoots(activeId === null ? null : activeUser?.paths ?? null)
    }, [activeId, activeUser])

    // What `useSwitchWorkspaceUser` does for a switch made in this tab.
    useEffect(() => subscribeWorkspaceUserSwitchedElsewhere(() => {
        void queryClient.resetQueries({ queryKey: queryKeys.sessions })
    }), [queryClient])
}

/**
 * Switch the lens.
 *
 * The session list is cached under one key for every user (see `useSessions`),
 * so the previous user's rows have to be thrown away rather than left to
 * refetch — otherwise the new selection renders somebody else's sessions until
 * the request lands, which is the single most confusing thing this feature
 * could do.
 */
export function useSwitchWorkspaceUser(): (id: string | null) => void {
    const queryClient = useQueryClient()

    return useCallback((id: string | null) => {
        setActiveWorkspaceUserId(id)
        void queryClient.resetQueries({ queryKey: queryKeys.sessions })
    }, [queryClient])
}
