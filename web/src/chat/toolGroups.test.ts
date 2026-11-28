import { describe, expect, it } from 'vitest'
import type { AgentReasoningBlock, ChatBlock, ToolCallBlock } from '@/chat/types'
import {
    buildVisibleChatBlocks,
    getToolGroupActionKind,
    getToolGroupItems,
    isEligibleForToolGrouping,
    isToolGroupBlock
} from '@/chat/toolGroups'

function makeToolBlock(
    id: string,
    name: string,
    input: unknown = {},
    overrides: Partial<ToolCallBlock> = {}
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
            state: 'completed',
            input,
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            result: null,
            permission: undefined,
        },
        children: [],
        ...overrides,
    }
}

function makeTextBlock(id: string, text = 'note'): ChatBlock {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 1,
        text,
    }
}

function makeReasoningBlock(id: string, text = 'Inspecting state'): AgentReasoningBlock {
    return {
        kind: 'agent-reasoning',
        id,
        localId: null,
        createdAt: 1,
        text,
    }
}

describe('getToolGroupActionKind', () => {
    it('classifies tools across Claude, Codex, and agy flavors', () => {
        expect(getToolGroupActionKind(makeToolBlock('read-1', 'Read'))).toBe('read')
        expect(getToolGroupActionKind(makeToolBlock('agy-read', 'view_file'))).toBe('read')
        expect(getToolGroupActionKind(makeToolBlock('grep-1', 'Grep'))).toBe('search')
        expect(getToolGroupActionKind(makeToolBlock('agy-find', 'Find by name'))).toBe('search')
        expect(getToolGroupActionKind(makeToolBlock('bash-1', 'Bash'))).toBe('command')
        expect(getToolGroupActionKind(makeToolBlock('shell-1', 'run_shell_command'))).toBe('command')
        expect(getToolGroupActionKind(makeToolBlock('codex-exec', 'exec_command'))).toBe('command')
        expect(getToolGroupActionKind(makeToolBlock('codex-shell', 'shell'))).toBe('command')
        expect(getToolGroupActionKind(makeToolBlock('edit-1', 'Edit'))).toBe('mutation')
        expect(getToolGroupActionKind(makeToolBlock('patch-1', 'apply_patch'))).toBe('mutation')
        expect(getToolGroupActionKind(makeToolBlock('agy-edit', 'Multi replace file content'))).toBe('mutation')
        expect(getToolGroupActionKind(makeToolBlock('agy-web', 'Read url content'))).toBe('web')
        expect(getToolGroupActionKind(makeToolBlock('mcp-1', 'mcp__github__list_issues'))).toBe('other')
    })

    it('classifies CodexBash by structured command_actions when purely exploration', () => {
        const read = makeToolBlock('cb-read', 'CodexBash', {
            command: 'cat package.json',
            command_actions: [{ type: 'read', command: 'cat package.json', name: 'package.json', path: '/repo/package.json' }]
        })
        const search = makeToolBlock('cb-search', 'CodexBash', {
            command: 'rg foo src',
            command_actions: [{ type: 'search', command: 'rg foo src', query: 'foo', path: 'src' }]
        })
        const git = makeToolBlock('cb-git', 'CodexBash', {
            command: 'git log --oneline',
            command_actions: [{ type: 'unknown', command: 'git log --oneline' }]
        })

        expect(getToolGroupActionKind(read)).toBe('read')
        expect(getToolGroupActionKind(search)).toBe('search')
        expect(getToolGroupActionKind(git)).toBe('command')
    })
})

