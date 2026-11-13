import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { setActiveWorkspaceUserId } from '@/lib/activeWorkspaceUser'
import { queryKeys } from '@/lib/query-keys'
import { useSessions } from './useSessions'

function wrapper(queryClient: QueryClient) {
    return ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

function createQueryClient(): QueryClient {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('useSessions workspace scoping', () => {
    afterEach(() => {
        setActiveWorkspaceUserId(null)
    })

    it('requests the user selected at request time, not at render time', async () => {
        // `useSwitchWorkspaceUser` sets the id and resets this query in the same
        // synchronous breath, so the refetch starts before React has re-rendered.
        // A queryFn closing over the rendered id would re-fetch the *previous*
        // person's sessions, and the list would sit there unchanged — which is
        // exactly what "switching the user does nothing" looks like.
        const getSessions = vi.fn(async () => ({ sessions: [] }))
        const api = { getSessions } as unknown as ApiClient
        const queryClient = createQueryClient()

        renderHook(() => useSessions(api), { wrapper: wrapper(queryClient) })
        await waitFor(() => expect(getSessions).toHaveBeenCalledTimes(1))
        expect(getSessions).toHaveBeenLastCalledWith({ workspaceUserId: null })

        // Both statements, in the order the switch performs them.
        setActiveWorkspaceUserId('user-zhou')
        void queryClient.resetQueries({ queryKey: queryKeys.sessions })

        await waitFor(() => expect(getSessions).toHaveBeenCalledTimes(2))
        expect(getSessions).toHaveBeenLastCalledWith({ workspaceUserId: 'user-zhou' })
    })

    it('drops back to every session when the selection is cleared', async () => {
        const getSessions = vi.fn(async () => ({ sessions: [] }))
        const api = { getSessions } as unknown as ApiClient
        const queryClient = createQueryClient()
        setActiveWorkspaceUserId('user-kzz')

        renderHook(() => useSessions(api), { wrapper: wrapper(queryClient) })
        await waitFor(() => expect(getSessions).toHaveBeenCalledTimes(1))
        expect(getSessions).toHaveBeenLastCalledWith({ workspaceUserId: 'user-kzz' })

        setActiveWorkspaceUserId(null)
        void queryClient.resetQueries({ queryKey: queryKeys.sessions })

        await waitFor(() => expect(getSessions).toHaveBeenCalledTimes(2))
        expect(getSessions).toHaveBeenLastCalledWith({ workspaceUserId: null })
    })
})
