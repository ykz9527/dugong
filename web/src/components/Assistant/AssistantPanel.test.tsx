import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMemory } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import { AppContextProvider } from '@/lib/app-context'
import { I18nProvider } from '@/lib/i18n-context'
import { setActiveWorkspaceUserId } from '@/lib/activeWorkspaceUser'
import { getDraftAttachments } from '@/lib/composer-attachment-drafts'
import { getDraft } from '@/lib/composer-drafts'
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

function makeMachine(id: string, host: string) {
    return {
        id, namespace: 'default', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata: { host, platform: 'linux', happyCliVersion: '1' },
        metadataVersion: 1, runnerState: null, runnerStateVersion: 1
    }
}

function makeApi(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
    return {
        getWorkspaceUsers: vi.fn(async () => ({
            workspaceUsers: [{ id: 'user-kai', namespace: 'default', name: 'Kai', paths: ['/srv'], createdAt: 1, updatedAt: 1 }]
        })),
        getAssistantSession: vi.fn(async () => ({ sessionId: null, agent: 'claude', machineId: null, sessionMachineId: null })),
        getMachines: vi.fn(async () => ({ machines: [makeMachine('m-71', '37-1'), makeMachine('m-72', '37-2')] })),
        checkMachinePathsExists: vi.fn(async () => ({ exists: {} })),
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
    vi.unstubAllGlobals()
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

    it('starts the assistant for a file picked before the first message, and hands it to the composer', async () => {
        // The thread opens its own event stream once the session exists.
        vi.stubGlobal('EventSource', class { close() {} addEventListener() {} })
        let started: string | null = null
        const openAssistantSession = vi.fn(async () => {
            started = 's-new'
            return { sessionId: started }
        })
        const sendAssistantMessage = vi.fn()
        renderPanel(makeApi({
            openAssistantSession,
            sendAssistantMessage,
            getAssistantSession: vi.fn(async () => ({ sessionId: started, agent: 'claude', machineId: null, sessionMachineId: null })),
            getSession: vi.fn(() => new Promise(() => {}))
        }))

        fireEvent.change(await screen.findByPlaceholderText('Ask the assistant about your tasks'), { target: { value: 'what is this?' } })
        const input = document.querySelector('input[type="file"]') as HTMLInputElement
        const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
        fireEvent.change(input, { target: { files: [file] } })

        await waitFor(() => expect(openAssistantSession).toHaveBeenCalledWith({ workspaceUserId: 'user-kai', contextTaskId: null }))
        expect(sendAssistantMessage).not.toHaveBeenCalled()
        expect(getDraft('s-new')).toBe('what is this?')
        expect((await getDraftAttachments('s-new')).map((stored) => stored.name)).toEqual(['notes.txt'])
        await waitFor(() => expect(screen.queryByPlaceholderText('Ask the assistant about your tasks')).toBeNull())
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

    it('moves the assistant to the machine picked beside the agent', async () => {
        const setAssistantMachine = vi.fn(async () => ({ sessionId: null, agent: 'claude', machineId: 'm-71', sessionMachineId: null }))
        const api = makeApi({
            // No session id: a live one would open the chat's event stream.
            getAssistantSession: vi.fn(async () => ({ sessionId: null, agent: 'claude', machineId: null, sessionMachineId: 'm-72' })),
            setAssistantMachine
        })
        renderPanel(api)

        const select = await screen.findByRole('combobox', { name: /Machine the assistant runs on/ }) as HTMLSelectElement
        await waitFor(() => expect([...select.options].map((option) => option.text)).toEqual(['Auto · 37-2', '37-1', '37-2']))
        fireEvent.change(select, { target: { value: 'm-71' } })
        await waitFor(() => expect(setAssistantMachine).toHaveBeenCalledWith({ workspaceUserId: 'user-kai', machineId: 'm-71' }))
        await waitFor(() => expect(select.value).toBe('m-71'))
    })

    it('keeps an offline pinned machine in view, and says why a switch failed', async () => {
        const body = '{"error":"That machine is offline"}'
        const api = makeApi({
            getAssistantSession: vi.fn(async () => ({ sessionId: null, agent: 'claude', machineId: 'm-gone-1234', sessionMachineId: null })),
            setAssistantMachine: vi.fn(async () => {
                throw new ApiError(`HTTP 409 Conflict: ${body}`, 409, undefined, body)
            })
        })
        renderPanel(api)

        const select = await screen.findByRole('combobox', { name: /Machine the assistant runs on/ }) as HTMLSelectElement
        await waitFor(() => expect(select.value).toBe('m-gone-1234'))
        expect(select.selectedOptions[0]?.text).toBe('m-gone-1 (offline)')
        fireEvent.change(select, { target: { value: 'm-72' } })
        expect((await screen.findByRole('alert')).textContent).toBe('Could not switch machine: That machine is offline')
    })

    it('names the directories the assistant\'s machine does not have', async () => {
        const checkMachinePathsExists = vi.fn(async () => ({ exists: { '/srv': false } }))
        renderPanel(makeApi({
            getAssistantSession: vi.fn(async () => ({ sessionId: null, agent: 'claude', machineId: 'm-71', sessionMachineId: null })),
            checkMachinePathsExists
        }))

        expect(await screen.findByText('37-1 does not have /srv. The assistant cannot see these directories there.')).toBeTruthy()
        expect(checkMachinePathsExists).toHaveBeenCalledWith('m-71', ['/srv'])
    })
})
