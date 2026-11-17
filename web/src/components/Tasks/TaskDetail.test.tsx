import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import { AppContextProvider } from '@/lib/app-context'
import { I18nProvider } from '@/lib/i18n-context'
import { describeToolRequest } from './TaskDetail'
import { TaskDetailPanel } from './TaskDetailPanel'
import { useTaskLifecycle } from './useTaskLifecycle'

vi.mock('@tanstack/react-router', () => ({
    Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>
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
        prompt: 'Fix the parser, carefully.',
        column: 'blocked',
        machineId: 'box-1',
        workdir: '/srv/repo',
        isolation: 'worktree',
        worktreeName: null,
        baseRef: 'main',
        branch: 'hapi-0821-abcd',
        worktreePath: '/srv/repo-worktrees/0821-abcd',
        spawn: { flavor: 'claude' },
        currentSessionId: 'sess-1',
        lastRunId: 'run-1',
        lastRunStatus: 'running',
        lastError: null,
        pullRequest: null,
        archivedAt: null,
        createdAt: 1,
        updatedAt: 1,
        seq: 0,
        ...overrides
    }
}

const PENDING_EDIT = {
    'req-1': {
        tool: 'Edit',
        arguments: { file_path: '/srv/repo-worktrees/0821-abcd/parser.py', old_string: 'a', new_string: 'b' },
        createdAt: 1
    }
}

function makeApi(task: Task, overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
    return {
        getTasks: vi.fn(async () => ({ tasks: [task], counts: { [task.column]: 1 } })),
        getMachines: vi.fn(async () => ({ machines: [{ id: 'box-1', metadata: { displayName: 'Box' } }] })),
        getSessions: vi.fn(async () => ({
            sessions: [{ id: 'sess-1', pendingRequestsCount: 1 }]
        })),
        getTask: vi.fn(async () => ({
            task,
            runs: [
                { id: 'run-1', taskId: task.id, sessionId: 'sess-1', status: 'running', origin: 'user', baseRef: 'main', baseCommit: null, branch: task.branch, worktreePath: task.worktreePath, startedAt: 1_700_000_000_000, endedAt: null, error: null },
                { id: 'run-0', taskId: task.id, sessionId: null, status: 'failed', origin: 'user', baseRef: 'main', baseCommit: null, branch: null, worktreePath: null, startedAt: 1_699_000_000_000, endedAt: 1_699_000_100_000, error: 'runner offline' }
            ]
        })),
        getSession: vi.fn(async () => ({
            session: { id: 'sess-1', agentState: { requests: PENDING_EDIT } }
        })),
        approvePermission: vi.fn(async () => {}),
        setPermissionMode: vi.fn(async () => {}),
        denyPermission: vi.fn(async () => {}),
        cancelTask: vi.fn(async () => ({ task })),
        startTask: vi.fn(async () => ({ task })),
        moveTask: vi.fn(async () => ({ task })),
        ...overrides
    } as unknown as ApiClient
}

function Harness(props: { api: ApiClient }) {
    const lifecycle = useTaskLifecycle(props.api)
    const [open, setOpen] = useState(true)
    return open
        ? <TaskDetailPanel api={props.api} taskId="task-1" lifecycle={lifecycle} onClose={() => setOpen(false)} />
        : null
}

function renderPanel(api: ApiClient) {
    return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <AppContextProvider value={{ api, token: 't', baseUrl: 'http://localhost' }}>
                <I18nProvider>
                    <Harness api={api} />
                </I18nProvider>
            </AppContextProvider>
        </QueryClientProvider>
    )
}

async function openDetail() {
    return await screen.findByRole('dialog')
}

/** The pending-request block arrives with the session query, one hop after the panel. */
async function openDetailWithRequests() {
    const panel = await openDetail()
    await within(panel).findByText('The agent is waiting on you')
    return panel
}

describe('describeToolRequest', () => {
    it('prefers the argument that says the most about the request', () => {
        expect(describeToolRequest('Bash', { command: 'rm -rf node_modules', cwd: '/srv' }))
            .toBe('rm -rf node_modules')
        expect(describeToolRequest('Edit', { file_path: '/srv/a.py', old_string: 'x' }))
            .toBe('/srv/a.py')
        expect(describeToolRequest('Grep', { pattern: 'TODO' })).toBe('TODO')
    })

    it('returns null when nothing readable is there', () => {
        expect(describeToolRequest('Weird', {})).toBeNull()
        expect(describeToolRequest('Weird', null)).toBeNull()
        expect(describeToolRequest('Weird', { count: 3 })).toBeNull()
    })
})

