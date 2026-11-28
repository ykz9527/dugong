import { describe, expect, it } from 'vitest'
import { en, zhCN } from '@/lib/locales'
import type { AgentReasoningBlock, ToolCallBlock } from '@/chat/types'
import { getToolGroupActionKind, type ToolGroupActionKind, type ToolGroupBlock } from '@/chat/toolGroups'
import {
    extractReasoningPreviewLine,
    formatCodexExplorationPreview,
    formatGroupedHeaderTitle,
    formatGroupedRowLabel,
    inferGroupedSummaryIntent,
    pickGroupedPreviewTool
} from '@/components/ToolCard/groupedPresentation'

type Dict = Record<string, string>

function makeTranslator(dict: Dict) {
    return (key: string, params?: Record<string, string | number>) => {
        const template = dict[key] ?? key
        if (!params) return template
        return template.replace(/\{(\w+)\}/g, (match, token) => {
            const value = params[token]
            return value === undefined ? match : String(value)
        })
    }
}

function makeTool(id: string, name: string, input: unknown = {}, state: ToolCallBlock['tool']['state'] = 'completed'): ToolCallBlock {
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
            result: null,
            permission: undefined,
        },
        children: [],
    }
}

function makeGroup(tools: ToolCallBlock[]): ToolGroupBlock {
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
        id: 'tool-group:test',
        createdAt: 1,
        invokedAt: null,
        firstToolId: tools[0]?.id ?? 'empty',
        lastToolId: tools[tools.length - 1]?.id ?? 'empty',
        tools,
        items: tools,
        defaultOpen: false,
        historyState: 'complete',
        needsOlderHistory: false,
        summary: {
            totalTools: tools.length,
            countsByKind,
            fileTargets: [],
            commandTargets: [],
            searchTargets: [],
            urlTargets: [],
            otherTargets: [],
            errorCount: tools.filter((tool) => tool.tool.state === 'error').length,
            runningCount: tools.filter((tool) => tool.tool.state === 'running').length,
            pendingCount: tools.filter((tool) => tool.tool.state === 'pending').length,
        },
    }
}

const tEn = makeTranslator(en as Dict)
const tZh = makeTranslator(zhCN as Dict)

describe('inferGroupedSummaryIntent', () => {
    it('treats run_shell_command as a command intent', () => {
        expect(inferGroupedSummaryIntent(makeTool('shell-1', 'run_shell_command', { command: 'bun test' }))).toBe('run-project-command')
    })

    it('treats file inspection shell commands as inspect-files intent', () => {
        const tool = makeTool('shell-1', 'shell_command', { command: 'Get-ChildItem src -Recurse' })
        expect(inferGroupedSummaryIntent(tool)).toBe('inspect-files')
    })

    it('treats content search shell commands as search-content intent', () => {
        const tool = makeTool('shell-2', 'Bash', { command: 'rg "TodoWrite" web/src' })
        expect(inferGroupedSummaryIntent(tool)).toBe('search-content')
    })
})

describe('formatGroupedRowLabel', () => {
    it('returns a friendly english label without leaking raw shell command text', () => {
        const tool = makeTool('shell-3', 'shell_command', { command: 'Get-ChildItem src -Recurse' })
        const label = formatGroupedRowLabel(tool, tEn)

        expect(label).toBe('Inspect project files')
        expect(label).not.toContain('Get-ChildItem')
        expect(label).not.toContain('src')
    })

    it('returns a friendly chinese label for command execution', () => {
        const tool = makeTool('shell-4', 'Bash', { command: 'bun run build:web' })
        expect(formatGroupedRowLabel(tool, tZh)).toBe('执行项目命令')
    })
})

