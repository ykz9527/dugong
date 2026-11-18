import type { ChatBlock, ChatToolCall, ToolCallBlock } from '@/chat/types'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { getClaudeModelLabel, isObject, safeStringify } from '@hapi/protocol'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CodeBlock } from '@/components/CodeBlock'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PermissionFooter } from '@/components/ToolCard/PermissionFooter'
import { AskUserQuestionFooter } from '@/components/ToolCard/AskUserQuestionFooter'
import { RequestUserInputFooter } from '@/components/ToolCard/RequestUserInputFooter'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import { AnsweredQuestionsInline, getAnsweredQuestionItems } from '@/components/ToolCard/questionAnswers'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { getToolFullViewComponent, getToolViewComponent } from '@/components/ToolCard/views/_all'
import { getToolResultViewComponent } from '@/components/ToolCard/views/_results'
import { formatTaskChildLabel, TaskStateIcon } from '@/components/ToolCard/helpers'
import { toolDurationMs } from '@/components/ToolCard/toolDuration'
import { formatDuration, formatMessageTimestampTitle } from '@/chat/presentation'
import type { TerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { usePointerFocusRing } from '@/hooks/usePointerFocusRing'
import { getInputStringAny, truncate } from '@/lib/toolInputUtils'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { TraceSection } from '@/components/ToolCard/trace'
import { isSubagentToolName } from '@/chat/subagentTool'
import { RunInTerminalButton } from '@/components/ToolCard/RunInTerminalButton'
import { TERMINAL_RELATED_TOOL_NAMES } from '@/components/ToolCard/shellCommand'

const ELAPSED_INTERVAL_MS = 1000

export function shouldUseCompactTerminalToolCard(toolName: string, terminalToolDisplayMode: TerminalToolDisplayMode): boolean {
    return TERMINAL_RELATED_TOOL_NAMES.has(toolName) && terminalToolDisplayMode === 'compact'
}

export function shouldShowInlineToolCardBody(
    toolName: string,
    presentationMinimal: boolean,
    terminalToolDisplayMode: TerminalToolDisplayMode
): boolean {
    if (isSubagentToolName(toolName)) return false
    if (TERMINAL_RELATED_TOOL_NAMES.has(toolName)) {
        return terminalToolDisplayMode === 'detailed'
    }
    return !presentationMinimal
}

export function getToolTimingDetails(tool: ChatToolCall, now: number): {
    startedAt: number | null
    completedAt: number | null
    durationMs: number | null
} {
    if (tool.state === 'pending') {
        return { startedAt: null, completedAt: null, durationMs: null }
    }

    const active = tool.state === 'running'
    const hasExecPair = tool.execStartedAt != null && tool.execCompletedAt != null
    const startedAt = active || !hasExecPair
        ? (tool.startedAt ?? tool.createdAt)
        : tool.execStartedAt
    const completedAt = active
        ? null
        : (hasExecPair ? tool.execCompletedAt : tool.completedAt)
    const liveDurationMs = active && startedAt != null ? Math.max(0, now - startedAt) : null

    return {
        startedAt,
        completedAt,
        durationMs: toolDurationMs(tool) ?? liveDurationMs,
    }
}

export function formatCompactToolTimestamp(value: number): string {
    return new Date(value).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
    })
}

export function ToolTimingSummary(props: {
    startedAt: number | null
    completedAt: number | null
    durationMs: number | null
    typography?: 'detail' | 'group'
}) {
    const { t } = useTranslation()
    const items = [
        props.startedAt != null ? { label: t('tool.startedAt'), value: formatCompactToolTimestamp(props.startedAt) } : null,
        props.completedAt != null ? { label: t('tool.completedAt'), value: formatCompactToolTimestamp(props.completedAt) } : null,
        props.durationMs != null ? { label: t('tool.duration'), value: formatDuration(props.durationMs) } : null,
    ].filter((item): item is { label: string; value: string } => item !== null)

    if (items.length === 0) return null

    return (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-[var(--app-hint)]">
            {items.map((item) => (
                <span key={item.label} className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
                    <span className={props.typography === 'group' ? undefined : 'font-medium'}>{item.label}</span>
                    <span className={props.typography === 'group' ? undefined : 'font-mono'}>{item.value}</span>
                </span>
            ))}
        </div>
    )
}

