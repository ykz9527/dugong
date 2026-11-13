import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { AppContextProvider } from '@/lib/app-context'
import { I18nProvider } from '@/lib/i18n-context'
import { TaskSwitcher, collectArchivedTasks, countAttentionTasks, groupTasksForSwitcher } from './TaskSwitcher'

// Rows are links; a full router is more machinery than these assertions need.
vi.mock('@tanstack/react-router', () => ({
    Link: ({ children, to, params, onClick, resetScroll: _resetScroll, ...rest }: {
        children: React.ReactNode
        to: string
        params?: { sessionId?: string }
        onClick?: (event: React.MouseEvent) => void
        resetScroll?: boolean
    }) => (
        <a
            href={params?.sessionId ? `/sessions/${params.sessionId}` : to}
            // jsdom refuses real navigation and logs it; the assertions are
            // about the href and the click handler, not about leaving the page.
            onClick={(event) => { event.preventDefault(); onClick?.(event) }}
            {...rest}
        >
            {children}
        </a>
    )
}))

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        namespace: 'default',
        title: 'Fix the parser',
        prompt: 'Fix it.',
        column: 'backlog',
        machineId: 'box-1',
        workdir: '/srv/repo',
        isolation: 'worktree',
        worktreeName: null,
        baseRef: null,
        branch: null,
        worktreePath: null,
        spawn: { flavor: 'claude' },
        currentSessionId: null,
        lastRunId: null,
        lastRunStatus: null,
        lastError: null,
        pullRequest: null,
        archivedAt: null,
        createdAt: 1,
        updatedAt: 1,
        seq: 0,
        ...overrides
    }
}

function makeApi(tasks: Task[], sessions: unknown[] = []): ApiClient {
    return {
        getTasks: vi.fn(async () => ({ tasks, counts: {} })),
        getSessions: vi.fn(async () => ({ sessions })),
        getMachines: vi.fn(async () => ({ machines: [] })),
        getWorkspaceUsers: vi.fn(async () => ({ workspaceUsers: [] })),
        getTask: vi.fn(async (taskId: string) => ({
            task: tasks.find((task) => task.id === taskId),
            runs: []
        })),
        getSession: vi.fn(async () => ({ session: null })),
        moveTask: vi.fn(async () => ({ task: tasks[0] })),
        archiveTask: vi.fn(async () => ({ task: tasks[0] })),
        unarchiveTask: vi.fn(async () => ({ task: tasks[0] })),
        deleteTask: vi.fn(async () => ({ ok: true }))
    } as unknown as ApiClient
}

function renderSwitcher(api: ApiClient, selectedSessionId: string | null = null, onNavigate?: () => void) {
    return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <AppContextProvider value={{ api, token: 't', baseUrl: 'http://localhost' }}>
                <I18nProvider>
                    <TaskSwitcher api={api} selectedSessionId={selectedSessionId} onNavigate={onNavigate} />
                </I18nProvider>
            </AppContextProvider>
        </QueryClientProvider>
    )
}

async function findRow(title: string): Promise<HTMLElement> {
    return (await screen.findByText(title)).closest('[data-task-id]') as HTMLElement
}

describe('groupTasksForSwitcher', () => {
    it('leads with the columns that wait on a human', () => {
        const groups = groupTasksForSwitcher([
            makeTask({ id: 'a', column: 'done' }),
            makeTask({ id: 'b', column: 'running' }),
            makeTask({ id: 'c', column: 'review' }),
            makeTask({ id: 'd', column: 'blocked' })
        ])

        expect(groups.map((group) => group.column)).toEqual(['blocked', 'review', 'running', 'done'])
    })

    it('drops empty columns and orders each group newest first', () => {
        const groups = groupTasksForSwitcher([
            makeTask({ id: 'old', column: 'review', updatedAt: 10 }),
            makeTask({ id: 'new', column: 'review', updatedAt: 20 })
        ])

        expect(groups).toHaveLength(1)
        expect(groups[0]?.tasks.map((task) => task.id)).toEqual(['new', 'old'])
    })
})