describe('TaskDetail', () => {
    it('shows the task in full', async () => {
        renderPanel(makeApi(makeTask()))
        const panel = await openDetail()

        expect(within(panel).getByText('Fix the parser, carefully.')).toBeTruthy()
        expect(within(panel).getByText('hapi-0821-abcd')).toBeTruthy()
        expect(within(panel).getByText('/srv/repo-worktrees/0821-abcd')).toBeTruthy()
    })

    it('surfaces what the agent is waiting on', async () => {
        renderPanel(makeApi(makeTask()))
        const panel = await openDetailWithRequests()

        expect(within(panel).getByText('Edit')).toBeTruthy()
        // The gist tells you what it wants to touch without opening the chat.
        expect(within(panel).getByText('/srv/repo-worktrees/0821-abcd/parser.py')).toBeTruthy()
    })

    it('approves for the session without opening the chat', async () => {
        // Claude's handler ignores `decision`; only `allowTools` keeps the
        // promise of "allows this tool for the rest of the session".
        const api = makeApi(makeTask())
        renderPanel(api)
        const panel = await openDetailWithRequests()

        fireEvent.click(within(panel).getByRole('button', { name: 'Approve' }))
        await waitFor(() => expect(api.approvePermission).toHaveBeenCalledWith(
            'sess-1', 'req-1', { allowTools: ['Edit'] }
        ))
    })

    it('approves for the session with a decision on agents other than Claude', async () => {
        const api = makeApi(makeTask({ spawn: { flavor: 'codex' } }))
        renderPanel(api)
        const panel = await openDetailWithRequests()

        fireEvent.click(within(panel).getByRole('button', { name: 'Approve' }))
        await waitFor(() => expect(api.approvePermission).toHaveBeenCalledWith(
            'sess-1', 'req-1', { decision: 'approved_for_session' }
        ))
    })

    it('says why an answer did not go through, in the hub\'s words', async () => {
        const api = makeApi(makeTask(), {
            approvePermission: vi.fn(async () => {
                throw new ApiError('HTTP 409 Conflict: {"error":"Request already answered"}', 409, undefined, '{"error":"Request already answered"}')
            })
        })
        renderPanel(api)
        const panel = await openDetailWithRequests()

        fireEvent.click(within(panel).getByRole('button', { name: 'Approve' }))
        expect((await within(panel).findByRole('alert')).textContent).toBe('Request already answered')
    })

    it('shows a failed lifecycle action inside the panel', async () => {
        const api = makeApi(makeTask({ column: 'blocked' }), {
            startTask: vi.fn(async () => {
                throw new ApiError('HTTP 502 Bad Gateway: {"error":"runner offline"}', 502, 'spawn_failed', '{"error":"runner offline","code":"spawn_failed"}')
            })
        })
        renderPanel(api)
        const panel = await openDetail()

        fireEvent.click(within(panel).getByRole('button', { name: 'Start' }))
        expect((await within(panel).findByRole('alert')).textContent).toBe('runner offline')
    })

    it('refuses without opening the chat', async () => {
        const api = makeApi(makeTask())
        renderPanel(api)
        const panel = await openDetailWithRequests()

        fireEvent.click(within(panel).getByRole('button', { name: 'Refuse' }))
        await waitFor(() => expect(api.denyPermission).toHaveBeenCalledWith(
            'sess-1', 'req-1', { decision: 'denied' }
        ))
    })

    it('shows no approval section when nothing is pending', async () => {
        const api = makeApi(makeTask({ column: 'running' }), {
            getSession: vi.fn(async () => ({ session: { id: 'sess-1', agentState: { requests: {} } } }))
        })
        renderPanel(api)
        const panel = await openDetail()

        expect(within(panel).queryByText('The agent is waiting on you')).toBeNull()
    })

    it('lists run history, newest first, with failure reasons', async () => {
        renderPanel(makeApi(makeTask()))
        const panel = await openDetail()

        expect(within(panel).getByText('Run history')).toBeTruthy()
        expect(within(panel).getByText('running')).toBeTruthy()
        expect(within(panel).getByText('failed')).toBeTruthy()
        expect(within(panel).getByText('runner offline')).toBeTruthy()
    })

    it('offers Stop on a live task', async () => {
        const api = makeApi(makeTask({ column: 'running' }))
        renderPanel(api)
        const panel = await openDetail()

        fireEvent.click(within(panel).getByRole('button', { name: 'Stop' }))
        await waitFor(() => expect(api.cancelTask).toHaveBeenCalledWith('task-1'))
    })

    it('offers Start on a blocked task, not Stop', async () => {
        // `blocked` is a fault state — the agent is already gone, so there is
        // nothing to stop and every reason to allow a retry. Offering Stop
        // here left the task with no way forward at all.
        const api = makeApi(makeTask({ column: 'blocked' }))
        renderPanel(api)
        const panel = await openDetail()

        expect(within(panel).queryByRole('button', { name: 'Stop' })).toBeNull()
        fireEvent.click(within(panel).getByRole('button', { name: 'Start' }))
        await waitFor(() => expect(api.startTask).toHaveBeenCalledWith('task-1'))
    })

    it('moves the task from the panel', async () => {
        const api = makeApi(makeTask())
        renderPanel(api)
        const panel = await openDetail()

        fireEvent.change(within(panel).getByLabelText('Status'), { target: { value: 'review' } })
        await waitFor(() => expect(api.moveTask).toHaveBeenCalledWith('task-1', 'review'))
    })

    it('switches the live permission mode from the panel', async () => {
        // The point of this control: a card that keeps stopping to ask can be
        // set to run ahead without opening the chat.
        const api = makeApi(makeTask())
        renderPanel(api)
        const panel = await openDetail()

        fireEvent.change(within(panel).getByLabelText('Permissions'), { target: { value: 'auto' } })
        await waitFor(() => expect(api.setPermissionMode).toHaveBeenCalledWith('sess-1', 'auto'))
    })

    it('shows the live mode reported by the session, not the task default', async () => {
        const api = makeApi(makeTask({ spawn: { flavor: 'claude', permissionMode: 'default' } }), {
            getSession: vi.fn(async () => ({
                session: { id: 'sess-1', permissionMode: 'acceptEdits', agentState: { requests: {} } }
            }))
        })
        renderPanel(api)
        const panel = await openDetail()

        await waitFor(() =>
            expect((within(panel).getByLabelText('Permissions') as HTMLSelectElement).value).toBe('acceptEdits'))
    })

    it('renames the task from the panel', async () => {
        const renamed = makeTask({ title: 'Parse it right' })
        const api = makeApi(makeTask(), { updateTask: vi.fn(async () => ({ task: renamed })) })
        renderPanel(api)
        const panel = await openDetail()

        fireEvent.click(within(panel).getByRole('button', { name: 'Fix the parser' }))
        const input = within(panel).getByLabelText('Task title')
        fireEvent.change(input, { target: { value: '  Parse it right  ' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('task-1', { title: 'Parse it right' }))
        await waitFor(() => expect(within(panel).queryByLabelText('Task title')).toBeNull())
    })

    it('closes again', async () => {
        renderPanel(makeApi(makeTask()))
        const panel = await openDetail()

        fireEvent.click(within(panel).getByRole('button', { name: 'Close' }))
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })

    it('is a labelled modal dialog that Escape closes', async () => {
        renderPanel(makeApi(makeTask()))
        const panel = await openDetail()

        expect(panel.getAttribute('aria-modal')).toBe('true')
        expect(screen.getByRole('dialog', { name: 'Fix the parser' })).toBe(panel)
        fireEvent.keyDown(panel, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })

    it('names a running task once rather than "Running · running"', async () => {
        renderPanel(makeApi(makeTask({ column: 'running', lastRunStatus: 'running' })))
        const panel = await openDetail()

        expect(within(panel).getByText('Running', { selector: 'p.pw-eyebrow' })).toBeTruthy()
    })

    it('still adds the run state when it says something the column does not', async () => {
        renderPanel(makeApi(makeTask({ column: 'review', lastRunStatus: 'running' })))
        const panel = await openDetail()

        expect(within(panel).getByText('Review · running', { selector: 'p.pw-eyebrow' })).toBeTruthy()
    })

    it('marks the lifecycle step, and shows a blocked card as stuck at Running', async () => {
        renderPanel(makeApi(makeTask({ column: 'blocked' })))
        const panel = await openDetail()

        const step = within(panel).getByRole('listitem', { current: 'step' })
        expect(within(step).getByText('Running')).toBeTruthy()
        expect(within(step).getByText('Blocked')).toBeTruthy()
    })
})
