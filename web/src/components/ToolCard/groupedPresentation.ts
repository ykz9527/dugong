import type { ToolGroupActionKind, ToolGroupBlock, ToolGroupItem } from '@/chat/toolGroups'
import type { ToolCallBlock } from '@/chat/types'
import { getCodexCommandActions, isCodexExplorationTool } from '@/chat/codexCommandPresentation'
import { getInputStringAny } from '@/lib/toolInputUtils'

type Translator = (key: string, params?: Record<string, string | number>) => string

export type GroupedSummaryIntent =
    | 'inspect-files'
    | 'search-content'
    | 'run-project-command'
    | 'modify-files'
    | 'open-web'
    | 'generic-command'
    | 'generic-tool'

const FILE_INSPECTION_COMMAND_RE = /\b(get-childitem|ls|dir|get-content|cat|type|tree)\b|\bsed\s+-n\b/i
const CONTENT_SEARCH_COMMAND_RE = /\b(rg|grep|select-string|findstr)\b/i
const SENSITIVE_TEXT_RE = /(?:bearer\s+\S+|(?:api[_-]?key|token|password|secret)(?:\s*[:=]\s*\S+|\s+\S{12,})|(?:gh[pousr]_|github_pat_|sk-[a-z0-9_-]*|xox[baprs]-)[a-z0-9_-]{12,}|[a-f0-9]{32,}|[a-z0-9_+/=-]{40,})/i
const MAX_SPECIFIC_LABEL_LENGTH = 72
const MAX_PREVIEW_LENGTH = 120

const ACTION_KIND_TIE_ORDER: readonly ToolGroupActionKind[] = [
    'command',
    'read',
    'search',
    'mutation',
    'web',
    'other'
]

function truncateLabel(value: string, maxLength = MAX_SPECIFIC_LABEL_LENGTH): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    return normalized.length > maxLength
        ? `${normalized.slice(0, maxLength - 1)}…`
        : normalized
}

export function safeGroupedLabelValue(value: string | null): string | null {
    if (!value || SENSITIVE_TEXT_RE.test(value)) return null
    return truncateLabel(value)
}

function getCommandText(input: unknown): string | null {
    const direct = getInputStringAny(input, ['command', 'cmd'])
    if (direct) return direct

    if (!input || typeof input !== 'object') return null
    const command = (input as { command?: unknown }).command
    if (!Array.isArray(command)) return null

    const parts = command.filter((part): part is string => typeof part === 'string' && part.length > 0)
    return parts.length > 0 ? parts.join(' ') : null
}

function getIntentLabel(intent: GroupedSummaryIntent, t: Translator): string {
    switch (intent) {
        case 'inspect-files':
            return t('toolGroup.friendly.inspectFiles')
        case 'search-content':
            return t('toolGroup.friendly.searchContent')
        case 'run-project-command':
            return t('toolGroup.friendly.runCommands')
        case 'modify-files':
            return t('toolGroup.friendly.editFiles')
        case 'open-web':
            return t('toolGroup.friendly.openWeb')
        case 'generic-command':
            return t('toolGroup.friendly.genericCommand')
        default:
            return t('toolGroup.friendly.genericTool')
    }
}

export function inferGroupedSummaryIntent(tool: ToolCallBlock): GroupedSummaryIntent {
    const toolName = tool.tool.name
    const command = getCommandText(tool.tool.input)

    if (toolName === 'Read' || toolName === 'LS' || toolName === 'NotebookRead' || toolName === 'view_file') {
        return 'inspect-files'
    }
    if (toolName === 'Grep' || toolName === 'Glob' || toolName === 'grep_search' || toolName === 'find_by_name') {
        return 'search-content'
    }
    if (
        toolName === 'Edit'
        || toolName === 'MultiEdit'
        || toolName === 'Write'
        || toolName === 'NotebookEdit'
        || toolName === 'CodexPatch'
        || toolName === 'CodexDiff'
        || toolName === 'apply_patch'
        || toolName === 'write_to_file'
        || toolName === 'replace_file_content'
        || toolName === 'multi_replace_file_content'
    ) {
        return 'modify-files'
    }
    if (toolName === 'WebFetch' || toolName === 'WebSearch' || toolName === 'search_web' || toolName === 'read_url_content') {
        return 'open-web'
    }

    if (
        toolName === 'Bash'
        || toolName === 'CodexBash'
        || toolName === 'exec_command'
        || toolName === 'shell'
        || toolName === 'shell_command'
        || toolName === 'run_shell_command'
        || toolName === 'run_command'
    ) {
        if (command && FILE_INSPECTION_COMMAND_RE.test(command)) {
            return 'inspect-files'
        }
        if (command && CONTENT_SEARCH_COMMAND_RE.test(command)) {
            return 'search-content'
        }
        return 'run-project-command'
    }

    return 'generic-tool'
}

function capitalizeFirst(value: string): string {
    if (!value) return value
    return value.charAt(0).toUpperCase() + value.slice(1)
}

