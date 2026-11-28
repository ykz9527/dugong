import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getToolGroupItems, isReasoningGroupItem, type ToolGroupBlock, type ToolGroupItem } from '@/chat/toolGroups'
import type { ToolCallBlock } from '@/chat/types'
import { getCodexCommandActions, isCodexExplorationTool, type CodexCommandAction } from '@/chat/codexCommandPresentation'
import type { SessionMetadataSummary } from '@/types/api'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { getToolTimingDetails, LedgerPlus, ToolDetailDialogContent, ToolRowDuration, ToolStatusIcon, ToolTimingSummary, toolStatusColorClass } from '@/components/ToolCard/ToolCard'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { BulbIcon } from '@/components/ToolCard/icons'
import {
    extractReasoningPreviewLine,
    formatCodexExplorationPreview,
    formatGroupedHeaderTitle,
    pickGroupedPreviewTool,
    safeGroupedLabelValue
} from '@/components/ToolCard/groupedPresentation'
import { toolDurationMs } from '@/components/ToolCard/toolDuration'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getInputStringAny } from '@/lib/toolInputUtils'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

const TIMING_INTERVAL_MS = 1000
const INITIAL_VISIBLE_ITEMS = 15
const SHOW_BOTTOM_COLLAPSE_THRESHOLD = 8

export function getToolGroupTiming(tools: ToolCallBlock[], now: number): {
    startedAt: number | null
    completedAt: number | null
    durationMs: number | null
    running: boolean
} {
    const running = tools.some((tool) => tool.tool.state === 'running')
    const finishedTools = tools.filter((tool) => tool.tool.state === 'completed' || tool.tool.state === 'error')
    const allFinished = tools.length > 0 && finishedTools.length === tools.length

    // Prefer execution-machine timestamps when every tool in a completed group
    // carries both ends of the pair (matches toolDurationMs clock consistency).
    const allHaveExecPair = allFinished && tools.every((tool) => (
        tool.tool.execStartedAt != null
        && Number.isFinite(tool.tool.execStartedAt)
        && tool.tool.execCompletedAt != null
        && Number.isFinite(tool.tool.execCompletedAt)
    ))

    if (allHaveExecPair) {
        const startedAt = Math.min(...tools.map((tool) => tool.tool.execStartedAt as number))
        const completedAt = Math.max(...tools.map((tool) => tool.tool.execCompletedAt as number))
        const durationMs = completedAt >= startedAt ? completedAt - startedAt : null
        return { startedAt, completedAt, durationMs, running: false }
    }

    const startedValues = tools
        .filter((tool) => tool.tool.state !== 'pending')
        .map((tool) => tool.tool.startedAt ?? tool.tool.createdAt)
        .filter((value): value is number => Number.isFinite(value))
    const startedAt = startedValues.length > 0 ? Math.min(...startedValues) : null

    const completedValues = allFinished
        ? tools
            .map((tool) => tool.tool.completedAt)
            .filter((value): value is number => value != null && Number.isFinite(value))
        : []
    const completedAt = allFinished && completedValues.length > 0 ? Math.max(...completedValues) : null

    const durationEnd = running ? now : completedAt
    let durationMs = startedAt != null && durationEnd != null && durationEnd >= startedAt
        ? durationEnd - startedAt
        : null

    if (durationMs === null && allFinished) {
        const knownDurations = tools
            .map((tool) => toolDurationMs(tool.tool))
            .filter((value): value is number => value != null && Number.isFinite(value))
        if (knownDurations.length > 0) {
            durationMs = knownDurations.reduce((sum, value) => sum + value, 0)
        }
    }

    return { startedAt, completedAt, durationMs, running }
}

// Header and row badges are plain 12px labels in the three tones
// (DESIGN.md §2.3): running is black, pending and errors are red, counts grey.
function SummaryBadge(props: { className: string; text: string }) {
    return (
        <span className={cn('inline-flex items-center whitespace-nowrap text-xs', props.className)}>
            {props.text}
        </span>
    )
}

