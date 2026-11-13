import { useEffect, useMemo, useRef, useState } from 'react'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import type { ToolCallBlock } from '@/chat/types'
import { getCodexCommandActions, type CodexCommandAction } from '@/chat/codexCommandPresentation'
import type { SessionMetadataSummary } from '@/types/api'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { getToolTimingDetails, LedgerPlus, ToolDetailDialogContent, ToolRowDuration, ToolStatusIcon, ToolTimingSummary, toolStatusColorClass } from '@/components/ToolCard/ToolCard'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { formatGroupedHeaderSubtitle, formatGroupedHeaderTitle, safeGroupedLabelValue } from '@/components/ToolCard/groupedPresentation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

const TIMING_INTERVAL_MS = 1000

export function getToolGroupTiming(tools: ToolCallBlock[], now: number): {
    startedAt: number | null
    completedAt: number | null
    durationMs: number | null
    running: boolean
} {
    const startedValues = tools
        .filter((tool) => tool.tool.state !== 'pending')
        .map((tool) => tool.tool.startedAt ?? tool.tool.createdAt)
        .filter((value): value is number => Number.isFinite(value))
    const startedAt = startedValues.length > 0 ? Math.min(...startedValues) : null
    const running = tools.some((tool) => tool.tool.state === 'running')
    const allFinished = tools.length > 0 && tools.every((tool) => tool.tool.state === 'completed' || tool.tool.state === 'error')
    const completedValues = allFinished
        ? tools.map((tool) => tool.tool.completedAt).filter((value): value is number => value != null && Number.isFinite(value))
        : []
    const completedAt = allFinished && completedValues.length === tools.length ? Math.max(...completedValues) : null
    const durationEnd = running ? now : completedAt
    const durationMs = startedAt != null && durationEnd != null && durationEnd >= startedAt
        ? durationEnd - startedAt
        : null

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
const BADGE_COUNT = 'font-normal text-[var(--app-hint)]'

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

function formatActionSummary(block: ToolGroupBlock, t: (key: string, params?: Record<string, string | number>) => string): string | null {
    const parts: string[] = []
    const { countsByKind } = block.summary

    if (countsByKind.mutation > 0) {
        parts.push(t('toolGroup.summary.mutation', { n: countsByKind.mutation }))
    }
    if (countsByKind.read > 0) {
        parts.push(t('toolGroup.summary.read', { n: countsByKind.read }))
    }
    if (countsByKind.command > 0) {
        parts.push(t('toolGroup.summary.command', { n: countsByKind.command }))
    }
    if (countsByKind.search > 0) {
        parts.push(t('toolGroup.summary.search', { n: countsByKind.search }))
    }
    if (countsByKind.web > 0) {
        parts.push(t('toolGroup.summary.web', { n: countsByKind.web }))
    }
    if (countsByKind.other > 0 && parts.length > 0) {
        parts.push(t('toolGroup.summary.other', { n: countsByKind.other }))
    }

    return parts.length > 0 ? parts.join(' · ') : null
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

function CodexExplorationRows(props: {
    tools: ToolCallBlock[]
    onSelect: (toolId: string) => void
}) {
    const { t } = useTranslation()
    return props.tools.flatMap((tool) => (
        getCodexCommandActions(tool).map((action, index) => {
            const label = codexActionLabel(action, t)
            return (
                <button
                    key={`${tool.id}:${index}`}
                    type="button"
                    className={NESTED_ROW_CLASS}
                    onClick={() => props.onSelect(tool.id)}
                >
                    <span className="text-xs text-[var(--app-hint)]" aria-hidden="true">└</span>
                    <span className="shrink-0 text-sm font-semibold text-[var(--app-fg)]">
                        {label.title}
                    </span>
                    {label.detail ? (
                        <span className="min-w-0 truncate font-mono text-[13px] text-[var(--app-hint)]">
                            {label.detail}
                        </span>
                    ) : null}
                </button>
            )
        })
    ))
}

export function ToolGroupCard(props: {
    block: ToolGroupBlock
    metadata: SessionMetadataSummary | null
}) {
    const { t } = useTranslation()
    const ctx = useHappyChatContext()
    const [open, setOpen] = useState(props.block.defaultOpen)
    const [selectedToolId, setSelectedToolId] = useState<string | null>(null)
    const [isHydratingHistory, setIsHydratingHistory] = useState(false)
    const [historyExhausted, setHistoryExhausted] = useState(false)
    const [now, setNow] = useState(() => Date.now())
    const hydrationRunRef = useRef(0)
    const groupTiming = getToolGroupTiming(props.block.tools, now)

    useEffect(() => {
        if (!groupTiming.running) return
        setNow(Date.now())
        const id = setInterval(() => setNow(Date.now()), TIMING_INTERVAL_MS)
        return () => clearInterval(id)
    }, [groupTiming.running, groupTiming.startedAt])

    useEffect(() => {
        hydrationRunRef.current += 1
        setOpen(props.block.defaultOpen)
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
    const subtitle = props.block.presentationMode === 'codex-exploration'
        ? null
        : formatGroupedHeaderSubtitle(props.block, t) ?? formatActionSummary(props.block, t)
    const summaryBadgeText = props.block.presentationMode === 'codex-exploration'
        ? null
        : subtitle ?? t('toolGroup.toolCount', { n: props.block.tools.length })
    const fileCount = props.block.summary.fileTargets.length

    return (
        <Card data-pw-tool-group="" className="pw-ledger overflow-visible rounded-none bg-transparent shadow-none">
            <CardHeader className="space-y-0 p-0">
                <button
                    type="button"
                    onClick={() => setOpen((value) => !value)}
                    className="pw-row-fill flex w-full min-w-0 items-center gap-3 px-1 py-2.5 text-left"
                    aria-expanded={open}
                >
                    <LedgerPlus open={open} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                        <CardTitle className="min-w-0 truncate whitespace-nowrap text-[15px] font-semibold leading-snug tracking-[-0.005em] text-[var(--app-fg)]">
                            {primaryTitle}
                        </CardTitle>
                        {summaryBadgeText ? (
                            <SummaryBadge
                                className="min-w-0 truncate text-xs font-normal text-[var(--app-hint)]"
                                text={summaryBadgeText}
                            />
                        ) : null}
                    </span>

                    <span className="flex shrink-0 items-center gap-2.5">
                        {props.block.summary.runningCount > 0 ? (
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
                        {fileCount > 0 ? (
                            <SummaryBadge
                                className={BADGE_COUNT}
                                text={t('toolGroup.badge.fileTargets', { n: fileCount })}
                            />
                        ) : null}
                        {groupTiming.running ? (
                            <span className={cn('flex items-center', toolStatusColorClass('running'))} aria-label={t('toolGroup.rowStatus.running')}>
                                <ToolStatusIcon state="running" />
                            </span>
                        ) : null}
                        <ToolRowDuration durationMs={groupTiming.durationMs} />
                    </span>
                </button>
            </CardHeader>

            {open ? (
                <CardContent className="pb-3 pl-7 pr-1 pt-1">
                    <div className="mb-2">
                        <ToolTimingSummary
                            startedAt={groupTiming.startedAt}
                            completedAt={groupTiming.completedAt}
                            durationMs={groupTiming.durationMs}
                            typography="group"
                        />
                    </div>
                    <div className="flex flex-col bg-[var(--app-tool-group-bg)]">
                        {props.block.presentationMode === 'codex-exploration' ? (
                            <CodexExplorationRows tools={props.block.tools} onSelect={setSelectedToolId} />
                        ) : props.block.tools.map((tool) => {
                            const timing = getToolTimingDetails(tool.tool, now)
                            return (
                                <button
                                    key={tool.id}
                                    type="button"
                                    className={NESTED_ROW_CLASS}
                                    onClick={() => setSelectedToolId(tool.id)}
                                >
                                    <span className={cn('flex shrink-0 items-center', toolStatusColorClass(tool.tool.state))}>
                                        <ToolStatusIcon state={tool.tool.state} />
                                    </span>
                                    <RowLabel block={tool} metadata={props.metadata} />
                                    <span className="flex shrink-0 items-center gap-2.5">
                                        <RowStatusBadge block={tool} />
                                        <ToolRowDuration durationMs={timing.durationMs} />
                                    </span>
                                </button>
                            )
                        })}
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
                            <ToolDetailDialogContent block={selectedTool} metadata={props.metadata} />
                        </>
                    ) : null}
                </DialogContent>
            </Dialog>
        </Card>
    )
}
