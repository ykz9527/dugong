import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceUser } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { AppContextProvider } from '@/lib/app-context'
import { I18nProvider } from '@/lib/i18n-context'
import {
    getActiveWorkspaceRoots,
    getActiveWorkspaceUserId,
    setActiveWorkspaceRoots,
    setActiveWorkspaceUserId,
    subscribeWorkspaceUserSwitchedElsewhere
} from '@/lib/activeWorkspaceUser'
import { useWorkspaceUserScopeSync } from '@/hooks/useWorkspaceUserScope'
import { WorkspaceUserPicker } from './WorkspaceUserPicker'

/**
 * The lens itself: choosing a user has to reach both the hub request and the
 * copy of the roots the SSE handler reads. Those are the two places the filter
 * can silently fail open, so they are what these cover.
 */

function makeUser(overrides: Partial<WorkspaceUser> = {}): WorkspaceUser {
    return {
        id: 'user-kai',
        namespace: 'default',
        name: 'Kai',
        paths: ['/srv/repo'],
        createdAt: 1,
        updatedAt: 1,
        ...overrides
    }
}

function makeApi(workspaceUsers: WorkspaceUser[]): ApiClient {
    return {
        getWorkspaceUsers: vi.fn(async () => ({ workspaceUsers })),
        getMachines: vi.fn(async () => ({ machines: [] })),
        getSessions: vi.fn(async () => ({ sessions: [] })),
        deleteWorkspaceUser: vi.fn(async () => {})
    } as unknown as ApiClient
}

function renderPicker(api: ApiClient, extra?: React.ReactNode, queryClient?: QueryClient) {
    return render(
        <QueryClientProvider client={queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <AppContextProvider value={{ api, token: 't', baseUrl: 'http://localhost' }}>
                <I18nProvider>
                    <WorkspaceUserPicker api={api} />
                    {extra}
                </I18nProvider>
            </AppContextProvider>
        </QueryClientProvider>
    )
}

function ScopeSync({ api }: { api: ApiClient }) {
    useWorkspaceUserScopeSync(api)
    return null
}

/** What the browser fires in this tab when another tab writes the key. */
function switchInAnotherTab(id: string | null) {
    window.dispatchEvent(new StorageEvent('storage', { key: 'hapi.workspaceUser.v1.activeId', newValue: id }))
}

beforeEach(() => {
    setActiveWorkspaceUserId(null)
})

afterEach(() => {
    cleanup()
    setActiveWorkspaceUserId(null)
    vi.restoreAllMocks()
})

describe('WorkspaceUserPicker', () => {
    it('lists the hub users alongside an unfiltered option', async () => {
        renderPicker(makeApi([makeUser(), makeUser({ id: 'user-ming', name: 'Ming' })]))

        await screen.findByRole('option', { name: 'Kai' })
        expect(screen.getByRole('option', { name: 'Ming' })).toBeTruthy()
        expect(screen.getByRole('option', { name: 'Everyone' })).toBeTruthy()
    })

    it('selecting a user publishes their roots for the SSE handler', async () => {
        const api = makeApi([makeUser()])
        renderPicker(api, <ScopeSync api={api} />)

        await screen.findByRole('option', { name: 'Kai' })
        expect(getActiveWorkspaceRoots()).toBeNull()

        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'user-kai' } })

        await waitFor(() => {
            expect(getActiveWorkspaceRoots()).toEqual(['/srv/repo'])
        })
    })

    it('going back to Everyone clears the roots again', async () => {
        const api = makeApi([makeUser()])
        renderPicker(api, <ScopeSync api={api} />)

        await screen.findByRole('option', { name: 'Kai' })
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'user-kai' } })
        await waitFor(() => expect(getActiveWorkspaceRoots()).toEqual(['/srv/repo']))

        fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
        await waitFor(() => expect(getActiveWorkspaceRoots()).toBeNull())
    })

    it('falls back to Everyone when the selected user no longer exists', async () => {
        // Deleted on another device; this browser still holds the id.
        setActiveWorkspaceUserId('user-gone')
        renderPicker(makeApi([makeUser()]))

        await screen.findByRole('option', { name: 'Kai' })
        expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('')
    })

    it('hides itself when asked to and nobody is defined yet', async () => {
        const api = makeApi([])
        render(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <AppContextProvider value={{ api, token: 't', baseUrl: 'http://localhost' }}>
                    <I18nProvider>
                        <WorkspaceUserPicker api={api} hideWhenEmpty />
                    </I18nProvider>
                </AppContextProvider>
            </QueryClientProvider>
        )

        await waitFor(() => expect(api.getWorkspaceUsers).toHaveBeenCalled())
        expect(screen.queryByRole('combobox')).toBeNull()
    })

    it('manages users in a modal dialog that deletes only on the second press', async () => {
        const api = makeApi([makeUser()])
        renderPicker(api)

        await screen.findByRole('option', { name: 'Kai' })
        fireEvent.change(screen.getByRole('combobox'), { target: { value: '__manage__' } })
        const dialog = await screen.findByRole('dialog', { name: 'Users' })
        expect(dialog.getAttribute('aria-modal')).toBe('true')

        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete user' }))
        expect(api.deleteWorkspaceUser).not.toHaveBeenCalled()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm delete' }))
        await waitFor(() => expect(api.deleteWorkspaceUser).toHaveBeenCalledWith('user-kai'))

        fireEvent.keyDown(dialog, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })
})

describe('switching user in another tab', () => {
    it('drops the old user\'s roots and tells subscribers', () => {
        setActiveWorkspaceUserId('user-kai')
        setActiveWorkspaceRoots(['/srv/repo'])
        const switched = vi.fn()
        const unsubscribe = subscribeWorkspaceUserSwitchedElsewhere(switched)

        switchInAnotherTab('user-ming')
        unsubscribe()

        expect(getActiveWorkspaceUserId()).toBe('user-ming')
        // Kai's roots applied to Ming would be exactly backwards; until Ming's
        // list arrives, nothing is claimed.
        expect(getActiveWorkspaceRoots()).toEqual([])
        expect(switched).toHaveBeenCalledTimes(1)
    })

    it('throws away the cached session list, like a switch made here', async () => {
        const api = makeApi([makeUser(), makeUser({ id: 'user-ming', name: 'Ming', paths: ['/srv/ming'] })])
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        act(() => setActiveWorkspaceUserId('user-kai'))
        renderPicker(api, <ScopeSync api={api} />, queryClient)
        await waitFor(() => expect(getActiveWorkspaceRoots()).toEqual(['/srv/repo']))
        queryClient.setQueryData(['sessions'], { sessions: [{ id: 'kai-session' }] })

        act(() => switchInAnotherTab('user-ming'))

        await waitFor(() => expect(getActiveWorkspaceRoots()).toEqual(['/srv/ming']))
        expect(queryClient.getQueryData(['sessions'])).toBeUndefined()
    })
})