const BADGE_RUNNING = 'font-semibold text-[var(--app-fg)]'
const BADGE_ATTENTION = 'font-semibold text-[var(--app-accent)]'

function RowStatusBadge(props: { block: ToolCallBlock }) {
    const { t } = useTranslation()
    if (props.block.tool.state === 'error') {
        return <SummaryBadge className={BADGE_ATTENTION} text={t('toolGroup.rowStatus.error')} />
    }
    if (props.block.tool.state === 'running') {
        return <SummaryBadge className={BADGE_RUNNING} text={t('toolGroup.rowStatus.running')} />
    }
    if (props.block.tool.state === 'pending') {
        return <SummaryBadge className={BADGE_ATTENTION} text={t('toolGroup.rowStatus.pending')} />
    }
    return null
}

function RowLabel(props: { block: ToolCallBlock; metadata: SessionMetadataSummary | null }) {
    const { t } = useTranslation()
    const presentation = useMemo(() => getToolPresentation({
        toolName: props.block.tool.name,
        input: props.block.tool.input,
        result: props.block.tool.result,
        childrenCount: props.block.children.length,
        description: props.block.tool.nativeTitle ?? props.block.tool.description,
        metadata: props.metadata
    }, t), [props.block, props.metadata, t])

    return (
        <span className={cn(
            'flex min-w-0 flex-1',
            presentation.subtitle ? 'flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3' : 'items-center gap-3'
        )}>
            <span className="min-w-0 shrink-0 truncate whitespace-nowrap text-sm font-semibold text-[var(--app-fg)] sm:max-w-[55%]">
                {presentation.title}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[var(--app-hint)]">
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center self-center leading-none" aria-hidden="true">
                    {presentation.icon}
                </span>
                {presentation.subtitle ? (
                    <span className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-[13px]">
                        {presentation.subtitle}
                    </span>
                ) : null}
            </span>
        </span>
    )
}

function basename(value: string): string {
    return value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? value
}

function codexActionLabel(
    action: CodexCommandAction,
    t: (key: string, params?: Record<string, string | number>) => string
): { title: string; detail: string | null } {
    if (action.type === 'read') {
        const detail = safeGroupedLabelValue(action.name) ?? safeGroupedLabelValue(action.path)
        return { title: t('toolGroup.codex.read'), detail: detail ? basename(detail) : null }
    }
    if (action.type === 'listFiles') {
        return { title: t('toolGroup.codex.list'), detail: safeGroupedLabelValue(action.path) }
    }
    if (action.type === 'search') {
        const query = safeGroupedLabelValue(action.query)
        const path = safeGroupedLabelValue(action.path)
        return {
            title: t('toolGroup.codex.search'),
            detail: query && path
                ? t('toolGroup.codex.searchIn', { query, path })
                : query ?? path
        }
    }
    return { title: t('toolGroup.friendly.genericCommand'), detail: null }
}

// Nested rows sit on hairlines inside the group's grey body; hover lifts a
// page-coloured wash (the grey wash would vanish on the grey surface).
const NESTED_ROW_CLASS = 'pw-ledger pw-row-fill before:!bg-[var(--app-bg)] flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left'

function getReasoningMarkdown(item: ToolGroupItem): string {
    if (item.kind === 'agent-reasoning') return item.text
    if (item.kind === 'tool-call' && item.tool.name === 'CodexReasoning') {
        const title = getInputStringAny(item.tool.input, ['title'])
        const body = getInputStringAny(item.tool.input, ['text', 'summary'])
            ?? (typeof item.tool.result === 'string' ? item.tool.result : null)
        if (title && body && body !== title) return `**${title}**\n\n${body}`
        return body ?? title ?? ''
    }
    return ''
}

