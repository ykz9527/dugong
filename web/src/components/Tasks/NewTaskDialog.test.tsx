import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import { setActiveWorkspaceUserId } from '@/lib/activeWorkspaceUser'
import { AppContextProvider } from '@/lib/app-context'
import { I18nProvider } from '@/lib/i18n-context'
import { useNewTaskDialog } from './useNewTaskDialog'

// The composer's adopt picker links to sessions; a full router is more
// machinery than these assertions need.
vi.mock('@tanstack/react-router', () => ({
    Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>
}))

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    setActiveWorkspaceUserId(null)
})

// The whole object is cast to ApiClient at the end anyway, so demanding exact
// method types from a partial stub buys nothing and costs a cast per override.
function makeApi(tasks: Task[], overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
    return {
        getTasks: vi.fn(async () => ({
            tasks,
            counts: tasks.reduce<Record<string, number>>((acc, task) => {
                acc[task.column] = (acc[task.column] ?? 0) + 1
                return acc
            }, {})
        })),
        getSessions: vi.fn(async () => ({ sessions: [] })),
        getWorkspaceUsers: vi.fn(async () => ({ workspaceUsers: [] })),
        getMachines: vi.fn(async () => ({
            machines: [{
                id: 'box-1',
                metadata: { displayName: 'Workstation', workspaceRoots: ['/srv'], homeDir: '/home/dev' }
            }]
        })),
        listMachineDirectory: vi.fn(async (_machineId: string, path: string) => ({
            success: true,
            entries: path === '/srv'
                ? [
                    { name: 'repo', type: 'directory' as const, isGitRepo: true },
                    { name: 'notes', type: 'directory' as const, isGitRepo: false },
                    { name: 'README.md', type: 'file' as const }
                ]
                : []
        })),
        checkMachinePathsExists: vi.fn(async (_machineId: string, paths: string[]) => ({
            exists: Object.fromEntries(paths.map((path) => [path, true]))
        })),
        createMachineDirectory: vi.fn(async (_machineId: string, path: string) => ({ success: true, path })),
        updateWorkspaceUser: vi.fn(async (id: string, patch: { paths?: string[] }) => ({
            workspaceUser: { id, namespace: 'default', name: 'kzz', paths: patch.paths ?? [], createdAt: 0, updatedAt: 0 }
        })),
        moveTask: vi.fn(async () => ({ task: tasks[0] })),
        createTask: vi.fn(async () => ({ task: tasks[0] })),
        startTask: vi.fn(async () => ({ task: tasks[0], runId: 'run-1', sessionId: 'sess-1' })),
        cancelTask: vi.fn(async () => ({ task: tasks[0] })),
        archiveTask: vi.fn(async () => ({ task: tasks[0] })),
        openTaskPullRequest: vi.fn(async () => ({ task: tasks[0], pullRequest: null })),
        refreshTaskPullRequest: vi.fn(async () => ({ task: tasks[0], pullRequest: null })),
        deleteTask: vi.fn(async () => ({ deleted: true, worktree: { outcome: 'skipped', reason: 'no-worktree' } })),
        ...overrides
    } as unknown as ApiClient
}

function Composer(props: { api: ApiClient }) {
    const newTask = useNewTaskDialog(props.api)
    return (
        <>
            <button type="button" onClick={() => newTask.open()}>New task</button>
            {newTask.dialog}
        </>
    )
}

function renderComposer(api: ApiClient) {
    return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <AppContextProvider value={{ api, token: 't', baseUrl: 'http://localhost' }}>
                <I18nProvider>
                    <Composer api={api} />
                </I18nProvider>
            </AppContextProvider>
        </QueryClientProvider>
    )
}

