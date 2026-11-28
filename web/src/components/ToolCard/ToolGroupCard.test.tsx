import { useCallback, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentReasoningBlock, ToolCallBlock } from '@/chat/types'
import { getToolGroupActionKind, type ToolGroupActionKind, type ToolGroupBlock, type ToolGroupItem } from '@/chat/toolGroups'
import {
    HappyChatProvider,
    type OlderHistoryLoadResult
} from '@/components/AssistantChat/context'
import { getToolGroupTiming, ToolGroupCard } from '@/components/ToolCard/ToolGroupCard'
import { I18nProvider } from '@/lib/i18n-context'

function makeToolBlock(
    id: string,
    name: string,
    input: unknown = {},
    state: ToolCallBlock['tool']['state'] = 'completed'
): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        invokedAt: null,
        tool: {
            id,
            name,
            state,
            input,
            createdAt: 1,
            startedAt: 1,
            completedAt: state === 'running' ? null : 2,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            result: { content: 'done' },
            permission: undefined,
        },
        children: [],
    }
}

function makeReasoningBlock(id: string, text: string): AgentReasoningBlock {
    return {
        kind: 'agent-reasoning',
        id,
        localId: null,
        createdAt: 1,
        text,
    }
}

function makeGroup(overrides: Partial<ToolGroupBlock> = {}): ToolGroupBlock {
    const tools = overrides.tools ?? [
        makeToolBlock('read-1', 'Read', { file_path: 'repo/src/a.ts' }),
        makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
        makeToolBlock('bash-2', 'Bash', { command: 'git status' }),
    ]
    const countsByKind: Record<ToolGroupActionKind, number> = {
        read: 0,
        search: 0,
        command: 0,
        mutation: 0,
        web: 0,
        other: 0,
    }
    for (const tool of tools) {
        countsByKind[getToolGroupActionKind(tool)] += 1
    }
    return {
        kind: 'tool-group',
        id: 'tool-group:read-1',
        createdAt: 1,
        invokedAt: null,
        firstToolId: tools[0].id,
        lastToolId: tools[tools.length - 1].id,
        tools,
        items: overrides.items ?? tools,
        defaultOpen: false,
        historyState: 'complete',
        needsOlderHistory: false,
        summary: {
            totalTools: tools.length,
            countsByKind,
            fileTargets: ['repo/src/a.ts'],
            commandTargets: ['bun test', 'git status'],
            searchTargets: [],
            urlTargets: [],
            otherTargets: [],
            errorCount: tools.filter((tool) => tool.tool.state === 'error').length,
            runningCount: tools.filter((tool) => tool.tool.state === 'running').length,
            pendingCount: tools.filter((tool) => tool.tool.state === 'pending').length,
        },
        ...overrides,
    }
}

function renderCard(block: ToolGroupBlock, options?: {
    loadOlder?: () => Promise<OlderHistoryLoadResult>
    hasMore?: boolean
    isSyncingTail?: boolean
    isLoadingMore?: boolean
}) {
    const loadOlderMessagesPreservingScroll = options?.loadOlder
        ?? vi.fn(async () => 'terminal-stop' as const)
    return render(
        <I18nProvider>
            <HappyChatProvider value={{
                api: {} as never,
                sessionId: 'session-1',
                metadata: { path: 'repo', host: 'local' },
                terminalToolDisplayMode: 'detailed',
                showSessionSummaryInChat: false,
                disabled: false,
                onRefresh: vi.fn(),
                hasMoreMessages: options?.hasMore ?? false,
                isSyncingTail: options?.isSyncingTail ?? false,
                isLoadingMoreMessages: options?.isLoadingMore ?? false,
                loadOlderMessagesPreservingScroll,
            }}>
                <ToolGroupCard block={block} metadata={{ path: 'repo', host: 'local' }} />
            </HappyChatProvider>
        </I18nProvider>
    )
}