function InlineReasoningRow(props: {
    item: ToolGroupItem
    isStreaming: boolean
}) {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useState(false)
    const preview = useMemo(() => extractReasoningPreviewLine(props.item), [props.item])
    const markdown = useMemo(() => getReasoningMarkdown(props.item), [props.item])

    return (
        <div className="pw-ledger">
            <button
                type="button"
                className="pw-row-fill before:!bg-[var(--app-bg)] flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
            >
                <span className="flex shrink-0 items-center text-[var(--app-hint)]" aria-hidden="true">
                    <BulbIcon className="h-3.5 w-3.5" />
                </span>
                <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
                    <span className="shrink-0 text-[13px] font-semibold text-[var(--app-hint)]">
                        {t('toolGroup.reasoning.label')}
                    </span>
                    {preview ? (
                        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--app-hint)]">
                            {preview}
                        </span>
                    ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                    {props.isStreaming ? (
                        <span
                            className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--app-fg)] animate-pulse"
                            aria-label={t('toolGroup.reasoning.thinking')}
                        />
                    ) : null}
                    <LedgerPlus open={expanded} />
                </span>
            </button>
            {expanded && markdown ? (
                <div className="px-3 pb-3 pl-9 pt-1 text-[13.5px] text-[var(--app-hint)]">
                    <MarkdownRenderer content={markdown} />
                </div>
            ) : null}
        </div>
    )
}

function CodexExplorationToolRows(props: {
    tool: ToolCallBlock
    now: number
    onSelect: (toolId: string) => void
}) {
    const { t } = useTranslation()
    const actions = getCodexCommandActions(props.tool)
    const timing = getToolTimingDetails(props.tool.tool, props.now)

    return (
        <>
            {actions.map((action, index) => {
                const label = codexActionLabel(action, t)
                const isLastAction = index === actions.length - 1
                return (
                    <button
                        key={`${props.tool.id}:${index}`}
                        type="button"
                        className={NESTED_ROW_CLASS}
                        onClick={() => props.onSelect(props.tool.id)}
                    >
                        <span className={cn('flex shrink-0 items-center', toolStatusColorClass(props.tool.tool.state))}>
                            <ToolStatusIcon state={props.tool.tool.state} />
                        </span>
                        <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
                            <span className="shrink-0 text-sm font-semibold text-[var(--app-fg)]">
                                {label.title}
                            </span>
                            {label.detail ? (
                                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-[var(--app-hint)]">
                                    {label.detail}
                                </span>
                            ) : null}
                        </span>
                        {isLastAction ? (
                            <span className="flex shrink-0 items-center gap-2.5">
                                <RowStatusBadge block={props.tool} />
                                <ToolRowDuration durationMs={timing.durationMs} />
                            </span>
                        ) : null}
                    </button>
                )
            })}
        </>
    )
}

type HeaderPreview = {
    icon: ReactNode | null
    text: string
    mono: boolean
    isError: boolean
}

function buildHeaderPreview(
    block: ToolGroupBlock,
    metadata: SessionMetadataSummary | null,
    t: (key: string, params?: Record<string, string | number>) => string
): HeaderPreview | null {
    const picked = pickGroupedPreviewTool(block)

    // 1. Live running tool always takes top priority.
    if (picked?.reason === 'running') {
        return formatToolPreview(picked.tool, metadata, t, false)
    }

    // 2. Live streaming reasoning when no tool is currently running.
    if (block.streamingReasoning) {
        const lastItem = getToolGroupItems(block).at(-1)
        const line = lastItem ? extractReasoningPreviewLine(lastItem) : null
        return {
            icon: <BulbIcon className="h-3.5 w-3.5" />,
            text: line ?? t('toolGroup.reasoning.thinking'),
            mono: false,
            isError: false,
        }
    }

    // 3. Error tool or latest tool.
    if (picked) {
        return formatToolPreview(picked.tool, metadata, t, picked.reason === 'error')
    }

    return null
}