describe('isEligibleForToolGrouping', () => {
    it('excludes interactive, subagent, and plan cards while allowing general CodexBash', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('read-1', 'Read'))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('codex-git', 'CodexBash', {
            command: 'git show HEAD',
            command_actions: [{ type: 'unknown', command: 'git show HEAD' }]
        }))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('task-1', 'Task'))).toBe(false)
        expect(isEligibleForToolGrouping(makeToolBlock('agent-1', 'Agent'))).toBe(false)
        expect(isEligibleForToolGrouping(makeToolBlock('plan-1', 'update_plan'))).toBe(false)
        expect(isEligibleForToolGrouping(makeToolBlock('ask-1', 'AskUserQuestion'))).toBe(false)
        expect(isEligibleForToolGrouping(makeToolBlock('perm-1', 'Bash', {}, {
            tool: {
                id: 'perm-1',
                name: 'Bash',
                state: 'pending',
                input: {},
                createdAt: 1,
                startedAt: null,
                completedAt: null,
                execStartedAt: null,
                execCompletedAt: null,
                description: null,
                permission: {
                    id: 'perm-1',
                    status: 'pending'
                }
            }
        }))).toBe(false)
    })

    it('keeps completed permissioned execution cards eligible for grouping', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('approved-1', 'Bash', {}, {
            tool: {
                id: 'approved-1',
                name: 'Bash',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                execStartedAt: null,
                execCompletedAt: null,
                description: null,
                permission: {
                    id: 'approved-1',
                    status: 'approved'
                }
            }
        }))).toBe(true)

        expect(isEligibleForToolGrouping(makeToolBlock('denied-1', 'Edit', {}, {
            tool: {
                id: 'denied-1',
                name: 'Edit',
                state: 'error',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                execStartedAt: null,
                execCompletedAt: null,
                description: null,
                permission: {
                    id: 'denied-1',
                    status: 'denied',
                    reason: 'blocked'
                }
            }
        }))).toBe(true)
    })

    it('keeps Codex permission milestones standalone after completion', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('codex-perm-1', 'CodexPermission', {}, {
            tool: {
                id: 'codex-perm-1',
                name: 'CodexPermission',
                state: 'completed',
                input: { tool: 'shell_command' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                execStartedAt: null,
                execCompletedAt: null,
                description: null,
                permission: {
                    id: 'codex-perm-1',
                    status: 'approved'
                }
            }
        }))).toBe(false)
    })
})