describe('ToolGroupCard', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders a collapsed action-summary header with latest tool preview', () => {
        const view = renderCard(makeGroup())

        const toggle = screen.getByRole('button', { name: /ran 2 commands · read 1 file/i })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(screen.getByText('git status')).toBeInTheDocument()
        expect(screen.queryByText('src/a.ts')).not.toBeInTheDocument()

        // The tool-group colour setting tints the opened body of nested rows.
        expect(view.container.innerHTML).not.toContain('bg-[var(--app-tool-group-bg)]')
        fireEvent.click(toggle)
        expect(view.container.innerHTML).toContain('bg-[var(--app-tool-group-bg)]')
    })

    it('derives completed group timing from exec timestamps when present, falling back to hub clocks', () => {
        const first = makeToolBlock('read-1', 'Read')
        first.tool.startedAt = 1_000
        first.tool.completedAt = 2_000
        const second = makeToolBlock('bash-1', 'Bash')
        second.tool.startedAt = 1_500
        second.tool.completedAt = 4_000

        expect(getToolGroupTiming([first, second], 10_000)).toEqual({
            startedAt: 1_000,
            completedAt: 4_000,
            durationMs: 3_000,
            running: false,
        })

        // Prefer execution-machine timestamps when both tools carry complete exec pairs.
        first.tool.execStartedAt = 10_000
        first.tool.execCompletedAt = 10_500
        second.tool.execStartedAt = 10_600
        second.tool.execCompletedAt = 11_800
        expect(getToolGroupTiming([first, second], 20_000)).toEqual({
            startedAt: 10_000,
            completedAt: 11_800,
            durationMs: 1_800,
            running: false,
        })

        // Tolerate individual missing completedAt instead of blanking the whole group.
        const missingEnd = makeToolBlock('read-2', 'Read')
        missingEnd.tool.startedAt = 1_000
        missingEnd.tool.completedAt = null
        const withEnd = makeToolBlock('bash-2', 'Bash')
        withEnd.tool.startedAt = 1_200
        withEnd.tool.completedAt = 3_500
        expect(getToolGroupTiming([missingEnd, withEnd], 10_000).durationMs).toBe(2_500)
    })

    it('shows live duration, spinner, and running tool preview while running', () => {
        const startedAt = Date.now() - 5_000
        const completed = makeToolBlock('read-1', 'Read', { file_path: 'repo/src/a.ts' })
        completed.tool.startedAt = startedAt
        completed.tool.completedAt = startedAt + 1_000
        const running = makeToolBlock('bash-1', 'Bash', { command: 'bun run test' }, 'running')
        running.tool.startedAt = startedAt + 1_000
        const running2 = makeToolBlock('bash-2', 'Bash', { command: 'bun run build' }, 'running')
        running2.tool.startedAt = startedAt + 1_500

        const view = renderCard(makeGroup({ tools: [completed, running, running2] }))

        expect(within(view.container).getByLabelText('Running')).toBeInTheDocument()
        expect(screen.getByText('2 running')).toBeInTheDocument()
        expect(screen.getByText(/bun run build/)).toBeInTheDocument()
        expect(screen.getByText(/^\d+\.\ds$/)).toBeInTheDocument()
        expect(screen.queryByText('Started')).not.toBeInTheDocument()

        fireEvent.click(within(view.container).getByRole('button', { expanded: false }))
        expect(screen.getByText('Started')).toBeInTheDocument()
        expect(screen.getByText('Duration')).toBeInTheDocument()
        expect(screen.queryByText('Finished')).not.toBeInTheDocument()
    })

    it('highlights failed count in red and previews the failed tool over later completed tools', () => {
        const first = makeToolBlock('read-1', 'Read', { file_path: 'repo/src/a.ts' })
        const failed = makeToolBlock('bash-fail', 'Bash', { command: 'bun test --fail' }, 'error')
        const last = makeToolBlock('read-2', 'Read', { file_path: 'repo/src/b.ts' })

        renderCard(makeGroup({ tools: [first, failed, last] }))

        expect(screen.getByText('1 failed')).toBeInTheDocument()
        expect(screen.getByText('bun test --fail')).toBeInTheDocument()
    })

    it('shows final duration on the collapsed row and full timing once opened after every tool finishes', () => {
        const startedAt = Date.now() - 4_000
        const first = makeToolBlock('read-1', 'Read')
        first.tool.startedAt = startedAt
        first.tool.completedAt = startedAt + 1_000
        const second = makeToolBlock('bash-1', 'Bash')
        second.tool.startedAt = startedAt + 1_000
        second.tool.completedAt = startedAt + 2_500
        const third = makeToolBlock('bash-2', 'Bash')
        third.tool.startedAt = startedAt + 2_500
        third.tool.completedAt = startedAt + 4_000

        const view = renderCard(makeGroup({ tools: [first, second, third] }))

        expect(screen.getByText('4.0s')).toBeInTheDocument()
        expect(screen.queryByText('Started')).not.toBeInTheDocument()

        fireEvent.click(within(view.container).getByRole('button', { expanded: false }))
        expect(screen.getByText('Started')).toBeInTheDocument()
        expect(screen.getByText('Finished')).toBeInTheDocument()
        expect(screen.getByText('Duration')).toBeInTheDocument()
        expect(screen.getAllByText('4.0s').length).toBeGreaterThan(0)
    })

    it('expands to show interleaved tools and inline-expandable reasoning rows, and opens tool detail dialog', async () => {
        const t1 = makeToolBlock('read-1', 'Read', { file_path: 'repo/src/a.ts' })
        const r1 = makeReasoningBlock('reason-1', '**Inspecting imports**\n\nDetailed reasoning body here.')
        const t2 = makeToolBlock('bash-1', 'Bash', { command: 'bun test' })
        const items: ToolGroupItem[] = [t1, r1, t2]

        const view = renderCard(makeGroup({ tools: [t1, t2], items }))
        const groupToggle = within(view.container).getByRole('button', { name: /ran 1 command · read 1 file/i })

        expect(view.container.querySelector('.pw-plus[data-state="closed"]')).toBeInTheDocument()
        fireEvent.click(groupToggle)
        expect(groupToggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('src/a.ts')).toBeInTheDocument()
        expect(screen.getByText('Inspecting imports')).toBeInTheDocument()
        expect(screen.queryByText('Detailed reasoning body here.')).not.toBeInTheDocument()

        // Clicking the inline reasoning row expands its markdown body in place.
        fireEvent.click(screen.getByRole('button', { name: /reasoning.*inspecting imports/i }))
        expect(screen.getByText('Detailed reasoning body here.')).toBeInTheDocument()

        // Clicking a tool row opens the detail dialog.
        const firstToolButton = within(view.container)
            .getAllByRole('button')
            .find((button) => button.textContent?.includes('src/a.ts'))
        expect(firstToolButton).toBeDefined()
        fireEvent.click(firstToolButton!)

        await waitFor(() => {
            expect(screen.getByRole('dialog')).toBeInTheDocument()
        })
        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getAllByText('Input').length).toBeGreaterThan(0)
        expect(within(dialog).getAllByText('Result').length).toBeGreaterThan(0)
        expect(within(dialog).getByRole('heading').parentElement).toHaveClass('text-left')
        expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveClass('top-2')
    })

    it('renders structured Codex exploration rows inside expanded groups', () => {
        const tools = [
            makeToolBlock('codex-read', 'CodexBash', {
                command: 'cat package.json',
                command_actions: [{
                    type: 'read',
                    command: 'cat package.json',
                    name: 'package.json',
                    path: '/repo/package.json'
                }]
            }),
            makeToolBlock('codex-search', 'CodexBash', {
                command: 'rg nativeTitle web/src',
                command_actions: [{
                    type: 'search',
                    command: 'rg nativeTitle web/src',
                    query: 'nativeTitle',
                    path: 'web/src'
                }]
            }),
            makeToolBlock('codex-git', 'CodexBash', {
                command: 'git log -n 3',
                command_actions: [{ type: 'unknown', command: 'git log -n 3' }]
            })
        ]
        const view = renderCard(makeGroup({ tools, defaultOpen: true }))

        expect(within(view.container).getByRole('button', { name: /ran 1 command · read 1 file · searched 1 time/i }))
            .toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('Read')).toBeInTheDocument()
        expect(screen.getByText('package.json')).toBeInTheDocument()
        expect(screen.getByText('Search')).toBeInTheDocument()
        expect(screen.getByText('nativeTitle in web/src')).toBeInTheDocument()
    })

    it('windows very long groups with Show earlier and a bottom Collapse control', () => {
        const tools = Array.from({ length: 20 }, (_, index) => (
            makeToolBlock(`tool-${index + 1}`, 'Bash', { command: `echo step-${index + 1}` })
        ))
        renderCard(makeGroup({ tools }))

        const headerToggle = screen.getByRole('button', { name: /ran 20 commands/i })
        fireEvent.click(headerToggle)

        expect(screen.getByRole('button', { name: 'Show 5 earlier' })).toBeInTheDocument()
        expect(screen.queryByText('echo step-1')).not.toBeInTheDocument()
        expect(screen.getByText('echo step-20')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Show 5 earlier' }))
        expect(screen.getByText('echo step-1')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
        expect(headerToggle).toHaveAttribute('aria-expanded', 'false')
    })

    it('auto-loads older history after expand when the group is incomplete', async () => {
        const loadOlder = vi.fn()

        function Harness() {
            const loadOlderMessagesPreservingScroll = useCallback(async () => {
                loadOlder()
                return 'terminal-stop' as const
            }, [])

            return (
                <I18nProvider>
                    <HappyChatProvider value={{
                        api: {} as never,
                        sessionId: 'session-1',
                        metadata: { path: 'repo', host: 'local' },
                        terminalToolDisplayMode: 'detailed',
                        showSessionSummaryInChat: false,
                        disabled: false,
                        onRefresh: vi.fn(),
                        hasMoreMessages: true,
                        isSyncingTail: false,
                        isLoadingMoreMessages: false,
                        loadOlderMessagesPreservingScroll,
                    }}>
                        <ToolGroupCard
                            block={makeGroup({
                                id: 'tool-group:bash-1',
                                historyState: 'needs-older-history',
                                needsOlderHistory: true,
                            })}
                            metadata={{ path: 'repo', host: 'local' }}
                        />
                    </HappyChatProvider>
                </I18nProvider>
            )
        }

        const view = render(<Harness />)
        const groupToggle = within(view.container).getByRole('button', { name: /ran 2 commands/i })

        fireEvent.click(groupToggle)

        await waitFor(() => {
            expect(loadOlder).toHaveBeenCalledTimes(1)
        })
        await waitFor(() => {
            expect(screen.getByText('Earlier tool activity is unavailable.')).toBeInTheDocument()
        })
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(loadOlder).toHaveBeenCalledTimes(1)
    })

    it('waits for tail synchronization after a transient stop, then retries', async () => {
        const loadOlder = vi.fn()
        let releaseTailSync: (() => void) | null = null

        function Harness() {
            const [isSyncingTail, setIsSyncingTail] = useState(false)
            releaseTailSync = () => setIsSyncingTail(false)

            const loadOlderMessagesPreservingScroll = useCallback(async () => {
                loadOlder()
                if (loadOlder.mock.calls.length === 1) {
                    setIsSyncingTail(true)
                    return 'transient-stop' as const
                }
                return 'terminal-stop' as const
            }, [])

            return (
                <I18nProvider>
                    <HappyChatProvider value={{
                        api: {} as never,
                        sessionId: 'session-1',
                        metadata: { path: 'repo', host: 'local' },
                        terminalToolDisplayMode: 'detailed',
                        showSessionSummaryInChat: false,
                        disabled: false,
                        onRefresh: vi.fn(),
                        hasMoreMessages: true,
                        isSyncingTail,
                        isLoadingMoreMessages: false,
                        loadOlderMessagesPreservingScroll,
                    }}>
                        <ToolGroupCard
                            block={makeGroup({
                                id: 'tool-group:bash-1',
                                historyState: 'needs-older-history',
                                needsOlderHistory: true,
                            })}
                            metadata={{ path: 'repo', host: 'local' }}
                        />
                    </HappyChatProvider>
                </I18nProvider>
            )
        }

        const view = render(<Harness />)
        fireEvent.click(within(view.container).getByRole('button', { name: /ran 2 commands/i }))

        await waitFor(() => {
            expect(loadOlder).toHaveBeenCalledTimes(1)
        })
        expect(screen.queryByText('Earlier tool activity is unavailable.')).not.toBeInTheDocument()

        await act(async () => {
            releaseTailSync?.()
        })

        await waitFor(() => {
            expect(loadOlder).toHaveBeenCalledTimes(2)
        })
        await waitFor(() => {
            expect(screen.getByText('Earlier tool activity is unavailable.')).toBeInTheDocument()
        })
    })

    it('continues hydrating incomplete history across multiple page loads', async () => {
        let loadCount = 0

        function Harness() {
            const [isLoadingMore, setIsLoadingMore] = useState(false)
            const [hasMore, setHasMore] = useState(true)
            const loadOlderMessagesPreservingScroll = useCallback(() => {
                const shouldContinue = loadCount === 0
                loadCount += 1
                setIsLoadingMore(true)
                return new Promise<OlderHistoryLoadResult>((resolve) => {
                    setTimeout(() => {
                        setIsLoadingMore(false)
                        if (!shouldContinue) {
                            setHasMore(false)
                        }
                        resolve(shouldContinue ? 'loaded' : 'terminal-stop')
                    }, 0)
                })
            }, [])

            return (
                <I18nProvider>
                    <HappyChatProvider value={{
                        api: {} as never,
                        sessionId: 'session-1',
                        metadata: { path: 'repo', host: 'local' },
                        terminalToolDisplayMode: 'detailed',
                        showSessionSummaryInChat: false,
                        disabled: false,
                        onRefresh: vi.fn(),
                        hasMoreMessages: hasMore,
                        isSyncingTail: false,
                        isLoadingMoreMessages: isLoadingMore,
                        loadOlderMessagesPreservingScroll,
                    }}>
                        <ToolGroupCard
                            block={makeGroup({
                                id: 'tool-group:bash-1',
                                historyState: 'needs-older-history',
                                needsOlderHistory: true,
                            })}
                            metadata={{ path: 'repo', host: 'local' }}
                        />
                    </HappyChatProvider>
                </I18nProvider>
            )
        }

        const view = render(<Harness />)
        const groupToggle = within(view.container).getByRole('button', { name: /ran 2 commands/i })

        fireEvent.click(groupToggle)

        await waitFor(() => {
            expect(loadCount).toBe(2)
        })
        await waitFor(() => {
            expect(screen.getByText('Earlier tool activity is unavailable.')).toBeInTheDocument()
        })
    })

    it('waits for an in-flight thread pagination to finish before retrying hydration', async () => {
        const loadOlder = vi.fn(async () => 'terminal-stop' as const)
        let releaseThreadLoad: (() => void) | null = null

        function Harness() {
            const [hasMore, setHasMore] = useState(true)
            const [isLoadingMore, setIsLoadingMore] = useState(true)

            releaseThreadLoad = () => setIsLoadingMore(false)

            const loadOlderMessagesPreservingScroll = useCallback(async () => {
                loadOlder()
                setHasMore(false)
                return 'terminal-stop' as const
            }, [])

            return (
                <I18nProvider>
                    <HappyChatProvider value={{
                        api: {} as never,
                        sessionId: 'session-1',
                        metadata: { path: 'repo', host: 'local' },
                        terminalToolDisplayMode: 'detailed',
                        showSessionSummaryInChat: false,
                        disabled: false,
                        onRefresh: vi.fn(),
                        hasMoreMessages: hasMore,
                        isSyncingTail: false,
                        isLoadingMoreMessages: isLoadingMore,
                        loadOlderMessagesPreservingScroll,
                    }}>
                        <ToolGroupCard
                            block={makeGroup({
                                id: 'tool-group:bash-1',
                                historyState: 'needs-older-history',
                                needsOlderHistory: true,
                            })}
                            metadata={{ path: 'repo', host: 'local' }}
                        />
                    </HappyChatProvider>
                </I18nProvider>
            )
        }

        const view = render(<Harness />)
        const groupToggle = within(view.container).getByRole('button', { name: /ran 2 commands/i })

        fireEvent.click(groupToggle)

        expect(loadOlder).not.toHaveBeenCalled()
        expect(screen.queryByText('Earlier tool activity is unavailable.')).not.toBeInTheDocument()

        await act(async () => {
            releaseThreadLoad?.()
        })

        await waitFor(() => {
            expect(loadOlder).toHaveBeenCalledTimes(1)
        })
        await waitFor(() => {
            expect(screen.getByText('Earlier tool activity is unavailable.')).toBeInTheDocument()
        })
    })
})
