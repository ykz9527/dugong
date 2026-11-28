import type { AgentReasoningBlock, ChatBlock, RoundSummary, ToolCallBlock } from '@/chat/types'
import { getCodexCommandActions, isCodexExplorationTool } from '@/chat/codexCommandPresentation'
import { isSubagentToolName } from '@/chat/subagentTool'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import { getInputStringAny } from '@/lib/toolInputUtils'

export type ToolGroupActionKind = 'read' | 'search' | 'command' | 'mutation' | 'web' | 'other'

export type ToolGroupItem = ToolCallBlock | AgentReasoningBlock

export type ToolGroupSummary = {
    totalTools: number
    reasoningCount?: number
    countsByKind: Record<ToolGroupActionKind, number>
    fileTargets: string[]
    commandTargets: string[]
    searchTargets: string[]
    urlTargets: string[]
    otherTargets: string[]
    errorCount: number
    runningCount: number
    pendingCount: number
}

export type ToolGroupBlock = {
    kind: 'tool-group'
    id: string
    createdAt: number
    invokedAt?: number | null
    firstToolId: string
    lastToolId: string
    tools: ToolCallBlock[]
    /** Full chronological timeline including absorbed reasoning blocks. Falls back to `tools` when absent. */
    items?: ToolGroupItem[]
    defaultOpen: boolean
    historyState: 'complete' | 'needs-older-history'
    needsOlderHistory: boolean
    activityTitle?: string | null
    presentationMode?: 'default' | 'codex-exploration'
    streamingReasoning?: boolean
    roundSummary?: RoundSummary
    summary: ToolGroupSummary
}

export type VisibleChatBlock = ChatBlock | ToolGroupBlock

export type VisibleChatBlockRole = 'user' | 'assistant' | 'system'

/**
 * The role a block renders under in the thread. `@assistant-ui/react` joins
 * adjacent assistant-role blocks into a single card, so this also determines
 * how many rows a run of blocks actually produces on screen.
 */
export function visibleBlockRole(block: VisibleChatBlock): VisibleChatBlockRole {
    if (block.kind === 'user-text') return 'user'
    if (block.kind === 'agent-event') return 'system'
    if (block.kind === 'cli-output') return block.source === 'user' ? 'user' : 'assistant'
    return 'assistant'
}

type ToolGroupingOptions = {
    hasMoreMessages: boolean
    previousGroups?: ToolGroupBlock[]
    /** Collapse tool activity groups by default (generalized from Codex exploration). Defaults to true. */
    codexExplorationCollapsed?: boolean
    /** True while the active session turn is running/thinking. */
    isSessionThinking?: boolean
}

const PLAN_TOOL_NAMES = new Set([
    'TodoWrite',
    'update_plan',
    'ExitPlanMode',
    'exit_plan_mode',
    'CodexReasoning'
])

const MILESTONE_TOOL_NAMES = new Set([
    'Task',
    'Agent',
    'CodexAgent',
    'TeamCreate',
    'TeamDelete',
    'SendMessage',
    // agy's transitional task-log chip — keep it standalone (like SendMessage)
    // so it reads as a thin marker instead of being folded into a tool group.
    'AgyTaskLog',
    'Skill',
    'spawn_agent',
    'send_input',
    'send_message',
    'resume_agent',
    'followup_task',
    'wait_agent',
    'close_agent',
    'interrupt_agent',
    'list_agents'
])

const INTERACTIVE_TOOL_NAMES = new Set([
    'CodexPermission'
])

const READ_TOOL_NAME_KEYS = new Set([
    'read',
    'notebookread',
    'view_file',
    'read_file',
    'view_file_outline',
    'view_code_item'
])

const SEARCH_TOOL_NAME_KEYS = new Set([
    'grep',
    'glob',
    'ls',
    'grep_search',
    'find_by_name',
    'list_dir',
    'search_files'
])

const COMMAND_TOOL_NAME_KEYS = new Set([
    'bash',
    'codexbash',
    'exec_command',
    'shell',
    'shell_command',
    'run_shell_command',
    'run_command',
    'command_status',
    'send_command_input'
])

const MUTATION_TOOL_NAME_KEYS = new Set([
    'edit',
    'multiedit',
    'write',
    'notebookedit',
    'codexpatch',
    'codexdiff',
    'apply_patch',
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content',
    'edit_file',
    'write_file',
    'code_action'
])

const WEB_TOOL_NAME_KEYS = new Set([
    'webfetch',
    'websearch',
    'search_web',
    'read_url_content'
])