/** Open the composer and walk the directory picker to `/srv/repo`. */
async function composeWithDirectory(prompt: string) {
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), { target: { value: prompt } })
    // The single connected machine is selected for us once machines load.
    await waitFor(() =>
        expect((screen.getByRole('button', { name: 'Browse…' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await screen.findByRole('button', { name: /repo/ })
    fireEvent.click(screen.getByRole('button', { name: /^repo/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use this directory' }))
}

describe('New task composer', () => {
    it('creates a task from the composer', async () => {
        const api = makeApi([])
        renderComposer(api)

        await composeWithDirectory('Rewrite the tokenizer')
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))

        await waitFor(() => expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({
            prompt: 'Rewrite the tokenizer',
            workdir: '/srv/repo',
            isolation: 'worktree',
            spawn: { flavor: 'claude', permissionMode: 'auto' },
            machineId: 'box-1'
        })))
    })

    it('keeps Create disabled until the prompt and directory are both set', async () => {
        renderComposer(makeApi([]))

        fireEvent.click(await screen.findByRole('button', { name: 'New task' }))
        expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true)

        fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), { target: { value: 'x' } })
        // A prompt alone is not enough — there is no directory yet.
        expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true)
    })

    it('auto-selects the only connected machine so Browse is usable right away', async () => {
        renderComposer(makeApi([]))

        fireEvent.click(await screen.findByRole('button', { name: 'New task' }))
        await waitFor(() =>
            expect((screen.getByRole('button', { name: 'Browse…' }) as HTMLButtonElement).disabled).toBe(false))
        expect((screen.getByLabelText('Machine') as HTMLSelectElement).value).toBe('box-1')
    })

    it('leaves the choice open when several machines are connected', async () => {
        const api = makeApi([], {
            getMachines: vi.fn(async () => ({
                machines: [
                    { id: 'box-1', metadata: { displayName: 'One', workspaceRoots: ['/srv'] } },
                    { id: 'box-2', metadata: { displayName: 'Two', workspaceRoots: ['/opt'] } }
                ]
            }))
        })
        renderComposer(api)

        fireEvent.click(await screen.findByRole('button', { name: 'New task' }))
        expect((screen.getByLabelText('Machine') as HTMLSelectElement).value).toBe('')
        expect((screen.getByRole('button', { name: 'Browse…' }) as HTMLButtonElement).disabled).toBe(true)
        expect(screen.getByText('Pick a machine to browse its directories.')).toBeTruthy()
    })

    it('names the real blocker when no runner is connected', async () => {
        const api = makeApi([], { getMachines: vi.fn(async () => ({ machines: [] })) })
        renderComposer(api)

        fireEvent.click(await screen.findByRole('button', { name: 'New task' }))
        expect((screen.getByRole('button', { name: 'Browse…' }) as HTMLButtonElement).disabled).toBe(true)
        // "Pick a machine" would be useless advice when there is none to pick.
        expect(screen.getByText('No machine connected. Start a runner on the machine with your code.')).toBeTruthy()
    })

    it('browses from the machine workspace root and marks git repos', async () => {
        const api = makeApi([])
        renderComposer(api)

        fireEvent.click(await screen.findByRole('button', { name: 'New task' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Browse…' }))

        // Starts at the runner's workspace root, not at /.
        await waitFor(() => expect(api.listMachineDirectory).toHaveBeenCalledWith('box-1', '/srv'))
        const repoEntry = await screen.findByRole('button', { name: /^repo/ })
        expect(repoEntry.textContent).toContain('git')
        // Files are not directories; they must not be offered.
        expect(screen.queryByRole('button', { name: /README/ })).toBeNull()
        // Nothing above the root to go up into.
        expect(screen.queryByRole('button', { name: '← Up one level' })).toBeNull()

        // The scope the runner allows is spelled out — otherwise a small tree
        // reads as a broken picker rather than a deliberate boundary.
        expect(screen.getByText('Runner allows:')).toBeTruthy()

        // The empty state has to point at the way forward: the root often *is*
        // the repo, and "use this directory" is the expected next click.
        fireEvent.click(screen.getByRole('button', { name: /^notes/ }))
        expect(await screen.findByText('No sub-folders.')).toBeTruthy()
        expect(screen.getByText('The task can still run here.')).toBeTruthy()
        expect(screen.getByRole('button', { name: '← Up one level' })).toBeTruthy()
    })

    it('makes a folder where it stands and lands in it', async () => {
        const api = makeApi([])
        renderComposer(api)

        fireEvent.click(await screen.findByRole('button', { name: 'New task' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Browse…' }))
        await screen.findByRole('button', { name: /^repo/ })

        fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
        fireEvent.change(screen.getByLabelText('New folder'), { target: { value: 'new-project' } })
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))

        await waitFor(() => expect(api.createMachineDirectory).toHaveBeenCalledWith('box-1', '/srv/new-project'))
        // The new folder is where the work will be, so the picker moves in.
        await waitFor(() => expect(api.listMachineDirectory).toHaveBeenCalledWith('box-1', '/srv/new-project'))
        fireEvent.click(screen.getByRole('button', { name: 'Use this directory' }))
        expect(await screen.findByTitle('/srv/new-project')).toBeTruthy()
    })

    it('claims a directory outside the user\'s own before making the task', async () => {
        setActiveWorkspaceUserId('u1')
        const api = makeApi([], {
            getWorkspaceUsers: vi.fn(async () => ({
                workspaceUsers: [{ id: 'u1', namespace: 'default', name: 'kzz', paths: ['/srv/notes'], createdAt: 0, updatedAt: 0 }]
            }))
        })
        renderComposer(api)

        fireEvent.click(screen.getByRole('button', { name: 'New task' }))
        fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), { target: { value: 'Rewrite the tokenizer' } })
        await waitFor(() =>
            expect((screen.getByRole('button', { name: 'Browse…' }) as HTMLButtonElement).disabled).toBe(false))
        fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
        // Opens where kzz's work is, but can leave it: the new project sits beside it.
        await waitFor(() => expect(api.listMachineDirectory).toHaveBeenCalledWith('box-1', '/srv/notes'))
        fireEvent.click(await screen.findByRole('button', { name: '← Up one level' }))
        fireEvent.click(await screen.findByRole('button', { name: /^repo/ }))
        fireEvent.click(await screen.findByRole('button', { name: 'Use this directory' }))
        // Said before it happens: the task would otherwise vanish from kzz's list.
        expect(await screen.findByText("Will be added to kzz's directories")).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))

        await waitFor(() => expect(api.updateWorkspaceUser).toHaveBeenCalledWith('u1', { paths: ['/srv/notes', '/srv/repo'] }))
        await waitFor(() => expect(api.createTask).toHaveBeenCalled())
    })

    it('clears a chosen directory when the machine changes', async () => {
        renderComposer(makeApi([]))
        await composeWithDirectory('x')
        expect(screen.getByTitle('/srv/repo')).toBeTruthy()

        // A path is meaningless on a different machine.
        fireEvent.change(screen.getByLabelText('Machine'), { target: { value: '' } })
        expect(screen.getByText('No directory chosen')).toBeTruthy()
    })

    it('cannot ask for an immediate start when no machine is connected', async () => {
        const api = makeApi([], { getMachines: vi.fn(async () => ({ machines: [] })) })
        renderComposer(api)

        fireEvent.click(await screen.findByRole('button', { name: 'New task' }))
        const startNow = screen.getByLabelText('Start immediately', { exact: false }) as HTMLInputElement
        expect(startNow.disabled).toBe(true)
        expect(screen.getByText('Pick a machine first')).toBeTruthy()
    })

    it('allows an immediate start once the machine is settled', async () => {
        renderComposer(makeApi([]))

        fireEvent.click(await screen.findByRole('button', { name: 'New task' }))
        // Auto-selected single machine — nothing left blocking the checkbox.
        await waitFor(() => {
            const startNow = screen.getByLabelText('Start immediately', { exact: false }) as HTMLInputElement
            expect(startNow.disabled).toBe(false)
        })
    })

    it('says so when the task was created but did not start, and does not offer Create again', async () => {
        const api = makeApi([], {
            createTask: vi.fn(async () => ({
                task: { id: 'task-1' },
                start: { outcome: 'spawn-failed', message: 'runner offline' }
            }))
        })
        renderComposer(api)

        await composeWithDirectory('Rewrite the tokenizer')
        fireEvent.click(screen.getByLabelText('Start immediately', { exact: false }))
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))

        expect((await screen.findByRole('alert')).textContent)
            .toBe('Task created, but it did not start: runner offline')
        expect(screen.queryByRole('button', { name: 'Create' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })

    it('shows the hub\'s reason for a refused create, and forgets it when reopened', async () => {
        const body = '{"error":"Directory is outside the workspace roots"}'
        const api = makeApi([], {
            createTask: vi.fn(async () => {
                throw new ApiError(`HTTP 400 Bad Request: ${body}`, 400, undefined, body)
            })
        })
        renderComposer(api)

        await composeWithDirectory('Rewrite the tokenizer')
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))
        expect((await screen.findByRole('alert')).textContent).toBe('Directory is outside the workspace roots')

        // Escape closes it like any dialog; a new composer starts clean.
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        fireEvent.click(screen.getByRole('button', { name: 'New task' }))
        expect(await screen.findByRole('dialog', { name: 'New task' })).toBeTruthy()
        expect(screen.queryByRole('alert')).toBeNull()
    })
})