function useToolTiming(tool: ChatToolCall) {
    const active = tool.state === 'running'
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        if (!active) return
        setNow(Date.now())
        const id = setInterval(() => setNow(Date.now()), ELAPSED_INTERVAL_MS)
        return () => clearInterval(id)
    }, [active, tool.startedAt, tool.createdAt])

    return getToolTimingDetails(tool, now)
}

function ToolTimingDetails(props: { block: ToolCallBlock }) {
    const { t } = useTranslation()
    const tool = props.block.tool
    const active = tool.state === 'running'
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        if (!active) return
        setNow(Date.now())
        const id = setInterval(() => setNow(Date.now()), ELAPSED_INTERVAL_MS)
        return () => clearInterval(id)
    }, [active, tool.startedAt, tool.createdAt])

    const { startedAt, completedAt, durationMs } = getToolTimingDetails(tool, now)
    const rows = [
        startedAt != null ? [t('tool.startedAt'), formatMessageTimestampTitle(new Date(startedAt))] : null,
        !active && completedAt != null ? [t('tool.completedAt'), formatMessageTimestampTitle(new Date(completedAt))] : null,
        durationMs != null ? [t('tool.duration'), formatDuration(durationMs)] : null,
    ].filter((row): row is string[] => row !== null)

    if (rows.length === 0) return null

    return (
        <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
            {rows.map(([label, value]) => (
                <div key={label} className="contents">
                    <span className="font-semibold text-[var(--app-hint)]">{label}</span>
                    <span className="tabular-nums text-[var(--app-hint)]">{value}</span>
                </div>
            ))}
        </div>
    )
}

// Matches the full SDK model ids Claude Code echoes back for subagents
// (e.g. `claude-sonnet-4-5-20250929`, `claude-opus-4-8`) — a lowercase name,
// a major/minor version, and an optional 8-digit date suffix to discard.
const CLAUDE_SDK_MODEL_ID_PATTERN = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/

/**
 * Formats a raw model id for compact display in the subagent badge.
 *
 * Reuses this repo's existing "friendly label, else raw fallback" idiom
 * (see `getClaudeComposerModelOptions` in claudeModelOptions.ts, which does
 * `getClaudeModelLabel(model) ?? model`): `getClaudeModelLabel` only maps the
 * short preset aliases ('sonnet'/'opus'/'fable'), not the full SDK model ids
 * a subagent's own `model` field actually carries, so this adds a second,
 * narrow fallback that extracts just the name + version from the SDK id
 * shape and drops the date suffix. Anything that matches neither (Gemini,
 * Codex, OpenCode, or any future format) is returned as-is — this
 * deliberately doesn't try to parse formats it doesn't recognize.
 */
