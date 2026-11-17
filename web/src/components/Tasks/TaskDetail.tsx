import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
    getDefaultPermissionModeForFlavor,
    getPermissionModeOptionsForFlavor,
    TASK_COLUMNS,
    type PermissionMode,
    type Task,
    type TaskColumn,
    type TaskPullRequest,
    type TaskRun
} from '@hapi/protocol'
import { readableError, type ApiClient } from '@/api/client'
import { Button } from '@/components/ui/button'
import type { Session } from '@/types/api'
import { approveForSessionOptions } from '@/lib/permissionApproval'
import { queryKeys } from '@/lib/query-keys'
import { formatTaskError } from '@/lib/taskError'
import { useTranslation } from '@/lib/use-translation'
import { TaskColumnSelect } from './TaskColumnSelect'
import { TaskScheduleSection } from './TaskScheduleSection'

/**
 * Task detail, opened from a row in the task list.
 *
 * The reason this exists is the `blocked` column: a task can say "the agent is
 * waiting on you", and answering should not mean opening the chat. Everything
 * an operator needs to unblock a task — see what is being asked, approve or
 * refuse it, then start or stop the run — belongs where the question is raised.
 *
 * Anything that needs the actual conversation still links out to the session.
 */

/** One-line gist of what a tool wants to do, from its arguments. */
export function describeToolRequest(tool: string, args: unknown): string | null {
    if (!args || typeof args !== 'object') return null
    const record = args as Record<string, unknown>
    const pick = (key: string): string | null => {
        const value = record[key]
        return typeof value === 'string' && value.length > 0 ? value : null
    }
    // Ordered by how much the field tells you about the request.
    return pick('command')
        ?? pick('file_path')
        ?? pick('path')
        ?? pick('pattern')
        ?? pick('url')
        ?? pick('question')
        ?? null
}


/** The path a task walks. `blocked` is a fault off the path, shown at Running. */
const LIFECYCLE: TaskColumn[] = TASK_COLUMNS.filter((column) => column !== 'blocked')

/**
 * Where the task is on its way from Backlog to Done (DESIGN.md "Lifecycle
 * ruler"): a ruler with a tall tick per step, a red fill drawn up to a red
 * marker at the current step. Steps the marker has passed are black with a
 * red number; steps ahead are grey. Archived tasks are out of the lifecycle,
 * so the whole ruler goes grey.
 */
