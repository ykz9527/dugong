import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useSessionActions } from './useSessionActions'
import { ApiError, type ApiClient } from '@/api/client'

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function createMockApi(reopenSession: (sessionId: string) => Promise<{ ok: true; sessionId: string; resumed: boolean }>): ApiClient {
    return { reopenSession } as unknown as ApiClient
}

beforeEach(() => {
    vi.clearAllMocks()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('useSessionActions - reopenSession', () => {
    it('invokes api.reopenSession with the session id and forwards the response', async () => {
        const reopen = vi.fn(async (_sessionId: string) => ({
            ok: true as const,
            sessionId: 'session-A-spawned',
            resumed: true
        }))
        const api = createMockApi(reopen)

        const { result } = renderHook(
            () => useSessionActions(api, 'session-A', 'cursor'),
            { wrapper: createWrapper() },
        )

        let response: { ok: true; sessionId: string; resumed: boolean } | undefined
        await act(async () => {
            response = await result.current.reopenSession()
        })

        expect(reopen).toHaveBeenCalledWith('session-A')
        // The mutation must propagate the response so the UI can navigate to the
        // possibly-new spawn id when resumeSession merges the row.
        expect(response).toEqual({ ok: true, sessionId: 'session-A-spawned', resumed: true })
    })

    it('throws when api or sessionId is missing', async () => {
        const { result } = renderHook(
            () => useSessionActions(null, null, null),
            { wrapper: createWrapper() },
        )

        await expect(result.current.reopenSession()).rejects.toThrow('Session unavailable')
    })

    it('surfaces an ApiError so the UI can render the 422 missing-metadata payload', async () => {
        const reopen = vi.fn(async () => {
            throw new ApiError(
                'HTTP 422 Unprocessable Entity: {"error":"Cursor session id is missing from metadata; reopen requires the original cursor chat id","missing":["cursorSessionId"]}',
                422,
                'Cursor session id is missing from metadata; reopen requires the original cursor chat id',
                '{"error":"Cursor session id is missing from metadata; reopen requires the original cursor chat id","missing":["cursorSessionId"]}'
            )
        })
        const api = createMockApi(reopen as unknown as ApiClient['reopenSession'])

        const { result } = renderHook(
            () => useSessionActions(api, 'session-X', 'cursor'),
            { wrapper: createWrapper() },
        )

        let captured: unknown
        await act(async () => {
            try {
                await result.current.reopenSession()
            } catch (error) {
                captured = error
            }
        })

        expect(captured).toBeInstanceOf(ApiError)
        const apiError = captured as ApiError
        expect(apiError.status).toBe(422)
        expect(apiError.body).toContain('cursorSessionId')

        await waitFor(() => {
            // The hook should not get stuck pending after the failure.
            expect(result.current.isPending).toBe(false)
        })
    })

    it('does not invalidate the source session detail when reopen returns a different id', async () => {
        const reopen = vi.fn(async () => ({
            ok: true as const,
            sessionId: 'session-B',
            resumed: true,
        }))
        const queryClient = new QueryClient({
            defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
        })
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
        const api = createMockApi(reopen)
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        )
        const { result } = renderHook(
            () => useSessionActions(api, 'session-A', 'cursor'),
            { wrapper },
        )

        await act(async () => {
            await result.current.reopenSession()
        })

        await waitFor(() => {
            expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions'] })
        })
        expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['session', 'session-A'] })
    })

    it('invalidates the source session detail when reopen returns the same id', async () => {
        const reopen = vi.fn(async () => ({
            ok: true as const,
            sessionId: 'session-A',
            resumed: true,
        }))
        const queryClient = new QueryClient({
            defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
        })
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
        const api = createMockApi(reopen)
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        )
        const { result } = renderHook(
            () => useSessionActions(api, 'session-A', 'cursor'),
            { wrapper },
        )

        await act(async () => {
            await result.current.reopenSession()
        })

        await waitFor(() => {
            expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session', 'session-A'] })
        })
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions'] })
    })
})

describe('useSessionActions - session settings', () => {
    function setup(api: ApiClient) {
        const queryClient = new QueryClient({
            defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
        })
        queryClient.setQueryData(['session', 'session-A'], {
            session: { id: 'session-A', model: 'sonnet', permissionMode: 'default', effort: 'high' },
        })
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        )
        const { result } = renderHook(() => useSessionActions(api, 'session-A', 'claude'), { wrapper })
        const cached = () => (queryClient.getQueryData(['session', 'session-A']) as { session: Record<string, unknown> }).session
        return { result, cached, invalidate }
    }

    it('shows the new value before the hub answers and refetches nothing on success', async () => {
        let release!: () => void
        const api = {
            setPermissionMode: vi.fn(() => new Promise<void>((resolve) => { release = resolve })),
        } as unknown as ApiClient
        const { result, cached, invalidate } = setup(api)

        let change!: Promise<void>
        act(() => { change = result.current.setPermissionMode('acceptEdits') })
        await waitFor(() => expect(cached().permissionMode).toBe('acceptEdits'))
        expect(api.setPermissionMode).toHaveBeenCalledWith('session-A', 'acceptEdits')

        release()
        await act(async () => await change)
        expect(cached().permissionMode).toBe('acceptEdits')
        // The hub broadcasts the applied session over SSE; no list or detail refetch.
        expect(invalidate).not.toHaveBeenCalled()
    })

    it('restores the previous value when the hub rejects the change', async () => {
        const api = {
            setEffort: vi.fn(async () => { throw new Error('rejected') }),
        } as unknown as ApiClient
        const { result, cached, invalidate } = setup(api)

        await act(async () => {
            await expect(result.current.setEffort('low')).rejects.toThrow('rejected')
        })
        expect(cached().effort).toBe('high')
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session', 'session-A'] })
    })

    it('keeps a model change pending until the hub has applied it', async () => {
        let release!: () => void
        const api = {
            setModel: vi.fn(() => new Promise<void>((resolve) => { release = resolve })),
        } as unknown as ApiClient
        const { result, cached } = setup(api)

        let settled = false
        let change!: Promise<void>
        act(() => { change = result.current.setModel('opus').then(() => { settled = true }) })
        await waitFor(() => expect(cached().model).toBe('opus'))
        expect(settled).toBe(false)

        release()
        await act(async () => await change)
        expect(settled).toBe(true)
    })
})