export function formatSubagentModelLabel(model: string): string {
    const presetLabel = getClaudeModelLabel(model)
    if (presetLabel) return presetLabel

    const match = model.match(CLAUDE_SDK_MODEL_ID_PATTERN)
    if (match) {
        const [, name, major, minor] = match
        return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${major}.${minor}`
    }

    return model
}

/**
 * Derives the model(s) a subagent (Task/Agent tool call) actually executed
 * under, from its own child blocks — not from the parent `ToolCallBlock.model`,
 * which reflects the *calling* session's model and would misattribute the
 * subagent's model if used directly (see reducerTimeline.ts sidechain handling).
 *
 * Every child block produced by reducing the subagent's sidechain carries the
 * `model` of the assistant message it came from. A subagent run can switch
 * models mid-run (e.g. `--fallback-model` kicking in under overload), so this
 * collects the distinct non-null/non-empty raw values in first-seen order —
 * the same "seenModels" pattern `aggregateResponseGroups`
 * (web/src/lib/assistant-runtime.ts) already uses for top-level multi-turn
 * message metadata, reused here rather than inventing a new convention — then
 * formats each for display and joins them. When a backend does not expose
 * child messages, an explicit per-invocation model is still authoritative.
 * The caller/session model is deliberately never used as a fallback.
 */
export function getSubagentModel(children: ChatBlock[], explicitModel?: string | null): string | null {
    const seenModels: string[] = []
    for (const child of children) {
        if ('model' in child && child.model && !seenModels.includes(child.model)) {
            seenModels.push(child.model)
        }
    }
    if (seenModels.length > 0) return seenModels.map(formatSubagentModelLabel).join(', ')
    return explicitModel ? formatSubagentModelLabel(explicitModel) : null
}

function getTaskSummaryChildren(block: ToolCallBlock): { visible: ToolCallBlock[]; remaining: number } | null {
    if (!isSubagentToolName(block.tool.name)) return null

    const children = block.children
        .filter((child): child is ToolCallBlock => child.kind === 'tool-call')
        .filter((child) => child.tool.state === 'pending' || child.tool.state === 'running' || child.tool.state === 'completed' || child.tool.state === 'error')

    if (children.length === 0) return null

    const visible = children.slice(-3)
    return { visible, remaining: children.length - visible.length }
}

function renderTaskSummary(
    block: ToolCallBlock,
    metadata: SessionMetadataSummary | null,
    t: (key: string, params?: Record<string, string | number>) => string,
): ReactNode | null {
    const summary = getTaskSummaryChildren(block)
    if (!summary) return null

    const visible = summary.visible
    const remaining = summary.remaining

    return (
        <div className="flex flex-col gap-1 px-1">
            <div className="flex flex-col gap-1">
                {visible.map((child) => (
                    <div key={child.id} className="flex items-center gap-2">
                        <div className="min-w-0 flex-1 font-mono text-xs text-[var(--app-hint)]">
                            <span className="mr-2 inline-block w-4 text-center align-middle">
                                <TaskStateIcon state={child.tool.state} />
                            </span>
                            <span className="align-middle break-all">
                                {formatTaskChildLabel(child, metadata, t)}
                            </span>
                        </div>
                    </div>
                ))}
                {remaining > 0 ? (
                    <div className="text-xs text-[var(--app-hint)] italic">
                        (+{remaining} more)
                    </div>
                ) : null}
            </div>
        </div>
    )
}

function renderToolInput(block: ToolCallBlock, surface: 'inline' | 'dialog' = 'inline'): ReactNode {
    const collapseLongContent = surface === 'inline'
    // The inline surface renders inside a role="button" preview, so the
    // wrap toggle's <button> would nest inside an interactive ancestor
    // (invalid HTML / hydration violation). Suppress it for inline; the
    // dialog surface (button-free) keeps the toggle.
    const codeBlockSurfaceProps = surface === 'dialog'
        ? { size: 'comfortable' as const, scrollY: true }
        : { showWrapToggle: false }
    const toolName = block.tool.name
    const input = block.tool.input

    // No invocation input (e.g. agy's async background-task results): show a
    // muted placeholder instead of dumping the literal "undefined"/"null".
    if (input === undefined || input === null) {
        return <div className="text-xs text-[var(--app-hint)]">—</div>
    }

    if (isSubagentToolName(toolName) && isObject(input) && typeof input.prompt === 'string') {
        return <MarkdownRenderer content={input.prompt} />
    }

    const commandArray = isObject(input) && Array.isArray(input.command) ? input.command : null
    if ((toolName === 'CodexBash' || toolName === 'Bash' || toolName === 'exec_command' || toolName === 'shell') && (typeof commandArray?.[0] === 'string' || typeof input === 'object')) {
        const cmd = Array.isArray(commandArray)
            ? commandArray.filter((part) => typeof part === 'string').join(' ')
            : getInputStringAny(input, ['command', 'cmd'])
        if (cmd) {
            return <CodeBlock code={cmd} language="bash" title="Command" collapseLongContent={collapseLongContent} {...codeBlockSurfaceProps} />
        }
    }

    return <CodeBlock code={safeStringify(input)} language="json" title="Input" collapseLongContent={collapseLongContent} {...codeBlockSurfaceProps} />
}

export function ToolStatusIcon(props: { state: ToolCallBlock['tool']['state'] }) {
    if (props.state === 'completed') {
        return (
            <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                <path d="M5.2 8.3l1.8 1.8 3.8-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        )
    }
    if (props.state === 'error') {
        return (
            <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
        )
    }
    if (props.state === 'pending') {
        return (
            <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none">
                <rect x="4.5" y="7" width="7" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M6 7V5.8a2 2 0 0 1 4 0V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
        )
    }
    return (
        <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.75" />
        </svg>
    )
}

// Three tones (DESIGN.md §2.3): done is grey, running is black, anything that
// needs a human (error, awaiting permission) is the red accent.
export function toolStatusColorClass(state: ToolCallBlock['tool']['state']): string {
    if (state === 'completed') return 'text-[var(--app-hint)]'
    if (state === 'error') return 'text-[var(--app-accent)]'
    if (state === 'pending') return 'text-[var(--app-accent)]'
    return 'text-[var(--app-fg)]'
}

/** Right-hand duration of a ledger row: 12px grey tabular figures. */
export function ToolRowDuration(props: { durationMs: number | null }) {
    if (props.durationMs == null) return null
    return (
        <span className="whitespace-nowrap text-xs tabular-nums text-[var(--app-hint)]">
            {formatDuration(props.durationMs)}
        </span>
    )
}

/** Plus that turns into a minus while its row is open (`.pw-plus`). */
export function LedgerPlus(props: { open: boolean }) {
    return (
        <span
            aria-hidden="true"
            className="pw-plus text-[var(--app-fg)]"
            data-open={props.open ? '' : undefined}
            data-state={props.open ? 'open' : 'closed'}
        />
    )
}

const INLINE_PREVIEW_INTERACTIVE_SELECTOR = 'a, button, input, textarea, select, summary, [role="button"], [contenteditable="true"]'

function isNestedInteractiveElement(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>): boolean {
    if (event.target === event.currentTarget) return false
    if (!(event.target instanceof Element)) return false

    const interactive = event.target.closest(INLINE_PREVIEW_INTERACTIVE_SELECTOR)
    return interactive !== null && interactive !== event.currentTarget
}

type ToolCardProps = {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    terminalToolDisplayMode: TerminalToolDisplayMode
    disabled: boolean
    onDone: () => void
    block: ToolCallBlock
}

export function ToolDetailDialogContent(props: {
    block: ToolCallBlock
    metadata: SessionMetadataSummary | null
    /** `inline` renders the same detail under an opened ledger row. */
    variant?: 'dialog' | 'inline'
    /** Close the surrounding dialog once the command went to the terminal. */
    onRunInTerminal?: () => void
}) {
    const { t } = useTranslation()
    const toolName = props.block.tool.name
    const FullToolView = getToolFullViewComponent(toolName)
    const ResultToolView = getToolResultViewComponent(toolName)
    const permission = props.block.tool.permission
    const isAskUserQuestion = isAskUserQuestionToolName(toolName)
    const isRequestUserInput = isRequestUserInputToolName(toolName)
    const isQuestionTool = isAskUserQuestion || isRequestUserInput
    const isQuestionToolWithAnswers = isQuestionTool
        && permission?.answers
        && Object.keys(permission.answers).length > 0
    return (
        <div className={props.variant === 'inline'
            ? 'flex min-w-0 flex-col gap-4'
            : 'mt-3 flex max-h-[75vh] flex-col gap-4 overflow-auto'}
        >
            <ToolTimingDetails block={props.block} />
            <div>
                <div className="mb-1 text-xs font-semibold text-[var(--app-hint)]">
                    {isQuestionToolWithAnswers ? t('tool.questionsAnswers') : t('tool.input')}
                </div>
                {FullToolView ? (
                    <FullToolView block={props.block} metadata={props.metadata} surface="dialog" />
                ) : (
                    renderToolInput(props.block, 'dialog')
                )}
                <RunInTerminalButton block={props.block} onDone={props.onRunInTerminal} className="mt-2" />
            </div>
            <TraceSection block={props.block} metadata={props.metadata} />
            {!isQuestionToolWithAnswers ? (
                <div>
                    <div className="mb-1 text-xs font-semibold text-[var(--app-hint)]">{t('tool.result')}</div>
                    <ResultToolView block={props.block} metadata={props.metadata} surface="dialog" />
                </div>
            ) : null}
        </div>
    )
}

function ToolCardInner(props: ToolCardProps) {
    const { t } = useTranslation()
    const [detailsOpen, setDetailsOpen] = useState(false)
    const [expanded, setExpanded] = useState(false)
    const timing = useToolTiming(props.block.tool)
    const presentation = useMemo(() => getToolPresentation({
        toolName: props.block.tool.name,
        input: props.block.tool.input,
        result: props.block.tool.result,
        childrenCount: props.block.children.length,
        description: props.block.tool.nativeTitle ?? props.block.tool.description,
        metadata: props.metadata
    }, t), [
        props.block.tool.name,
        props.block.tool.input,
        props.block.tool.result,
        props.block.children.length,
        props.block.tool.nativeTitle,
        props.block.tool.description,
        props.metadata,
        t
    ])

    const toolName = props.block.tool.name
    const toolTitle = presentation.title
    const subtitle = presentation.subtitle ?? props.block.tool.description
    const taskSummary = renderTaskSummary(props.block, props.metadata, t)
    const subagentModel = isSubagentToolName(toolName)
        ? getSubagentModel(props.block.children, getInputStringAny(props.block.tool.input, ['model']))
        : null
    const showInline = shouldShowInlineToolCardBody(toolName, presentation.minimal, props.terminalToolDisplayMode)
    const CompactToolView = showInline ? getToolViewComponent(toolName) : null
    const compactViewOwnsInteractions = toolName === 'CodexDiff'
    const ResultToolView = getToolResultViewComponent(toolName)
    const permission = props.block.tool.permission
    const isAskUserQuestion = isAskUserQuestionToolName(toolName)
    const isRequestUserInput = isRequestUserInputToolName(toolName)
    const isQuestionTool = isAskUserQuestion || isRequestUserInput
    const showsPermissionFooter = Boolean(permission && (
        permission.status === 'pending'
        || ((permission.status === 'denied' || permission.status === 'canceled') && Boolean(permission.reason))
    ))
    const answeredQuestions = useMemo(
        () => (isQuestionTool && !showInline ? getAnsweredQuestionItems(props.block.tool) : []),
        [isQuestionTool, showInline, props.block.tool]
    )
    const hasBody = showInline || taskSummary !== null || showsPermissionFooter || answeredQuestions.length > 0
    // Header/content padding already supplies 12-16px below timing; add only
    // the remainder needed to match the detail dialog's 16px section gap.
    const inlineBodySpacing = props.block.tool.state === 'pending'
        ? 'mt-3'
        : (subtitle ? 'mt-1' : 'mt-0')
    const stateColor = toolStatusColorClass(props.block.tool.state)
    const { suppressFocusRing, onTriggerPointerDown, onTriggerKeyDown, onTriggerBlur } = usePointerFocusRing()
    const inlineDetailInvokerRef = useRef<HTMLElement | null>(null)
    const openDetails = () => setDetailsOpen(true)
    const openDetailsFromInlinePreview = (event: MouseEvent<HTMLElement>) => {
        if (isNestedInteractiveElement(event)) return
        inlineDetailInvokerRef.current = event.currentTarget
        openDetails()
    }
    const openDetailsFromInlinePreviewKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        if (isNestedInteractiveElement(event)) return
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            inlineDetailInvokerRef.current = event.currentTarget
            openDetails()
        }
    }

    // The collapsed ledger row: plus · name · gist ··· status · duration.
    // Started/Finished timestamps live in the opened body.
    const row = (
        <button
            type="button"
            data-pw-tool-row=""
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            onPointerDown={onTriggerPointerDown}
            onKeyDown={onTriggerKeyDown}
            onBlur={onTriggerBlur}
            className={cn(
                'pw-row-fill flex w-full min-w-0 items-center gap-3 px-1 py-2.5 text-left',
                suppressFocusRing && 'outline-none focus-visible:outline-none'
            )}
        >
            <LedgerPlus open={expanded} />
            <span className={cn(
                'flex min-w-0 flex-1',
                // Name and gist stack on phones; a lone glyph stays beside the name.
                subtitle ? 'flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3' : 'items-center gap-3'
            )}>
                <CardTitle
                    className="min-w-0 shrink-0 truncate text-[15px] font-semibold leading-snug tracking-[-0.005em] text-[var(--app-fg)] sm:max-w-[55%]"
                    title={toolTitle}
                >
                    {toolTitle}
                </CardTitle>
                {/* Tool-kind glyph leads the gist so names line up with group rows. */}
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[var(--app-hint)]">
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center self-center leading-none" aria-hidden="true">
                        {presentation.icon}
                    </span>
                    {subtitle ? (
                        <CardDescription
                            className="min-w-0 flex-1 truncate font-mono text-[13px] leading-snug text-[var(--app-hint)]"
                            title={truncate(subtitle, 500)}
                        >
                            {truncate(subtitle, 160)}
                        </CardDescription>
                    ) : null}
                </span>
            </span>

            <span className="flex shrink-0 items-center gap-2.5">
                {subagentModel ? (
                    <span
                        className="inline-block max-w-28 truncate rounded-full border border-[var(--app-border)] px-1.5 py-px font-mono text-[10px] leading-tight text-[var(--app-hint)] sm:max-w-40"
                        title={subagentModel}
                    >
                        {subagentModel}
                    </span>
                ) : null}
                <span className={cn('flex items-center', stateColor)}>
                    <ToolStatusIcon state={props.block.tool.state} />
                </span>
                <ToolRowDuration durationMs={timing.durationMs} />
            </span>
        </button>
    )

    return (
        <Card
            data-pw-tool-card=""
            className="pw-ledger overflow-visible rounded-none border-0 bg-transparent shadow-none"
        >
            <CardHeader className="space-y-0 p-0">
                {row}
            </CardHeader>

            {expanded ? (
                <div className="pb-4 pl-7 pr-1 pt-1">
                    {showInline ? (
                        // Inline previews below already show input and result.
                        <div className="flex flex-col gap-2">
                            <ToolTimingSummary {...timing} />
                            <RunInTerminalButton block={props.block} />
                        </div>
                    ) : (
                        <ToolDetailDialogContent block={props.block} metadata={props.metadata} variant="inline" />
                    )}
                </div>
            ) : null}

            <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
                <DialogContent
                    className="max-w-2xl"
                    closeButtonClassName="top-2"
                    aria-describedby={undefined}
                    onCloseAutoFocus={(event) => {
                        const invoker = inlineDetailInvokerRef.current
                        if (!invoker?.isConnected) return
                        event.preventDefault()
                        invoker.focus()
                        inlineDetailInvokerRef.current = null
                    }}
                >
                    <DialogHeader className="text-left">
                        <DialogTitle>{toolTitle}</DialogTitle>
                    </DialogHeader>
                    <ToolDetailDialogContent
                        block={props.block}
                        metadata={props.metadata}
                        onRunInTerminal={() => setDetailsOpen(false)}
                    />
                </DialogContent>
            </Dialog>

            {hasBody ? (
                <CardContent className="pb-3 pl-7 pr-1 pt-0">
                    {taskSummary ? (
                        <div className="mt-1">
                            {taskSummary}
                        </div>
                    ) : null}

                    {answeredQuestions.length > 0 ? (
                        <div
                            className={cn(inlineBodySpacing, 'cursor-pointer')}
                            role="button"
                            tabIndex={0}
                            onClick={openDetailsFromInlinePreview}
                            onKeyDown={openDetailsFromInlinePreviewKeyDown}
                        >
                            <AnsweredQuestionsInline items={answeredQuestions} />
                        </div>
                    ) : null}

                    {showInline ? (
                        CompactToolView ? (
                            compactViewOwnsInteractions ? (
                                <div className={inlineBodySpacing}>
                                    <CompactToolView block={props.block} metadata={props.metadata} surface="inline" />
                                </div>
                            ) : <div
                                className={cn(inlineBodySpacing, 'cursor-pointer')}
                                role="button"
                                tabIndex={0}
                                onClick={openDetailsFromInlinePreview}
                                onKeyDown={openDetailsFromInlinePreviewKeyDown}
                            >
                                <CompactToolView block={props.block} metadata={props.metadata} surface="inline" />
                            </div>
                        ) : (
                            <div className={cn(inlineBodySpacing, 'flex flex-col gap-4')}>
                                <div
                                    className="cursor-pointer"
                                    role="button"
                                    tabIndex={0}
                                    onClick={openDetailsFromInlinePreview}
                                    onKeyDown={openDetailsFromInlinePreviewKeyDown}
                                >
                                    <div className="mb-1 text-xs font-semibold text-[var(--app-hint)]">{t('tool.input')}</div>
                                    {renderToolInput(props.block, 'inline')}
                                </div>
                                <div
                                    className="cursor-pointer"
                                    role="button"
                                    tabIndex={0}
                                    onClick={openDetailsFromInlinePreview}
                                    onKeyDown={openDetailsFromInlinePreviewKeyDown}
                                >
                                    <div className="mb-1 text-xs font-semibold text-[var(--app-hint)]">{t('tool.result')}</div>
                                    <ResultToolView block={props.block} metadata={props.metadata} surface="inline" />
                                </div>
                            </div>
                        )
                    ) : null}

                    {isAskUserQuestion && permission?.status === 'pending' ? (
                        <AskUserQuestionFooter
                            api={props.api}
                            sessionId={props.sessionId}
                            tool={props.block.tool}
                            disabled={props.disabled}
                            onDone={props.onDone}
                        />
                    ) : isRequestUserInput && permission?.status === 'pending' ? (
                        <RequestUserInputFooter
                            api={props.api}
                            sessionId={props.sessionId}
                            tool={props.block.tool}
                            disabled={props.disabled}
                            onDone={props.onDone}
                        />
                    ) : (
                        <PermissionFooter
                            api={props.api}
                            sessionId={props.sessionId}
                            metadata={props.metadata}
                            tool={props.block.tool}
                            disabled={props.disabled}
                            onDone={props.onDone}
                        />
                    )}
                </CardContent>
            ) : null}
        </Card>
    )
}

export const ToolCard = memo(ToolCardInner)
