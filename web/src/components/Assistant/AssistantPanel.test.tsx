import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMemory } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import { AppContextProvider } from '@/lib/app-context'
import { I18nProvider } from '@/lib/i18n-context'
import { setActiveWorkspaceUserId } from '@/lib/activeWorkspaceUser'
import { AssistantPanel } from './AssistantPanel'

function makeMemory(overrides: Partial<AssistantMemory> = {}): AssistantMemory {
    return {
        id: 'mem-1',
        namespace: 'default',
        workspaceUserId: 'user-kai',
        scope: 'user',
        scopeRef: 'user-kai',
        name: 'tabs',
        description: 'Prefers tabs',
        type: 'project',
        body: 'Use tabs.',
        createdBy: 'human',
        lastEditedBy: 'human',
        source: null,
        previous: null,
        createdAt: 1,
        updatedAt: 1,
        ...overrides
    }
}

function makeApi(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
    return {
        getWorkspaceUsers: vi.fn(async () => ({
            workspaceUsers: [{ id: 'user-kai', namespace: 'default', name: 'Kai', paths: ['/srv'], createdAt: 1, updatedAt: 1 }]
        })),
        getAssistantSession: vi.fn(async () => ({ sessionId: null, agent: 'claude' })),
        getAssistantMemories: vi.fn(async () => ({ memories: [makeMemory()] })),
        getAssistantGrants: vi.fn(async () => ({ grants: [] })),
        getAssistantQuestions: vi.fn(async () => ({ questions: [] })),
        getTasks: vi.fn(async () => ({ tasks: [], counts: {} })),
        deleteAssistantMemory: vi.fn(async () => {}),
        ...overrides
    } as unknown as ApiClient
}

function renderPanel(api: ApiClient, options: { fullScreen?: boolean; onClose?: () => void } = {}) {
    return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <AppContextProvider value={{ api, token: 't', baseUrl: 'http://localhost' }}>
                <I18nProvider>
                    <AssistantPanel api={api} task={null} fullScreen={options.fullScreen} onClose={options.onClose ?? (() => {})} />
                </I18nProvider>
            </AppContextProvider>
        </QueryClientProvider>
    )
}

beforeEach(() => {
    setActiveWorkspaceUserId('user-kai')
})

afterEach(() => {
    cleanup()
    act(() => setActiveWorkspaceUserId(null))
    vi.restoreAllMocks()
})

describe('AssistantPanel', () => {
    it('does not claim "not started" while it is still asking', async () => {
        renderPanel(makeApi({ getAssistantSession: vi.fn(() => new Promise(() => {})) }))

        expect(await screen.findByText('Loading…')).toBeTruthy()
        expect(screen.queryByText('Assistant not started.')).toBeNull()
    })

    it('says the lookup failed, and asks again on Retry', async () => {
        const body = '{"error":"Workspace user not found"}'
        const getAssistantSession = vi.fn(async () => {
            throw new ApiError(`HTTP 404 Not Found: ${body}`, 404, undefined, body)
        })
        renderPanel(makeApi({ getAssistantSession }))

        expect((await screen.findByRole('alert')).textContent)
            .toBe('Could not load the assistant: Workspace user not found')
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(getAssistantSession).toHaveBeenCalledTimes(2))
    })

    it('ties each tab to its panel', async () => {
        renderPanel(makeApi())

        const tab = await screen.findByRole('tab', { name: 'Memory' })
        fireEvent.click(tab)
        const panel = screen.getByRole('tabpanel')
        expect(tab.getAttribute('aria-controls')).toBe(panel.id)
        expect(panel.getAttribute('aria-labelledby')).toBe(tab.id)
    })

    it('labels the memory search and filter', async () => {
        renderPanel(makeApi())

        fireEvent.click(await screen.findByRole('tab', { name: 'Memory' }))
        expect(screen.getByRole('searchbox', { name: 'Search memory' })).toBeTruthy()
        expect(screen.getByRole('combobox', { name: 'Show' })).toBeTruthy()
    })

    it('deletes a memory only on the second press', async () => {
        const api = makeApi()
        renderPanel(api)

        fireEvent.click(await screen.findByRole('tab', { name: 'Memory' }))
        fireEvent.click(await screen.findByRole('button', { name: /Prefers tabs/ }))
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        expect(api.deleteAssistantMemory).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
        await waitFor(() => expect(api.deleteAssistantMemory).toHaveBeenCalledWith('mem-1'))
    })

    it('shows a failed delete instead of dropping it', async () => {
        const body = '{"error":"Memory not found"}'
        const api = makeApi({
            deleteAssistantMemory: vi.fn(async () => {
                throw new ApiError(`HTTP 404 Not Found: ${body}`, 404, undefined, body)
            })
        })
        renderPanel(api)

        fireEvent.click(await screen.findByRole('tab', { name: 'Memory' }))
        fireEvent.click(await screen.findByRole('button', { name: /Prefers tabs/ }))
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))

        expect((await screen.findByRole('alert')).textContent).toBe('Memory not found')
    })

    it('is a modal dialog on a phone, closed by Escape', async () => {
        const onClose = vi.fn()
        renderPanel(makeApi(), { fullScreen: true, onClose })

        const sheet = await screen.findByRole('dialog', { name: 'Assistant' })
        expect(sheet.getAttribute('aria-modal')).toBe('true')
        expect(document.activeElement).toBe(sheet)
        fireEvent.keyDown(await within(sheet).findByRole('tab', { name: 'Chat' }), { key: 'Escape' })
        expect(onClose).toHaveBeenCalledTimes(1)
    })
})