function formatToolPreview(
    tool: ToolCallBlock,
    metadata: SessionMetadataSummary | null,
    t: (key: string, params?: Record<string, string | number>) => string,
    isError: boolean
): HeaderPreview {
    const presentation = getToolPresentation({
        toolName: tool.tool.name,
        input: tool.tool.input,
        result: tool.tool.result,
        childrenCount: tool.children.length,
        description: tool.tool.nativeTitle ?? tool.tool.description,
        metadata
    }, t)

    if (isCodexExplorationTool(tool)) {
        const codexPreview = formatCodexExplorationPreview(tool, t)
        if (codexPreview) {
            return {
                icon: presentation.icon,
                text: codexPreview,
                mono: true,
                isError,
            }
        }
    }

    let text: string
    if (presentation.subtitle) {
        const title = presentation.title.trim()
        const subtitle = presentation.subtitle.trim()
        // Avoid repeating the command prefix when subtitle already starts with title
        // (e.g. title="bun run test", subtitle="bun run test -- foo.test.ts") or when
        // title is the generic "Terminal" fallback.
        text = title === 'Terminal' || subtitle.startsWith(title)
            ? subtitle
            : `${title} ${subtitle}`
    } else {
        text = presentation.title
    }

    return {
        icon: presentation.icon,
        text: text.replace(/\s+/g, ' ').trim(),
        mono: true,
        isError,
    }
}