function LifecycleRuler(props: { column: TaskColumn; archived: boolean }) {
    const { t } = useTranslation()
    const blocked = props.column === 'blocked'
    const current = LIFECYCLE.indexOf(blocked ? 'running' : props.column)
    const reach = `${((current + 1) / LIFECYCLE.length) * 100}%`
    const ink = props.archived ? 'var(--app-hint)' : 'var(--app-fg)'
    const mark = props.archived ? 'bg-[var(--p-grey-3)]' : 'bg-[var(--app-accent)]'

    // The fill draws in when the panel opens: render at zero, then let the
    // transition carry it to the step on the next frame.
    const [drawn, setDrawn] = useState(false)
    useEffect(() => {
        let inner = 0
        const outer = requestAnimationFrame(() => {
            inner = requestAnimationFrame(() => setDrawn(true))
        })
        return () => {
            cancelAnimationFrame(outer)
            cancelAnimationFrame(inner)
        }
    }, [])
    const motion = 'transition-transform duration-[1100ms] ease-[var(--ease-rule)] motion-reduce:transition-none'

    const scale: CSSProperties = {
        borderRight: `1px solid ${ink}`,
        background: [
            `linear-gradient(${ink}, ${ink}) 0 100% / 100% 1px no-repeat`,
            `repeating-linear-gradient(to right, ${ink} 0 1px, transparent 1px calc(100% / ${LIFECYCLE.length})) 0 100% / 100% 18px no-repeat`,
            `repeating-linear-gradient(to right, ${ink} 0 1px, transparent 1px calc(100% / ${LIFECYCLE.length * 5})) 0 100% / 100% 6px no-repeat`
        ].join(', ')
    }

    return (
        <div className="relative">
            <div aria-hidden="true" className="relative h-6" style={scale}>
                <div
                    className={`absolute bottom-[-1px] left-0 h-[3px] origin-left ${mark} ${motion} ${drawn ? 'scale-x-100' : 'scale-x-0'}`}
                    style={{ width: reach }}
                />
            </div>
            <ol className="grid" style={{ gridTemplateColumns: `repeat(${LIFECYCLE.length}, minmax(0, 1fr))` }}>
                {LIFECYCLE.map((column, index) => {
                    const passed = !props.archived && index <= current
                    return (
                        <li
                            key={column}
                            aria-current={index === current ? 'step' : undefined}
                            className="flex min-w-0 flex-col gap-1 pl-2 pr-1 pt-2.5"
                        >
                            <span className={`pw-eyebrow tabular-nums transition-colors duration-300 ${passed ? 'text-[var(--app-accent)]' : 'text-[var(--app-hint)]'}`}>
                                {String(index + 1).padStart(2, '0')}
                            </span>
                            <span className={`break-words text-[13px] font-medium leading-tight tracking-[-0.01em] transition-colors duration-300 ${passed ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}>
                                {t(`board.column.${column}`)}
                            </span>
                            {blocked && index === current ? (
                                <span className={`pw-eyebrow ${props.archived ? 'text-[var(--app-hint)]' : 'text-[var(--app-accent)]'}`}>
                                    {t('board.column.blocked')}
                                </span>
                            ) : null}
                        </li>
                    )
                })}
            </ol>
            {/* The marker rides the right edge of a box as wide as the fill;
                sliding the box in from the left carries it with the fill. */}
            <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-y-0 left-0 ${motion} ${drawn ? 'translate-x-0' : '-translate-x-full'}`}
                style={{ width: reach }}
            >
                <span className={`absolute -right-px -top-2 bottom-0 w-0.5 ${mark}`} />
            </div>
        </div>
    )
}

/** Ledger row: hairline above, grey label left, value right. */
function LedgerRow(props: { label: ReactNode; index: number; children: ReactNode; labelClassName?: string }) {
    return (
        <div
            className="pw-ledger grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-3 py-2.5"
            style={{ '--i': props.index } as CSSProperties}
        >
            <span className={`pw-eyebrow break-words ${props.labelClassName ?? 'text-[var(--app-hint)]'}`}>{props.label}</span>
            <div className="min-w-0 text-[13px] text-[var(--app-fg)]">{props.children}</div>
        </div>
    )
}

function SectionHeading(props: { children: ReactNode; hot?: boolean }) {
    return (
        <h3 className={`pw-eyebrow mb-2 ${props.hot ? 'text-[var(--app-accent)]' : 'text-[var(--app-hint)]'}`}>
            {props.children}
        </h3>
    )
}

function runStatusTone(status: string): string {
    if (status === 'failed' || status === 'orphaned' || status === 'timed_out') return 'text-[var(--app-accent)]'
    if (status === 'running' || status === 'succeeded') return 'text-[var(--app-fg)]'
    return 'text-[var(--app-hint)]'
}

/** Red outline pill: the press that throws something away. */
const DANGER_PILL = 'inline-flex h-8 items-center justify-center whitespace-nowrap rounded-full border border-[var(--app-accent)] px-3.5 text-[13px] font-semibold text-[var(--app-accent)] transition-colors duration-300 hover:bg-[var(--app-accent)] hover:text-[var(--app-bg)] disabled:pointer-events-none disabled:opacity-50'

/** Outline pill for a raw <button> that swaps to DANGER_PILL; matches Button `outline` `sm`. */
const OUTLINE_PILL = 'pw-ghost-sweep inline-flex h-8 items-center justify-center whitespace-nowrap rounded-full border border-[var(--app-fg)] px-3.5 text-[13px] font-semibold text-[var(--app-fg)] disabled:pointer-events-none disabled:opacity-50'

/** Template field: no box, one rule underneath. */
const UNDERLINE_SELECT = 'border-0 border-b px-0 border-[var(--app-rule)] bg-transparent py-1 text-[13px] text-[var(--app-fg)] focus:outline-none focus-visible:border-[var(--app-accent)] disabled:opacity-50 [&>option]:bg-[var(--app-bg)] [&>option]:text-[var(--app-fg)]'

export function TaskDetail(props: {
    api: ApiClient | null
    task: Task
    runs: TaskRun[]
    session: Session | null
    isBusy: boolean
    onStart: (taskId: string) => void
    onCancel: (taskId: string) => void
    onMove: (taskId: string, column: TaskColumn) => void
    /** Resolves true once saved; a refused rename keeps the draft open. */
    onRename: (taskId: string, title: string) => Promise<boolean>
    onArchive: (
        taskId: string,
        options: { force: boolean; stopRun: boolean; forceWorktree: boolean }
    ) => void
    /** Uncommitted files the hub refused over, or null. The first press
     *  reports, the next one overrides. */
    dirtyWarning: number | null
    /** The host's last failed action (start, archive, delete…), shown here
     *  because on a phone the panel covers the list that would show it. */
    error?: string | null
    onOpenPullRequest: (taskId: string) => void
    onRefreshPullRequest: (taskId: string) => void
    onUnarchive: (taskId: string) => void
    /** Same second-press contract as archiving when the worktree is dirty. */
    onDelete: (taskId: string, options: { force: boolean; stopRun: boolean }) => void
    onClose: () => void
    /** Called when Open chat navigates, so an overlay host can close too. */
    onNavigate?: () => void
}) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const { task } = props

    const requests = Object.entries(props.session?.agentState?.requests ?? {})
    // Live: `running`, or parked in `review` on a prompt. HAPI's `blocked` is a
    // fault state with no agent behind it, so the panel offers Start, not Stop.
    const isLive = task.column === 'running' || requests.length > 0
    // Reviewed tasks still own a live run, so the archive that ends one is the
    // common case and has to ask first.
    const archiveStopsRun = task.lastRunStatus === 'running'
    // And the delete that ends one: outside `running` there is no Cancel.
    const deleteStopsRun = archiveStopsRun
    const [confirmingArchive, setConfirmingArchive] = useState(false)
    const [confirmingDelete, setConfirmingDelete] = useState(false)
    // Non-null while the title is being edited. Renaming only touches the
    // label, so it stays open on running and archived tasks alike.
    const [titleDraft, setTitleDraft] = useState<string | null>(null)
    // Refs, not state: disabling the focused input on save blurs it, and so
    // does dropping it on Escape - both would otherwise reach `commitTitle`
    // through a closure that has not seen the change yet.
    const savingTitleRef = useRef(false)
    const discardTitleRef = useRef(false)
    const [savingTitle, setSavingTitle] = useState(false)

    const editTitle = () => {
        discardTitleRef.current = false
        setTitleDraft(task.title)
    }

    const discardTitle = () => {
        discardTitleRef.current = true
        setTitleDraft(null)
    }

    const commitTitle = async () => {
        if (titleDraft === null || savingTitleRef.current || discardTitleRef.current) return
        const next = titleDraft.trim()
        if (!next || next === task.title) {
            discardTitle()
            return
        }
        savingTitleRef.current = true
        setSavingTitle(true)
        const saved = await props.onRename(task.id, next)
        savingTitleRef.current = false
        setSavingTitle(false)
        if (saved) discardTitle()
    }
    // An archived task is out of the lifecycle: the only things left to do
    // with it are to bring it back, read its conversation, or delete it.
    const isArchived = task.archivedAt !== null
    const sessionId = task.currentSessionId

    // Switching the live session's mode is the fastest way out of a task that
    // keeps stopping to ask: set it to auto once and the run carries on by
    // itself. The task's own default is unchanged — this turn only.
    const permissionOptions = getPermissionModeOptionsForFlavor(task.spawn.flavor)
    const livePermissionMode = props.session?.permissionMode
        ?? task.spawn.permissionMode
        ?? getDefaultPermissionModeForFlavor(task.spawn.flavor)

    const changeMode = useMutation({
        mutationFn: async (mode: PermissionMode) => {
            if (!props.api || !sessionId) throw new Error(t('board.detail.noSession'))
            await props.api.setPermissionMode(sessionId, mode)
        },
        onSuccess: () => {
            if (sessionId) {
                void queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) })
            }
        },
    })

    const respond = useMutation({
        mutationFn: async (input: { requestId: string; approve: boolean }) => {
            if (!props.api || !sessionId) throw new Error(t('board.detail.noSession'))
            if (input.approve) {
                // The hint under the buttons promises the rest of the session;
                // Claude only hears that through `allowTools`.
                const request = props.session?.agentState?.requests?.[input.requestId]
                await props.api.approvePermission(
                    sessionId,
                    input.requestId,
                    approveForSessionOptions(
                        props.session?.metadata?.flavor ?? task.spawn.flavor,
                        request?.tool ?? '',
                        request?.arguments
                    )
                )
            } else {
                await props.api.denyPermission(sessionId, input.requestId, { decision: 'denied' })
            }
        },
        onSuccess: () => {
            // The agent moves on immediately; refresh both the session (request
            // list) and the task list (the task leaves `blocked`).
            if (sessionId) {
                void queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) })
            }
            void queryClient.invalidateQueries({ queryKey: queryKeys.tasks })
        },
    })

    // Metadata as ledger rows; built as a list so the hairlines stagger in
    // order over the rows that are actually there.
    const metaRows: Array<{ key: string; label: string; value: ReactNode }> = [
        { key: 'agent', label: t('board.new.agent'), value: task.spawn.flavor }
    ]
    if (permissionOptions.length > 0) {
        metaRows.push({
            key: 'permission',
            label: t('board.new.permission'),
            value: sessionId ? (
                <select
                    aria-label={t('board.new.permission')}
                    value={livePermissionMode}
                    disabled={changeMode.isPending}
                    onChange={(event) => changeMode.mutate(event.target.value as PermissionMode)}
                    className={`w-full ${UNDERLINE_SELECT}`}
                >
                    {permissionOptions.map((option) => (
                        <option key={option.mode} value={option.mode}>{option.label}</option>
                    ))}
                </select>
            ) : (
                permissionOptions.find((o) => o.mode === livePermissionMode)?.label ?? livePermissionMode
            )
        })
    }
    for (const [key, label, value] of [
        ['workdir', t('board.detail.workdir'), task.workdir],
        ['branch', t('board.detail.branch'), task.branch],
        ['worktree', t('board.detail.worktree'), task.worktreePath],
        ['baseRef', t('board.detail.baseRef'), task.baseRef]
    ] as const) {
        if (value) {
            metaRows.push({ key, label, value: <span className="break-all font-mono text-xs">{value}</span> })
        }
    }

    // Failures of what this panel does itself, then of what the host did for it.
    const panelError = respond.error ?? changeMode.error
    const errorText = panelError ? readableError(panelError) : props.error ?? null

    return (
        <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) props.onClose() }}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="pw-overlay fixed inset-0 z-50 bg-black/20" />
                <DialogPrimitive.Content
                    asChild
                    aria-modal="true"
                    aria-describedby={undefined}
                    onEscapeKeyDown={(event) => {
                        // Escape while renaming drops the draft, not the panel.
                        if (titleDraft === null) return
                        event.preventDefault()
                        discardTitle()
                    }}
                >
                    <aside
                        className="pw-panel-in fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-md flex-col overflow-hidden border-l border-[var(--app-rule)] bg-[var(--app-bg)] focus:outline-none"
                    >
                        <header className="border-b border-[var(--app-rule)] px-5 pb-5 pt-4">
                            <div className="flex items-start gap-3">
                                <div className="min-w-0 flex-1">
                                    <p className="pw-eyebrow text-[var(--app-hint)]">
                                        {t(`board.column.${task.column}`)}
                                        {task.lastRunStatus ? ` · ${t(`board.detail.run.${task.lastRunStatus}`)}` : ''}
                                        {isArchived ? ` · ${t('board.detail.archived')}` : ''}
                                    </p>
                                    <BackgroundWork session={props.session} />
                                    {titleDraft !== null ? (
                                        <>
                                            <DialogPrimitive.Title className="sr-only">{task.title}</DialogPrimitive.Title>
                                            <input
                                                autoFocus
                                                value={titleDraft}
                                                maxLength={200}
                                                disabled={savingTitle}
                                                aria-label={t('board.detail.titleLabel')}
                                                onChange={(event) => setTitleDraft(event.target.value)}
                                                onBlur={() => void commitTitle()}
                                                onKeyDown={(event) => {
                                                    // An IME's Enter picks a candidate; it is not a submit.
                                                    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                                                    event.preventDefault()
                                                    void commitTitle()
                                                }}
                                                className="mt-1.5 w-full border-0 border-b border-[var(--app-rule)] bg-transparent px-0 py-0 text-[20px] font-medium leading-[1.2] tracking-[-0.025em] text-[var(--app-fg)] outline-none focus:border-[var(--app-accent)] disabled:opacity-50"
                                            />
                                        </>
                                    ) : (
                                        <DialogPrimitive.Title className="mt-1.5 break-words text-[20px] font-medium leading-[1.2] tracking-[-0.025em] text-[var(--app-fg)]">
                                            {/* Click the title to rename it, as a machine's name is
                                                renamed in settings. */}
                                            <button
                                                type="button"
                                                onClick={editTitle}
                                                title={t('board.detail.rename')}
                                                className="max-w-full break-words text-left decoration-1 underline-offset-4 hover:underline"
                                            >
                                                {task.title}
                                            </button>
                                        </DialogPrimitive.Title>
                                    )}
                                </div>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={props.onClose}
                                    aria-label={t('board.detail.close')}
                                    className="w-8 shrink-0 px-0"
                                >
                                    ✕
                                </Button>
                            </div>
                            <div className="mt-6">
                                <LifecycleRuler column={task.column} archived={isArchived} />
                            </div>
                        </header>

                        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-5">
                            {errorText ? (
                                <p role="alert" className="mb-6 break-words text-[13px] text-[var(--app-accent)]">
                                    {errorText}
                                </p>
                            ) : null}

                            {/* Waiting-on-you comes first: it is the only thing here that
                                blocks progress, and the whole point of the panel. */}
                            {requests.length > 0 ? (
                                <section className="mb-8">
                                    <SectionHeading hot>{t('board.detail.waiting')}</SectionHeading>
                                    <div className="border-b border-[var(--app-border)]">
                                        {requests.map(([requestId, request], index) => {
                                            const gist = describeToolRequest(request.tool, request.arguments)
                                            return (
                                                <div
                                                    key={requestId}
                                                    className="pw-ledger flex flex-col gap-2.5 py-3"
                                                    style={{ '--i': index } as CSSProperties}
                                                >
                                                    <div className="text-[13px] text-[var(--app-fg)]">
                                                        <span className="font-mono font-semibold">{request.tool}</span>
                                                        {gist ? (
                                                            <span className="ml-2 break-all font-mono text-[var(--app-hint)]">{gist}</span>
                                                        ) : null}
                                                    </div>
                                                    <div className="flex gap-2">
                                                        <Button
                                                            type="button"
                                                            size="sm"
                                                            disabled={respond.isPending}
                                                            onClick={() => respond.mutate({ requestId, approve: true })}
                                                        >
                                                            {t('board.detail.approve')}
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            variant="outline"
                                                            size="sm"
                                                            disabled={respond.isPending}
                                                            onClick={() => respond.mutate({ requestId, approve: false })}
                                                        >
                                                            {t('board.detail.deny')}
                                                        </Button>
                                                    </div>
                                                </div>
                                            )
                                        })}
                                    </div>
                                    <p className="mt-2 text-xs text-[var(--app-hint)]">
                                        {t('board.detail.approveHint')}
                                    </p>
                                </section>
                            ) : null}

                            {task.lastError ? (
                                <p className="mb-8 text-[13px] text-[var(--app-accent)]">
                                    {formatTaskError(task.lastError, t)}
                                </p>
                            ) : null}

                            <section className="mb-8">
                                {/* An adopted task's text is where its conversation started,
                                    not an instruction waiting to be sent. Labelling it
                                    "prompt" invites the reader to expect the agent to act
                                    on it, which it never will. */}
                                <SectionHeading>
                                    {task.spawn.adoptedNativeSessionId ? t('board.detail.adoptedOpening') : t('board.detail.prompt')}
                                </SectionHeading>
                                <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.6] tracking-[-0.005em] text-[var(--app-fg)]">
                                    {task.prompt}
                                </p>
                                {task.spawn.adoptedNativeSessionId ? (
                                    <p className="mt-2 text-xs text-[var(--app-hint)]">{t('board.detail.adoptedOpeningHint')}</p>
                                ) : null}
                            </section>

                            <section className="mb-8 border-b border-[var(--app-border)]">
                                {metaRows.map((row, index) => (
                                    <LedgerRow key={row.key} label={row.label} index={index}>
                                        {row.value}
                                    </LedgerRow>
                                ))}
                            </section>

                            {task.pullRequest ? (
                                <section className="mb-8">
                                    <SectionHeading>{t('board.detail.pr')}</SectionHeading>
                                    <div className="border-b border-[var(--app-border)]">
                                        <LedgerRow label={`#${task.pullRequest.number}`} index={0}>
                                            <a
                                                href={task.pullRequest.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="pw-underline break-words text-[var(--app-fg)]"
                                            >
                                                {task.pullRequest.title}
                                            </a>
                                            <PullRequestStatus pullRequest={task.pullRequest} />
                                        </LedgerRow>
                                    </div>
                                </section>
                            ) : null}

                            {props.runs.length > 0 ? (
                                <section className="mb-8">
                                    <SectionHeading>{t('board.detail.runs')}</SectionHeading>
                                    <div className="border-b border-[var(--app-border)]">
                                        {props.runs.slice(0, 5).map((run, index) => (
                                            <LedgerRow
                                                key={run.id}
                                                index={index}
                                                label={t(`board.detail.run.${run.status}`)}
                                                labelClassName={runStatusTone(run.status)}
                                            >
                                                <span className="tabular-nums text-[var(--app-hint)]">
                                                    {new Date(run.startedAt).toLocaleString()}
                                                </span>
                                                {run.error ? (
                                                    <span className="mt-0.5 line-clamp-2 block break-words text-xs text-[var(--app-fg)]" title={run.error}>
                                                        {run.error}
                                                    </span>
                                                ) : null}
                                            </LedgerRow>
                                        ))}
                                    </div>
                                </section>
                            ) : null}

                            {/* An adopted task resumes one conversation; it has no
                                prompt to run again on a timer. */}
                            {!isArchived && !task.spawn.adoptedSessionId && !task.spawn.adoptedNativeSessionId ? (
                                <TaskScheduleSection api={props.api} task={task} />
                            ) : null}
                        </div>

                        <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--app-rule)] px-5 py-4">
                            {/* Start is offered on every parked task here, even when the
                                list row leads with Open chat: starting over stays
                                reachable from inside the panel, it just does not
                                compete with continuing the conversation. */}
                            {!isArchived && !isLive && task.machineId ? (
                                <Button
                                    type="button"
                                    size="sm"
                                    disabled={props.isBusy}
                                    onClick={() => props.onStart(task.id)}
                                >
                                    {t('board.card.start')}
                                </Button>
                            ) : null}

                            {!isArchived && isLive ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={props.isBusy}
                                    onClick={() => props.onCancel(task.id)}
                                >
                                    {t('board.card.cancel')}
                                </Button>
                            ) : null}

                            {sessionId ? (
                                <Button asChild size="sm">
                                    <Link
                                        to="/sessions/$sessionId"
                                        params={{ sessionId }}
                                        onClick={props.onNavigate}
                                    >
                                        {t('board.card.openChat')}
                                    </Link>
                                </Button>
                            ) : null}

                            {!isArchived && !task.pullRequest && task.branch && sessionId ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={props.isBusy}
                                    onClick={() => props.onOpenPullRequest(task.id)}
                                >
                                    {t('board.card.openPr')}
                                </Button>
                            ) : null}

                            {!isArchived && task.pullRequest ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={props.isBusy}
                                    onClick={() => props.onRefreshPullRequest(task.id)}
                                >
                                    {t('board.card.refreshPr')}
                                </Button>
                            ) : null}

                            {/* Archive but no Done button: Done is a verdict given with
                                the status select, while archiving is the cleanup that
                                follows it and belongs wherever you finished reading. */}
                            {isArchived ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={props.isBusy}
                                    onClick={() => props.onUnarchive(task.id)}
                                >
                                    {t('board.card.unarchive')}
                                </Button>
                            ) : null}

                            {!isArchived && (task.column === 'done' || isLive) ? (
                                <button
                                    type="button"
                                    disabled={props.isBusy}
                                    onClick={() => {
                                        if (archiveStopsRun && !confirmingArchive) {
                                            setConfirmingArchive(true)
                                            return
                                        }
                                        props.onArchive(task.id, {
                                            force: task.column !== 'done',
                                            stopRun: archiveStopsRun,
                                            forceWorktree: props.dirtyWarning !== null
                                        })
                                        setConfirmingArchive(false)
                                    }}
                                    className={confirmingArchive || props.dirtyWarning !== null
                                        ? DANGER_PILL
                                        : OUTLINE_PILL}
                                >
                                    {props.dirtyWarning !== null
                                        ? t('board.card.archiveForce', { count: String(props.dirtyWarning) })
                                        : confirmingArchive
                                            ? t('board.card.archiveStopConfirm')
                                            : archiveStopsRun ? t('board.card.archiveStop') : t('board.card.archive')}
                                </button>
                            ) : null}

                            {/* Two-step: a panel is where a task gets read before it is
                                thrown away, so the delete belongs here. A task still
                                holding a run says so on the confirm button and stops
                                the agent as part of the delete. */}
                            {confirmingDelete ? (
                                <>
                                    <button
                                        type="button"
                                        disabled={props.isBusy}
                                        onClick={() => {
                                            props.onDelete(task.id, {
                                                force: props.dirtyWarning !== null,
                                                stopRun: deleteStopsRun
                                            })
                                            setConfirmingDelete(false)
                                        }}
                                        className={DANGER_PILL}
                                    >
                                        {props.dirtyWarning !== null
                                            ? t('board.card.deleteForce', { count: String(props.dirtyWarning) })
                                            : deleteStopsRun
                                                ? t('board.card.deleteStopConfirm')
                                                : t('board.card.deleteConfirm')}
                                    </button>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setConfirmingDelete(false)}
                                    >
                                        {t('board.card.deleteCancel')}
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={props.isBusy}
                                    onClick={() => setConfirmingDelete(true)}
                                >
                                    {t('board.card.delete')}
                                </Button>
                            )}

                            {!isArchived ? (
                                <TaskColumnSelect
                                    column={task.column}
                                    disabled={props.isBusy}
                                    onChange={(column) => props.onMove(task.id, column)}
                                    className={`ml-auto cursor-pointer font-semibold ${UNDERLINE_SELECT}`}
                                />
                            ) : null}
                        </footer>
                    </aside>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    )
}