function normalizeToolNameKey(name: string): string {
    return name.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

export function isReasoningGroupItem(block: ChatBlock): boolean {
    return block.kind === 'agent-reasoning'
        || (block.kind === 'tool-call' && block.tool.name === 'CodexReasoning')
}

export function getToolGroupItems(block: ToolGroupBlock): ToolGroupItem[] {
    return block.items && block.items.length > 0 ? block.items : block.tools
}

function pushUnique(target: string[], value: string | null): void {
    if (!value) return
    if (target.includes(value)) return
    target.push(value)
}

function normalizeCommandInput(input: unknown): string | null {
    const direct = getInputStringAny(input, ['command', 'cmd'])
    if (direct) return direct

    if (!input || typeof input !== 'object') return null
    const command = (input as { command?: unknown }).command
    if (!Array.isArray(command)) return null

    const parts = command.filter((part): part is string => typeof part === 'string' && part.length > 0)
    return parts.length > 0 ? parts.join(' ') : null
}

export function getToolGroupActionKind(block: ToolCallBlock): ToolGroupActionKind {
    const name = block.tool.name

    if (name === 'CodexBash') {
        const actions = getCodexCommandActions(block)
        if (actions.length > 0 && actions.every((action) => (
            action.type === 'read' || action.type === 'listFiles' || action.type === 'search'
        ))) {
            return actions.every((action) => action.type === 'search') ? 'search' : 'read'
        }
        return 'command'
    }

    const key = normalizeToolNameKey(name)
    if (READ_TOOL_NAME_KEYS.has(key)) return 'read'
    if (SEARCH_TOOL_NAME_KEYS.has(key)) return 'search'
    if (COMMAND_TOOL_NAME_KEYS.has(key)) return 'command'
    if (MUTATION_TOOL_NAME_KEYS.has(key)) return 'mutation'
    if (WEB_TOOL_NAME_KEYS.has(key)) return 'web'
    return 'other'
}

function getPrimaryFileTarget(block: ToolCallBlock): string | null {
    const direct = getInputStringAny(block.tool.input, ['file_path', 'path', 'file', 'filePath', 'notebook_path', 'name'])
    if (direct) return direct
    if (block.tool.name === 'CodexBash') {
        for (const action of getCodexCommandActions(block)) {
            if (action.type === 'read') return action.path
            if (action.type === 'listFiles' && action.path) return action.path
        }
    }
    return null
}

function getPrimarySearchTarget(block: ToolCallBlock): string | null {
    const direct = getInputStringAny(block.tool.input, ['pattern', 'query'])
    if (direct) return direct
    if (block.tool.name === 'CodexBash') {
        for (const action of getCodexCommandActions(block)) {
            if (action.type === 'search' && (action.query || action.path)) {
                return action.query ?? action.path
            }
        }
    }
    return null
}

function getPrimaryUrlTarget(block: ToolCallBlock): string | null {
    return getInputStringAny(block.tool.input, ['url'])
}

function getPrimaryOtherTarget(block: ToolCallBlock): string | null {
    const fileTarget = getPrimaryFileTarget(block)
    if (fileTarget) return fileTarget

    const searchTarget = getPrimarySearchTarget(block)
    if (searchTarget) return searchTarget

    const commandTarget = normalizeCommandInput(block.tool.input)
    if (commandTarget) return commandTarget

    const urlTarget = getPrimaryUrlTarget(block)
    if (urlTarget) return urlTarget

    return block.tool.name
}

function summarizeToolGroup(tools: ToolCallBlock[], reasoningCount: number): ToolGroupSummary {
    const countsByKind: Record<ToolGroupActionKind, number> = {
        read: 0,
        search: 0,
        command: 0,
        mutation: 0,
        web: 0,
        other: 0
    }
    const fileTargets: string[] = []
    const commandTargets: string[] = []
    const searchTargets: string[] = []
    const urlTargets: string[] = []
    const otherTargets: string[] = []
    let errorCount = 0
    let runningCount = 0
    let pendingCount = 0

    for (const tool of tools) {
        const kind = getToolGroupActionKind(tool)
        countsByKind[kind] += 1

        if (tool.tool.state === 'error') {
            errorCount += 1
        } else if (tool.tool.state === 'running') {
            runningCount += 1
        } else if (tool.tool.state === 'pending') {
            pendingCount += 1
        }

        if (kind === 'read' || kind === 'mutation') {
            pushUnique(fileTargets, getPrimaryFileTarget(tool))
            continue
        }
        if (kind === 'search') {
            pushUnique(searchTargets, getPrimarySearchTarget(tool))
            continue
        }
        if (kind === 'command') {
            pushUnique(commandTargets, normalizeCommandInput(tool.tool.input))
            continue
        }
        if (kind === 'web') {
            pushUnique(urlTargets, getPrimaryUrlTarget(tool) ?? getPrimarySearchTarget(tool))
            continue
        }
        pushUnique(otherTargets, getPrimaryOtherTarget(tool))
    }

    return {
        totalTools: tools.length,
        reasoningCount,
        countsByKind,
        fileTargets,
        commandTargets,
        searchTargets,
        urlTargets,
        otherTargets,
        errorCount,
        runningCount,
        pendingCount,
    }
}

function isInteractiveToolBlock(block: ToolCallBlock): boolean {
    return INTERACTIVE_TOOL_NAMES.has(block.tool.name)
        || block.tool.permission?.status === 'pending'
        || isAskUserQuestionToolName(block.tool.name)
        || isRequestUserInputToolName(block.tool.name)
}

export function isEligibleForToolGrouping(block: ToolCallBlock): boolean {
    if (isSubagentToolName(block.tool.name)) return false
    if (PLAN_TOOL_NAMES.has(block.tool.name)) return false
    if (MILESTONE_TOOL_NAMES.has(block.tool.name)) return false
    if (isInteractiveToolBlock(block)) return false
    return true
}

function isActivityRunMember(block: ChatBlock): block is ToolGroupItem {
    if (isReasoningGroupItem(block)) return true
    return block.kind === 'tool-call' && isEligibleForToolGrouping(block)
}

function createToolGroupId(
    tools: ToolCallBlock[],
    needsOlderHistory: boolean,
    previousGroups: ToolGroupBlock[]
): string {
    const firstToolId = tools[0]?.id ?? 'unknown'
    const lastToolId = tools[tools.length - 1]?.id ?? firstToolId

    const previous = previousGroups.find((group) => (
        group.firstToolId === firstToolId
        || group.lastToolId === lastToolId
        || tools.some((tool) => tool.id === group.firstToolId || tool.id === group.lastToolId)
    ))
    if (previous) {
        return previous.id
    }

    return needsOlderHistory
        ? `tool-group:${lastToolId}`
        : `tool-group:${firstToolId}`
}

export function isToolGroupBlock(block: VisibleChatBlock | ChatBlock): block is ToolGroupBlock {
    return block.kind === 'tool-group'
}

export function buildVisibleChatBlocks(
    blocks: ChatBlock[],
    options: ToolGroupingOptions
): VisibleChatBlock[] {
    const visibleBlocks: VisibleChatBlock[] = []
    const previousGroups = options.previousGroups ?? []

    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]
        if (!isActivityRunMember(block)) {
            visibleBlocks.push(block)
            continue
        }

        const runItems: ToolGroupItem[] = [block]
        let cursor = index + 1
        while (cursor < blocks.length) {
            const candidate = blocks[cursor]
            if (!isActivityRunMember(candidate)) {
                break
            }
            runItems.push(candidate)
            cursor += 1
        }

        const tools = runItems.filter((item): item is ToolCallBlock => (
            item.kind === 'tool-call' && !isReasoningGroupItem(item)
        ))
        const reasoningCount = runItems.length - tools.length

        // Fold when a contiguous activity run has >= 3 tool calls, or >= 2 tool
        // calls interleaved with reasoning blocks (which would otherwise occupy
        // 3+ rows on screen).
        const shouldGroup = tools.length >= 3 || (tools.length >= 2 && reasoningCount > 0)
        if (!shouldGroup) {
            for (const item of runItems) {
                visibleBlocks.push(item)
            }
            index = cursor - 1
            continue
        }

        const startsAtOldestVisibleBoundary = visibleBlocks.length === 0
        const needsOlderHistory = options.hasMoreMessages && startsAtOldestVisibleBoundary
        const activityTitle = [...runItems]
            .reverse()
            .filter((item): item is ToolCallBlock => item.kind === 'tool-call' && item.tool.name === 'CodexReasoning')
            .map((item) => getInputStringAny(item.tool.input, ['title']))
            .find((title): title is string => title !== null) ?? null
        const allCodexExploration = reasoningCount === 0 && tools.every(isCodexExplorationTool)
        const roundSummary = tools.find((tool) => tool.roundSummary)?.roundSummary
            ?? runItems.find((item) => item.roundSummary)?.roundSummary
        const hasRunningTool = tools.some((tool) => tool.tool.state === 'running')
        const lastItem = runItems[runItems.length - 1]
        const streamingReasoning = Boolean(
            options.isSessionThinking
            && cursor === blocks.length
            && !hasRunningTool
            && lastItem
            && isReasoningGroupItem(lastItem)
        )

        visibleBlocks.push({
            kind: 'tool-group',
            id: createToolGroupId(tools, needsOlderHistory, previousGroups),
            createdAt: runItems[0].createdAt,
            invokedAt: runItems.find((item) => item.invokedAt != null)?.invokedAt ?? runItems[0].invokedAt,
            firstToolId: tools[0].id,
            lastToolId: tools[tools.length - 1].id,
            tools,
            items: runItems,
            defaultOpen: options.codexExplorationCollapsed === false,
            historyState: needsOlderHistory ? 'needs-older-history' : 'complete',
            needsOlderHistory,
            activityTitle,
            presentationMode: allCodexExploration ? 'codex-exploration' : 'default',
            streamingReasoning,
            roundSummary,
            summary: summarizeToolGroup(tools, reasoningCount)
        })
        index = cursor - 1
    }

    return visibleBlocks
}