describe('collectArchivedTasks', () => {
    it('keeps only archived cards, most recently archived first', () => {
        const archived = collectArchivedTasks([
            makeTask({ id: 'live' }),
            makeTask({ id: 'old', archivedAt: 10 }),
            makeTask({ id: 'new', archivedAt: 20 })
        ])

        expect(archived.map((task) => task.id)).toEqual(['new', 'old'])
    })
})

describe('countAttentionTasks', () => {
    it('counts only blocked and review', () => {
        expect(countAttentionTasks([
            makeTask({ id: 'a', column: 'blocked' }),
            makeTask({ id: 'b', column: 'review' }),
            makeTask({ id: 'c', column: 'running' }),
            makeTask({ id: 'd', column: 'done' })
        ])).toBe(2)
    })
})

describe('TaskSwitcher', () => {
    it('groups tasks under their column heading', async () => {
        renderSwitcher(makeApi([
            makeTask({ id: 'a', title: 'Parser work', column: 'review', currentSessionId: 'sess-a' }),
            makeTask({ id: 'b', title: 'Docs pass', column: 'running', currentSessionId: 'sess-b' })
        ]))

        const review = (await screen.findByRole('heading', { name: /Review/ })).closest('section') as HTMLElement
        expect(within(review).getByText('Parser work')).toBeTruthy()
        expect(within(review).queryByText('Docs pass')).toBeNull()
    })

    it('links a row to the task\'s session', async () => {
        renderSwitcher(makeApi([
            makeTask({ id: 'a', title: 'Parser work', column: 'review', currentSessionId: 'sess-a' })
        ]))

        const row = (await screen.findByText('Parser work')).closest('a') as HTMLAnchorElement
        expect(row.getAttribute('href')).toBe('/sessions/sess-a')
    })

    it('marks the row of the session already open', async () => {
        renderSwitcher(makeApi([
            makeTask({ id: 'a', title: 'Parser work', column: 'review', currentSessionId: 'sess-a' }),
            makeTask({ id: 'b', title: 'Docs pass', column: 'review', currentSessionId: 'sess-b' })
        ]), 'sess-a')

        const open = (await screen.findByText('Parser work')).closest('a') as HTMLAnchorElement
        const other = (await screen.findByText('Docs pass')).closest('a') as HTMLAnchorElement
        expect(open.getAttribute('aria-current')).toBe('page')
        expect(other.getAttribute('aria-current')).toBeNull()
    })

    it('colours a row and its heading by column, loudest for review', async () => {
        renderSwitcher(makeApi([
            makeTask({ id: 'a', title: 'Parser work', column: 'review', currentSessionId: 'sess-a' }),
            makeTask({ id: 'b', title: 'Docs pass', column: 'backlog', currentSessionId: 'sess-b' })
        ]))

        const review = await findRow('Parser work')
        // Rows stay uncoloured; the column shows in the heading and the dot.
        expect(review.className).not.toContain('accent')
        expect(screen.getByRole('heading', { name: /Review/ }).className).toContain('text-[var(--app-accent)]')
        expect(screen.getByRole('heading', { name: /Backlog/ }).className).toContain('text-[var(--app-hint)]')

        const quiet = await findRow('Docs pass')
        expect(quiet.className).not.toContain('accent')
    })

    it('opens the detail panel for a task that never ran instead of a dead row', async () => {
        renderSwitcher(makeApi([makeTask({ id: 'a', title: 'Parser work', column: 'ready' })]))

        const row = await findRow('Parser work')
        expect(within(row).queryByRole('link')).toBeNull()
        fireEvent.click(within(row).getByText('Parser work'))

        const panel = await screen.findByRole('dialog')
        expect(within(panel).getByRole('button', { name: 'Start' })).toBeTruthy()
    })

    it('offers the workspace user picker, including managing the list', async () => {
        renderSwitcher(makeApi([makeTask({ id: 'a', title: 'Parser work', column: 'review' })]))

        const picker = await screen.findByLabelText('Show work belonging to')
        expect(within(picker).getByRole('option', { name: /Manage/ })).toBeTruthy()
    })

    it('keeps archived cards out of the way until asked for', async () => {
        renderSwitcher(makeApi([
            makeTask({ id: 'a', title: 'Parser work', column: 'review' }),
            makeTask({ id: 'b', title: 'Old chore', column: 'done', archivedAt: 5 })
        ]))

        await screen.findByText('Parser work')
        expect(screen.queryByText('Old chore')).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }))
        const row = await findRow('Old chore')
        // Restoring comes before moving: the row has no column select.
        expect(within(row).queryByRole('combobox')).toBeNull()
    })

    it('restores an archived card from its detail panel', async () => {
        const api = makeApi([makeTask({ id: 'b', title: 'Old chore', column: 'done', archivedAt: 5 })])
        renderSwitcher(api)

        fireEvent.click(await screen.findByRole('button', { name: 'Archived (1)' }))
        fireEvent.click(within(await findRow('Old chore')).getByRole('button', { name: 'Details' }))
        const panel = await screen.findByRole('dialog')
        expect(within(panel).queryByRole('button', { name: 'Archive' })).toBeNull()

        fireEvent.click(within(panel).getByRole('button', { name: 'Unarchive' }))
        await waitFor(() => expect(api.unarchiveTask).toHaveBeenCalledWith('b'))
    })

    it('archives a finished card from its detail panel', async () => {
        const api = makeApi([makeTask({ id: 'a', title: 'Parser work', column: 'done', currentSessionId: 'sess-a' })])
        renderSwitcher(api)

        fireEvent.click(within(await findRow('Parser work')).getByRole('button', { name: 'Details' }))
        const panel = await screen.findByRole('dialog')
        fireEvent.click(within(panel).getByRole('button', { name: 'Archive' }))

        await waitFor(() => expect(api.archiveTask).toHaveBeenCalledWith('a', {
            force: false,
            stopRun: false,
            keepWorktree: undefined,
            forceWorktree: false
        }))
    })

    it('deletes a card from its detail panel after a second press, then closes it', async () => {
        const api = makeApi([makeTask({ id: 'a', title: 'Parser work', column: 'backlog' })])
        renderSwitcher(api)

        fireEvent.click(within(await findRow('Parser work')).getByRole('button', { name: 'Details' }))
        const panel = await screen.findByRole('dialog')
        fireEvent.click(within(panel).getByRole('button', { name: 'Delete' }))
        expect(api.deleteTask).not.toHaveBeenCalled()

        fireEvent.click(within(panel).getByRole('button', { name: 'Confirm delete' }))
        await waitFor(() => expect(api.deleteTask).toHaveBeenCalledWith('a', { force: false, stopRun: false }))
        await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull())
    })

    it('shows the pending-request count of the row\'s session', async () => {
        renderSwitcher(makeApi(
            [makeTask({ id: 'a', title: 'Parser work', column: 'blocked', currentSessionId: 'sess-a' })],
            [{ id: 'sess-a', pendingRequestsCount: 2 }]
        ))

        const row = (await screen.findByText('Parser work')).closest('a') as HTMLElement
        expect(within(row).getByText('2')).toBeTruthy()
    })

    it('closes its host after a row navigates', async () => {
        const onNavigate = vi.fn()
        renderSwitcher(makeApi([
            makeTask({ id: 'a', title: 'Parser work', column: 'review', currentSessionId: 'sess-a' })
        ]), null, onNavigate)

        const row = (await screen.findByText('Parser work')).closest('a') as HTMLAnchorElement
        row.click()
        expect(onNavigate).toHaveBeenCalled()
    })

    it('moves a card to another column without leaving the conversation', async () => {
        const onNavigate = vi.fn()
        const api = makeApi([
            makeTask({ id: 'a', title: 'Parser work', column: 'review', currentSessionId: 'sess-a' })
        ])
        renderSwitcher(api, 'sess-a', onNavigate)

        const row = await findRow('Parser work')
        fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'done' } })

        await waitFor(() => expect(api.moveTask).toHaveBeenCalledWith('a', 'done'))
        // The select sits outside the link, so changing it is not a click on
        // the row.
        expect(onNavigate).not.toHaveBeenCalled()
    })

    it('leaves composing a card to the sidebar\'s plus button', async () => {
        renderSwitcher(makeApi([
            makeTask({ id: 'a', title: 'Parser work', column: 'review', currentSessionId: 'sess-a' })
        ]))

        await screen.findByText('Parser work')
        expect(screen.queryByRole('button', { name: /New task/ })).toBeNull()
    })
})