describe('buildVisibleChatBlocks', () => {
    it('keeps 1 or 2 pure tool calls standalone and folds at 3 or more', () => {
        const twoTools = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
        ], { hasMoreMessages: false })

        expect(twoTools).toHaveLength(2)
        expect(twoTools.every((block) => !isToolGroupBlock(block))).toBe(true)

        const threeTools = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
        ], { hasMoreMessages: false })

        expect(threeTools).toHaveLength(1)
        expect(isToolGroupBlock(threeTools[0])).toBe(true)
        if (!isToolGroupBlock(threeTools[0])) throw new Error('expected tool group')
        expect(threeTools[0].tools.map((tool) => tool.id)).toEqual(['read-1', 'bash-1', 'edit-1'])
        expect(threeTools[0].defaultOpen).toBe(false)
        expect(threeTools[0].summary.fileTargets).toEqual(['src/a.ts'])
        expect(threeTools[0].summary.commandTargets).toEqual(['bun test'])
    })

    it('folds mixed Codex exploration and general CodexBash commands together with interleaved reasoning', () => {
        const read = makeToolBlock('codex-read', 'CodexBash', {
            command: 'cat package.json',
            command_actions: [{ type: 'read', command: 'cat package.json', name: 'package.json', path: '/repo/package.json' }]
        })
        const gitLog = makeToolBlock('codex-git', 'CodexBash', {
            command: 'git log --oneline',
            command_actions: [{ type: 'unknown', command: 'git log --oneline' }]
        })
        const reasoning = makeReasoningBlock('r-1', 'Checking commit history')
        const gitShow = makeToolBlock('codex-show', 'CodexBash', {
            command: 'git show 2fa9cdd2',
            command_actions: [{ type: 'unknown', command: 'git show 2fa9cdd2' }]
        })
        const search = makeToolBlock('codex-search', 'CodexBash', {
            command: 'rg nativeTitle web/src',
            command_actions: [{ type: 'search', command: 'rg nativeTitle web/src', query: 'nativeTitle', path: 'web/src' }]
        })

        const visible = buildVisibleChatBlocks([read, gitLog, reasoning, gitShow, search], { hasMoreMessages: false })

        expect(visible).toHaveLength(1)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) throw new Error('expected tool group')
        expect(visible[0].tools.map((tool) => tool.id)).toEqual(['codex-read', 'codex-git', 'codex-show', 'codex-search'])
        expect(getToolGroupItems(visible[0]).map((item) => item.id)).toEqual([
            'codex-read',
            'codex-git',
            'r-1',
            'codex-show',
            'codex-search'
        ])
        expect(visible[0].summary.countsByKind).toEqual({
            read: 1,
            search: 1,
            command: 2,
            mutation: 0,
            web: 0,
            other: 0
        })
        expect(visible[0].summary.reasoningCount).toBe(1)
    })

    it('folds 2 tool calls when interleaved with reasoning, while leaving pure reasoning or 1-tool runs standalone', () => {
        const pureReasoning = buildVisibleChatBlocks([
            makeReasoningBlock('r-only', 'Just thinking'),
            makeTextBlock('reply', 'Here is the answer')
        ], { hasMoreMessages: false })
        expect(pureReasoning).toHaveLength(2)
        expect(pureReasoning.every((block) => !isToolGroupBlock(block))).toBe(true)

        const oneToolWithReasoning = buildVisibleChatBlocks([
            makeReasoningBlock('r-1', 'Let me read'),
            makeToolBlock('read-1', 'Read', { file_path: 'a.ts' }),
            makeTextBlock('reply', 'Done')
        ], { hasMoreMessages: false })
        expect(oneToolWithReasoning).toHaveLength(3)
        expect(oneToolWithReasoning.every((block) => !isToolGroupBlock(block))).toBe(true)

        const twoToolsWithReasoning = buildVisibleChatBlocks([
            makeReasoningBlock('r-1', 'Step 1'),
            makeToolBlock('bash-1', 'Bash', { command: 'ls' }),
            makeReasoningBlock('r-2', 'Step 2'),
            makeToolBlock('bash-2', 'Bash', { command: 'pwd' }),
            makeReasoningBlock('r-3', 'Summarizing'),
            makeTextBlock('reply', 'Final answer')
        ], { hasMoreMessages: false })

        expect(twoToolsWithReasoning).toHaveLength(2)
        expect(isToolGroupBlock(twoToolsWithReasoning[0])).toBe(true)
        expect(twoToolsWithReasoning[1].kind).toBe('agent-text')
        if (!isToolGroupBlock(twoToolsWithReasoning[0])) throw new Error('expected tool group')
        expect(twoToolsWithReasoning[0].tools.map((t) => t.id)).toEqual(['bash-1', 'bash-2'])
        expect(getToolGroupItems(twoToolsWithReasoning[0]).map((i) => i.id)).toEqual([
            'r-1', 'bash-1', 'r-2', 'bash-2', 'r-3'
        ])
    })

    it('absorbs CodexReasoning into activity groups and preserves its heading without counting it as a tool', () => {
        const reasoning = makeToolBlock('reasoning-1', 'CodexReasoning', { title: 'Inspecting authentication' })
        const visible = buildVisibleChatBlocks([
            reasoning,
            makeToolBlock('read-1', 'Read', { file_path: 'auth.ts' }),
            makeToolBlock('read-2', 'Read', { file_path: 'session.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(1)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) throw new Error('expected tool group')
        expect(visible[0].activityTitle).toBe('Inspecting authentication')
        expect(visible[0].tools.map((t) => t.id)).toEqual(['read-1', 'read-2'])
        expect(visible[0].summary.totalTools).toBe(2)
        expect(visible[0].summary.reasoningCount).toBe(1)
    })

    it('opens all tool groups by default when the collapse preference is disabled', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('bash-1', 'Bash', { command: 'ls' }),
            makeToolBlock('bash-2', 'Bash', { command: 'pwd' }),
            makeToolBlock('bash-3', 'Bash', { command: 'git status' }),
        ], { hasMoreMessages: false, codexExplorationCollapsed: false })

        expect(isToolGroupBlock(visible[0]) && visible[0].defaultOpen).toBe(true)
    })

    it('marks streamingReasoning only on a tail group whose last item is reasoning while session is thinking', () => {
        const blocks: ChatBlock[] = [
            makeToolBlock('t1', 'Read', { file_path: 'a.ts' }),
            makeToolBlock('t2', 'Read', { file_path: 'b.ts' }),
            makeReasoningBlock('r1', 'Synthesizing answer'),
        ]

        const active = buildVisibleChatBlocks(blocks, { hasMoreMessages: false, isSessionThinking: true })
        expect(isToolGroupBlock(active[0]) && active[0].streamingReasoning).toBe(true)

        const idle = buildVisibleChatBlocks(blocks, { hasMoreMessages: false, isSessionThinking: false })
        expect(isToolGroupBlock(idle[0]) && idle[0].streamingReasoning).toBe(false)

        const nonTail = buildVisibleChatBlocks([...blocks, makeTextBlock('final', 'Done')], {
            hasMoreMessages: false,
            isSessionThinking: true
        })
        expect(isToolGroupBlock(nonTail[0]) && nonTail[0].streamingReasoning).toBe(false)
    })

    it('keeps failed tools inside the group and counts errors', () => {
        const failed = makeToolBlock('bash-2', 'Bash', { command: 'bun test' })
        failed.tool.state = 'error'
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'a.ts' }),
            failed,
            makeToolBlock('edit-1', 'Edit', { file_path: 'a.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(1)
        expect(isToolGroupBlock(visible[0]) && visible[0].summary.errorCount).toBe(1)
    })

    it('splits groups on assistant text, interactive cards, and pending permissions', () => {
        const interactive = makeToolBlock('ask-1', 'request_user_input')
        const pendingPerm = makeToolBlock('perm-pending', 'Bash', { command: 'rm -rf tmp' })
        pendingPerm.tool.state = 'pending'
        pendingPerm.tool.permission = { id: 'perm-pending', status: 'pending' }

        const visible = buildVisibleChatBlocks([
            makeToolBlock('r1', 'Read', { file_path: 'a.ts' }),
            makeToolBlock('r2', 'Read', { file_path: 'b.ts' }),
            makeToolBlock('r3', 'Read', { file_path: 'c.ts' }),
            makeTextBlock('text-1', 'located the issue'),
            makeToolBlock('e1', 'Edit', { file_path: 'a.ts' }),
            makeToolBlock('e2', 'Edit', { file_path: 'b.ts' }),
            makeToolBlock('e3', 'Edit', { file_path: 'c.ts' }),
            interactive,
            pendingPerm,
            makeToolBlock('b1', 'Bash', { command: 'ls' }),
            makeToolBlock('b2', 'Bash', { command: 'pwd' }),
            makeToolBlock('b3', 'Bash', { command: 'git status' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(6)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(visible[1].kind).toBe('agent-text')
        expect(isToolGroupBlock(visible[2])).toBe(true)
        expect(visible[3]).toBe(interactive)
        expect(visible[4]).toBe(pendingPerm)
        expect(isToolGroupBlock(visible[5])).toBe(true)
    })

    it('marks only the oldest visible grouped run as needing older history', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeToolBlock('grep-1', 'Grep', { pattern: 'foo' }),
            makeTextBlock('text-1'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
            makeToolBlock('bash-2', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: true })

        expect(isToolGroupBlock(visible[0]) && visible[0].needsOlderHistory).toBe(true)
        expect(isToolGroupBlock(visible[2]) && visible[2].needsOlderHistory).toBe(false)
    })

    it('does not mark groups after leading non-tool or standalone blocks as needing older history', () => {
        const visible = buildVisibleChatBlocks([
            makeTextBlock('text-1', 'prepended assistant note'),
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
        ], { hasMoreMessages: true })

        expect(visible[0].kind).toBe('agent-text')
        expect(isToolGroupBlock(visible[1]) && visible[1].needsOlderHistory).toBe(false)
    })

    it('reuses a previous group id when tools are prepended or appended', () => {
        const previousPrepend = buildVisibleChatBlocks([
            makeToolBlock('read-2', 'Read', { file_path: 'src/b.ts' }),
            makeToolBlock('bash-2', 'Bash', { command: 'bun test' }),
            makeToolBlock('edit-2', 'Edit', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: true })

        const nextPrepend = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('read-2', 'Read', { file_path: 'src/b.ts' }),
            makeToolBlock('bash-2', 'Bash', { command: 'bun test' }),
            makeToolBlock('edit-2', 'Edit', { file_path: 'src/b.ts' }),
        ], {
            hasMoreMessages: false,
            previousGroups: previousPrepend.filter(isToolGroupBlock)
        })

        expect(isToolGroupBlock(previousPrepend[0]) && isToolGroupBlock(nextPrepend[0]) && previousPrepend[0].id === nextPrepend[0].id).toBe(true)

        const previousAppend = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeToolBlock('grep-1', 'Grep', { pattern: 'foo' }),
        ], { hasMoreMessages: false })

        const nextAppend = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeToolBlock('grep-1', 'Grep', { pattern: 'foo' }),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
        ], {
            hasMoreMessages: false,
            previousGroups: previousAppend.filter(isToolGroupBlock)
        })

        expect(isToolGroupBlock(previousAppend[0]) && isToolGroupBlock(nextAppend[0]) && previousAppend[0].id === nextAppend[0].id).toBe(true)
    })
})
