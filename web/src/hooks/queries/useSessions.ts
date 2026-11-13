import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { getActiveWorkspaceUserId, useActiveWorkspaceUserId } from '@/lib/activeWorkspaceUser'

export function useSessions(api: ApiClient | null): {
    sessions: SessionSummary[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    // Subscribed so a switch re-renders the list; the value is deliberately
    // not what the request is built from.
    useActiveWorkspaceUserId()
    // The key deliberately stays `queryKeys.sessions` — the SSE handler, the
    // chat screen and a dozen other call sites patch this one entry by name,
    // and a per-user key would leave every one of them writing into a cache
    // nobody reads. Switching user resets the entry instead; see
    // `useSwitchWorkspaceUser`.
    const query = useQuery({
        queryKey: queryKeys.sessions,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            // Read at request time rather than closing over the rendered value.
            // Switching user resets this query synchronously, before React has
            // re-rendered it, so a captured id would still be the old one and
            // the refetch would faithfully re-fetch the previous person's
            // sessions — the list stays put and the filter looks broken.
            return await api.getSessions({ workspaceUserId: getActiveWorkspaceUserId() })
        },
        enabled: Boolean(api),
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch,
    }
}