function formatActionKindPhrase(kind: ToolGroupActionKind, count: number, t: Translator): string {
    const key = count === 1
        ? `toolGroup.action.${kind}.one`
        : `toolGroup.action.${kind}.other`
    return t(key, { n: count })
}

/**
 * Formats the primary collapsed header line as a concise action summary:
 *   zh: "执行 8 条命令 · 读 3 个文件 · 改 2 个文件"
 *   en: "Ran 8 commands · read 3 files · edited 2 files"
 * Ordered by count descending (ties broken by ACTION_KIND_TIE_ORDER).
 */
export function formatGroupedHeaderTitle(block: ToolGroupBlock, t: Translator): string {
    const { countsByKind } = block.summary
    const entries = ACTION_KIND_TIE_ORDER
        .map((kind, orderIndex) => ({ kind, count: countsByKind[kind] ?? 0, orderIndex }))
        .filter((entry) => entry.count > 0)
        .sort((a, b) => (b.count - a.count) || (a.orderIndex - b.orderIndex))

    if (entries.length === 0) {
        return t('toolGroup.title')
    }

    const parts = entries.map((entry, index) => {
        const phrase = formatActionKindPhrase(entry.kind, entry.count, t)
        return index === 0 ? capitalizeFirst(phrase) : phrase
    })

    return parts.join(' · ')
}

export function formatGroupedHeaderSubtitle(_block: ToolGroupBlock, _t: Translator): string | null {
    // Counts are now promoted into the primary header title; the secondary slot
    // renders the live/failed/latest item preview directly in ToolGroupCard.
    return null
}

/**
 * Extracts a short single-line summary from a reasoning block for previews.
 */
export function extractReasoningPreviewLine(item: ToolGroupItem): string | null {
    let raw: string | null = null
    if (item.kind === 'agent-reasoning') {
        raw = item.text
    } else if (item.kind === 'tool-call' && item.tool.name === 'CodexReasoning') {
        raw = getInputStringAny(item.tool.input, ['title', 'text', 'summary'])
            ?? (typeof item.tool.result === 'string' ? item.tool.result : null)
    }
    if (!raw) return null

    const firstLine = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0)
    if (!firstLine) return null

    const cleaned = firstLine
        .replace(/^#+\s*/, '')
        .replace(/^\*\*(.+?)\*\*$/, '$1')
        .replace(/^__(.+?)__$/, '$1')
        .replace(/^[-*]\s+/, '')
        .trim()
    return cleaned ? truncateLabel(cleaned, MAX_PREVIEW_LENGTH) : null
}

/**
 * Picks which tool should be previewed in the collapsed header row:
 *   1. Latest running tool (live progress)
 *   2. Latest failed tool (immediate error visibility)
 *   3. Latest tool in the group
 */
export function pickGroupedPreviewTool(block: ToolGroupBlock): {
    tool: ToolCallBlock
    reason: 'running' | 'error' | 'latest'
} | null {
    const tools = block.tools
    if (tools.length === 0) return null

    for (let index = tools.length - 1; index >= 0; index -= 1) {
        if (tools[index].tool.state === 'running') {
            return { tool: tools[index], reason: 'running' }
        }
    }
    for (let index = tools.length - 1; index >= 0; index -= 1) {
        if (tools[index].tool.state === 'error') {
            return { tool: tools[index], reason: 'error' }
        }
    }
    return { tool: tools[tools.length - 1], reason: 'latest' }
}

/**
 * Formats a concise text preview for a Codex exploration tool's latest action.
 */
export function formatCodexExplorationPreview(tool: ToolCallBlock, t: Translator): string | null {
    const actions = getCodexCommandActions(tool)
    const last = actions.at(-1)
    if (!last) return null
    if (last.type === 'read') {
        const name = last.name || last.path
        const base = name.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? name
        return `${t('toolGroup.codex.read')} ${truncateLabel(base, MAX_PREVIEW_LENGTH)}`
    }
    if (last.type === 'listFiles') {
        return last.path
            ? `${t('toolGroup.codex.list')} ${truncateLabel(last.path, MAX_PREVIEW_LENGTH)}`
            : t('toolGroup.codex.list')
    }
    if (last.type === 'search') {
        const searchWord = t('toolGroup.codex.search')
        const detail = last.query && last.path
            ? t('toolGroup.codex.searchIn', { query: last.query, path: last.path })
            : last.query ?? last.path
        if (!detail) return searchWord
        const truncated = truncateLabel(detail, MAX_PREVIEW_LENGTH)
        return truncated.includes(searchWord) ? truncated : `${searchWord} ${truncated}`
    }
    return null
}

export function formatGroupedRowLabel(tool: ToolCallBlock, t: Translator): string {
    if (isCodexExplorationTool(tool)) return t('toolGroup.codex.explored')
    return getIntentLabel(inferGroupedSummaryIntent(tool), t)
}