export function ToolGroupCard(props: {
    block: ToolGroupBlock
    metadata: SessionMetadataSummary | null
}) {
    const { t } = useTranslation()
    const ctx = useHappyChatContext()
    const [open, setOpen] = useState(props.block.defaultOpen)
    const [showAllItems, setShowAllItems] = useState(false)
    const [selectedToolId, setSelectedToolId] = useState<string | null>(null)
    const [isHydratingHistory, setIsHydratingHistory] = useState(false)
    const [historyExhausted, setHistoryExhausted] = useState(false)
    const [now, setNow] = useState(() => Date.now())
    const hydrationRunRef = useRef(0)
    const groupTiming = getToolGroupTiming(props.block.tools, now)
    const allItems = useMemo(() => getToolGroupItems(props.block), [props.block])

    useEffect(() => {
        if (!groupTiming.running) return
        setNow(Date.now())
        const id = setInterval(() => setNow(Date.now()), TIMING_INTERVAL_MS)
        return () => clearInterval(id)
    }, [groupTiming.running, groupTiming.startedAt])

    useEffect(() => {
        hydrationRunRef.current += 1
        setOpen(props.block.defaultOpen)
        setShowAllItems(false)
        setSelectedToolId(null)
        setIsHydratingHistory(false)
        setHistoryExhausted(false)
    }, [props.block.id, props.block.defaultOpen])

    useEffect(() => {
        if (!open) {
            hydrationRunRef.current += 1
            setIsHydratingHistory(false)
            setHistoryExhausted(false)
            return
        }
        if (!props.block.needsOlderHistory) {
            hydrationRunRef.current += 1
            setIsHydratingHistory(false)
            setHistoryExhausted(false)
            return
        }
        if (isHydratingHistory || historyExhausted) {
            return
        }
        if (ctx.isSyncingTail || ctx.isLoadingMoreMessages) {
            return
        }
        if (!ctx.hasMoreMessages) {
            hydrationRunRef.current += 1
            setIsHydratingHistory(false)
            setHistoryExhausted(true)
            return
        }

        const runId = hydrationRunRef.current + 1
        hydrationRunRef.current = runId
        setHistoryExhausted(false)
        setIsHydratingHistory(true)
        void ctx.loadOlderMessagesPreservingScroll()
            .then((result) => {
                if (hydrationRunRef.current !== runId) return
                setIsHydratingHistory(false)
                if (result === 'terminal-stop') {
                    setHistoryExhausted(true)
                }
            })
            .catch(() => {
                if (hydrationRunRef.current !== runId) return
                setIsHydratingHistory(false)
                setHistoryExhausted(true)
            })
    }, [
        open,
        props.block.needsOlderHistory,
        ctx.hasMoreMessages,
        ctx.isSyncingTail,
        ctx.isLoadingMoreMessages,
        ctx.loadOlderMessagesPreservingScroll,
        historyExhausted,
        isHydratingHistory,
    ])

    const selectedTool = useMemo(
        () => props.block.tools.find((tool) => tool.id === selectedToolId) ?? null,
        [props.block.tools, selectedToolId]
    )
    const selectedPresentation = useMemo(() => {
        if (!selectedTool) return null
        return getToolPresentation({
            toolName: selectedTool.tool.name,
            input: selectedTool.tool.input,
            result: selectedTool.tool.result,
            childrenCount: selectedTool.children.length,
            description: selectedTool.tool.nativeTitle ?? selectedTool.tool.description,
            metadata: props.metadata
        }, t)
    }, [selectedTool, props.metadata, t])

    const primaryTitle = formatGroupedHeaderTitle(props.block, t)
    const headerPreview = useMemo(
        () => buildHeaderPreview(props.block, props.metadata, t),
        [props.block, props.metadata, t]
    )

    const hiddenItemCount = !showAllItems && allItems.length > INITIAL_VISIBLE_ITEMS
        ? allItems.length - INITIAL_VISIBLE_ITEMS
        : 0
    const visibleItems = hiddenItemCount > 0 ? allItems.slice(-INITIAL_VISIBLE_ITEMS) : allItems

    const rightMeta = (
        <>
            {props.block.summary.runningCount > 1 ? (
                <SummaryBadge
                    className={BADGE_RUNNING}
                    text={t('toolGroup.badge.running', { n: props.block.summary.runningCount })}
                />
            ) : null}
            {props.block.summary.pendingCount > 0 ? (
                <SummaryBadge
                    className={BADGE_ATTENTION}
                    text={t('toolGroup.badge.pending', { n: props.block.summary.pendingCount })}
                />
            ) : null}
            {props.block.summary.errorCount > 0 ? (
                <SummaryBadge
                    className={BADGE_ATTENTION}
                    text={t('toolGroup.badge.error', { n: props.block.summary.errorCount })}
                />
            ) : null}
            {groupTiming.running ? (
                <span className={cn('flex items-center', toolStatusColorClass('running'))} aria-label={t('toolGroup.rowStatus.running')}>
                    <ToolStatusIcon state="running" />
                </span>
            ) : props.block.streamingReasoning ? (
                <span
                    className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--app-fg)] animate-pulse"
                    aria-label={t('toolGroup.reasoning.thinking')}
                />
            ) : null}
            <ToolRowDuration durationMs={groupTiming.durationMs} />
        </>
    )

    return (
        <Card data-pw-tool-group="" className="pw-ledger overflow-visible rounded-none bg-transparent shadow-none">
            <CardHeader className="space-y-0 p-0">
                <button
                    type="button"
                    onClick={() => setOpen((value) => !value)}
                    className="pw-row-fill grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-1 py-2.5 text-left sm:flex"
                    aria-expanded={open}
                >
                    <span className="flex shrink-0 items-center">
                        <LedgerPlus open={open} />
                    </span>
                    <CardTitle className="min-w-0 truncate whitespace-nowrap text-[14px] font-semibold leading-snug tracking-[-0.005em] text-[var(--app-fg)] sm:shrink-0 sm:text-[15px]">
                        {primaryTitle}
                    </CardTitle>
                    <span className="flex shrink-0 items-center gap-2 sm:order-4 sm:gap-2.5">
                        {rightMeta}
                    </span>
                    {!open && headerPreview ? (
                        <span className={cn(
                            'col-start-2 col-end-4 flex min-w-0 items-center gap-1.5 sm:order-3 sm:flex-1',
                            headerPreview.isError ? 'text-[var(--app-accent)]' : 'text-[var(--app-hint)]'
                        )}>
                            {headerPreview.icon ? (
                                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center self-center leading-none" aria-hidden="true">
                                    {headerPreview.icon}
                                </span>
                            ) : null}
                            <span className={cn(
                                'min-w-0 flex-1 truncate whitespace-nowrap text-[13px]',
                                headerPreview.mono ? 'font-mono' : 'font-normal'
                            )}>
                                {headerPreview.text}
                            </span>
                        </span>
                    ) : null}
                </button>
            </CardHeader>

            {open ? (
                <CardContent className="pb-3 pl-5 pr-1 pt-1 sm:pl-7">
                    <div className="mb-2">
                        <ToolTimingSummary
                            startedAt={groupTiming.startedAt}
                            completedAt={groupTiming.completedAt}
                            durationMs={groupTiming.durationMs}
                            typography="group"
                        />
                    </div>
                    <div className="flex flex-col bg-[var(--app-tool-group-bg)]">
                        {hiddenItemCount > 0 ? (
                            <button
                                type="button"
                                className="pw-ledger pw-row-fill before:!bg-[var(--app-bg)] flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                                onClick={() => setShowAllItems(true)}
                            >
                                {t('toolGroup.showEarlier', { n: hiddenItemCount })}
                            </button>
                        ) : null}

                        {visibleItems.map((item, idx) => {
                            const isLastItem = idx === visibleItems.length - 1
                            if (isReasoningGroupItem(item) || item.kind !== 'tool-call') {
                                return (
                                    <InlineReasoningRow
                                        key={`reasoning:${item.id}`}
                                        item={item}
                                        isStreaming={Boolean(props.block.streamingReasoning && isLastItem)}
                                    />
                                )
                            }
                            if (isCodexExplorationTool(item) && getCodexCommandActions(item).length > 0) {
                                return (
                                    <CodexExplorationToolRows
                                        key={item.id}
                                        tool={item}
                                        now={now}
                                        onSelect={setSelectedToolId}
                                    />
                                )
                            }
                            const timing = getToolTimingDetails(item.tool, now)
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    className={NESTED_ROW_CLASS}
                                    onClick={() => setSelectedToolId(item.id)}
                                >
                                    <span className={cn('flex shrink-0 items-center', toolStatusColorClass(item.tool.state))}>
                                        <ToolStatusIcon state={item.tool.state} />
                                    </span>
                                    <RowLabel block={item} metadata={props.metadata} />
                                    <span className="flex shrink-0 items-center gap-2.5">
                                        <RowStatusBadge block={item} />
                                        <ToolRowDuration durationMs={timing.durationMs} />
                                    </span>
                                </button>
                            )
                        })}

                        {visibleItems.length > SHOW_BOTTOM_COLLAPSE_THRESHOLD ? (
                            <button
                                type="button"
                                className="pw-ledger pw-row-fill before:!bg-[var(--app-bg)] flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs font-semibold text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                                onClick={() => setOpen(false)}
                            >
                                <LedgerPlus open={true} />
                                <span>{t('toolGroup.collapse')}</span>
                            </button>
                        ) : null}
                    </div>

                    {isHydratingHistory ? (
                        <div className="mt-3 text-xs text-[var(--app-hint)]">
                            {t('toolGroup.loadingOlderHistory')}
                        </div>
                    ) : null}
                    {!isHydratingHistory && historyExhausted && props.block.needsOlderHistory ? (
                        <div className="mt-3 text-xs text-[var(--app-hint)]">
                            {t('toolGroup.historyUnavailable')}
                        </div>
                    ) : null}
                </CardContent>
            ) : null}

            <Dialog open={selectedTool !== null} onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                    setSelectedToolId(null)
                }
            }}>
                <DialogContent className="max-w-2xl" closeButtonClassName="top-2" aria-describedby={undefined}>
                    {selectedTool && selectedPresentation ? (
                        <>
                            <DialogHeader className="text-left">
                                <DialogTitle>{selectedPresentation.title}</DialogTitle>
                            </DialogHeader>
                            <ToolDetailDialogContent
                                block={selectedTool}
                                metadata={props.metadata}
                                onRunInTerminal={() => setSelectedToolId(null)}
                            />
                        </>
                    ) : null}
                </DialogContent>
            </Dialog>
        </Card>
    )
}