/** State, draft, CI verdict and conflicts; anything more detailed is on the forge. */
function PullRequestStatus(props: { pullRequest: TaskPullRequest }) {
    const { t } = useTranslation()
    const { pullRequest } = props

    // Green only where the badge says merged / passed; red for what needs a
    // human; everything else grey.
    const stateTone = pullRequest.state === 'merged'
        ? 'text-[var(--app-badge-success-text)]'
        : pullRequest.state === 'closed'
            ? 'text-[var(--app-hint)]'
            : 'text-[var(--app-fg)]'

    const checksTone = pullRequest.checks === 'failing'
        ? 'text-[var(--app-accent)]'
        : pullRequest.checks === 'pending'
            ? 'text-[var(--app-hint)]'
            : 'text-[var(--app-badge-success-text)]'

    return (
        <div className="pw-eyebrow mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={stateTone}>{t(`board.pr.state.${pullRequest.state}`)}</span>
            {pullRequest.isDraft ? (
                <span className="text-[var(--app-hint)]">{t('board.pr.draft')}</span>
            ) : null}
            {pullRequest.checks && pullRequest.checks !== 'none' ? (
                <span className={checksTone}>{t(`board.pr.checks.${pullRequest.checks}`)}</span>
            ) : null}
            {pullRequest.state === 'open' && pullRequest.mergeable === false ? (
                <span className="text-[var(--app-accent)]">{t('board.pr.conflicts')}</span>
            ) : null}
        </div>
    )
}

/**
 * What the live session left running. Agents and tasks the agent said it is
 * waiting on keep the task in `running`; other processes (a dev server) do not,
 * so a task in review still says they are up.
 */
function BackgroundWork(props: { session: Session | null }) {
    const { t } = useTranslation()
    const session = props.session
    if (!session) return null
    const agents = session.backgroundAgentCount ?? 0
    const awaited = session.backgroundAwaitedCount ?? 0
    const processes = Math.max(0, (session.backgroundTaskCount ?? 0) - agents - awaited)
    if (agents === 0 && awaited === 0 && processes === 0) return null
    return (
        <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-[var(--app-hint)]">
            {awaited > 0 ? (
                <span className="inline-flex items-center gap-1.5 text-[var(--app-fg)]">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />
                    {t('board.card.backgroundAwaited', { count: String(awaited) })}
                </span>
            ) : null}
            {agents > 0 ? <span>{t('board.card.backgroundAgents', { count: String(agents) })}</span> : null}
            {processes > 0 ? <span>{t('board.card.backgroundProcesses', { count: String(processes) })}</span> : null}
        </p>
    )
}