describe('formatGroupedHeaderTitle', () => {
    it('formats multi-action counts sorted by frequency in English and Chinese', () => {
        const group = makeGroup([
            makeTool('c1', 'Bash', { command: 'git log' }),
            makeTool('c2', 'Bash', { command: 'git status' }),
            makeTool('c3', 'exec_command', { command: 'bun test' }),
            makeTool('r1', 'Read', { file_path: 'a.ts' }),
            makeTool('r2', 'Read', { file_path: 'b.ts' }),
            makeTool('e1', 'Edit', { file_path: 'a.ts' }),
        ])

        expect(formatGroupedHeaderTitle(group, tEn)).toBe('Ran 3 commands · read 2 files · edited 1 file')
        expect(formatGroupedHeaderTitle(group, tZh)).toBe('执行 3 条命令 · 读 2 个文件 · 改 1 个文件')
    })

    it('handles singular counts and generic tools cleanly', () => {
        const singleMix = makeGroup([
            makeTool('s1', 'Grep', { pattern: 'foo' }),
            makeTool('w1', 'WebFetch', { url: 'https://example.com' }),
            makeTool('o1', 'mcp__custom__ping', {}),
        ])

        expect(formatGroupedHeaderTitle(singleMix, tEn)).toBe('Searched 1 time · fetched 1 page · 1 tool')
        expect(formatGroupedHeaderTitle(singleMix, tZh)).toBe('搜索 1 次 · 访问 1 个网页 · 调用 1 个工具')

        const allOther = makeGroup([
            makeTool('o1', 'Tool', {}),
            makeTool('o2', 'Tool', {}),
            makeTool('o3', 'Tool', {}),
        ])
        expect(formatGroupedHeaderTitle(allOther, tEn)).toBe('3 tools')
        expect(formatGroupedHeaderTitle(allOther, tZh)).toBe('调用 3 个工具')
    })

    it('falls back to neutral title when summary counts are empty', () => {
        const empty = makeGroup([])
        expect(formatGroupedHeaderTitle(empty, tEn)).toBe('Tool activity')
        expect(formatGroupedHeaderTitle(empty, tZh)).toBe('工具活动')
    })
})

describe('pickGroupedPreviewTool', () => {
    it('prioritizes running > error > latest tool', () => {
        const done = makeTool('t1', 'Read', { file_path: 'a.ts' }, 'completed')
        const failed = makeTool('t2', 'Bash', { command: 'bun test' }, 'error')
        const laterDone = makeTool('t3', 'Read', { file_path: 'b.ts' }, 'completed')
        const running = makeTool('t4', 'Bash', { command: 'bun build' }, 'running')

        expect(pickGroupedPreviewTool(makeGroup([done, laterDone]))).toEqual({ tool: laterDone, reason: 'latest' })
        expect(pickGroupedPreviewTool(makeGroup([done, failed, laterDone]))).toEqual({ tool: failed, reason: 'error' })
        expect(pickGroupedPreviewTool(makeGroup([done, failed, running, laterDone]))).toEqual({ tool: running, reason: 'running' })
    })
})

describe('extractReasoningPreviewLine & formatCodexExplorationPreview', () => {
    it('strips markdown decoration from the first non-empty reasoning line', () => {
        const reasoning: AgentReasoningBlock = {
            kind: 'agent-reasoning',
            id: 'r1',
            localId: null,
            createdAt: 1,
            text: '\n\n**Checking git ancestry**\n\nMore detail below.'
        }
        expect(extractReasoningPreviewLine(reasoning)).toBe('Checking git ancestry')
    })

    it('formats readable Codex exploration previews', () => {
        const readTool = makeTool('cb-1', 'CodexBash', {
            command: 'cat package.json',
            command_actions: [{ type: 'read', command: 'cat package.json', name: 'package.json', path: '/repo/package.json' }]
        })
        const searchTool = makeTool('cb-2', 'CodexBash', {
            command: 'rg foo src',
            command_actions: [{ type: 'search', command: 'rg foo src', query: 'foo', path: 'src' }]
        })
        expect(formatCodexExplorationPreview(readTool, tEn)).toBe('Read package.json')
        expect(formatCodexExplorationPreview(readTool, tZh)).toBe('读取 package.json')
        expect(formatCodexExplorationPreview(searchTool, tEn)).toBe('Search foo in src')
        expect(formatCodexExplorationPreview(searchTool, tZh)).toBe('在 src 中搜索 foo')
    })
})
