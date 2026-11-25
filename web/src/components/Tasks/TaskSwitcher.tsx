import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Link } from '@tanstack/react-router'
import type { Task, TaskColumn, TaskSchedule } from '@hapi/protocol'
import { taskNeedsAttention } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { InfoIcon } from '@/components/icons'
import { WorkspaceUserPicker } from '@/components/WorkspaceUser/WorkspaceUserPicker'
import { useSessions } from '@/hooks/queries/useSessions'
import { useTasks } from '@/hooks/queries/useTasks'
import { useTaskSchedules } from '@/hooks/queries/useTaskSchedules'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { useTranslation } from '@/lib/use-translation'
import { StatusDot, taskColumnTone } from './StatusDot'
import { TaskColumnSelect } from './TaskColumnSelect'
import { useTaskLifecycle } from './useTaskLifecycle'

// Opened from a row's info button; it carries the schedule editor (cronstrue)
// and run history, which the list itself never needs.
const TaskDetailPanel = lazy(() => import('./TaskDetailPanel').then((m) => ({ default: m.TaskDetailPanel })))

/**
 * The task list in the sidebar.
 *
 * Reviewing a queue of finished tasks is one click per task, and a task can be
 * moved from here without leaving the conversation. New tasks come from the
 * sidebar's plus button.
 *
 * Everything else — start, stop, archive, restore, delete, answer a prompt —
 * lives in the detail panel, reached from each row.
 *
 * Grouped by column rather than flat-with-a-badge because the operator's
 * question is "what else is waiting on me", and a grouped list answers it by
 * shape — the two columns that wait on a human are the two at the top.
 */

/**
 * Columns, in the order someone triaging works through them.
 *
 * Leads with the two columns `TASK_ATTENTION_COLUMNS` calls out, not with
 * `running` (as agetor's dashboard does), because a sidebar is opened to pick
 * the next thing to deal with, and a running task is precisely the one that
 * needs nothing. `done` sits last: it is history, kept visible only so a task
 * that was just finished does not appear to vanish.
 */
const TASK_SWITCHER_COLUMN_ORDER = [
    'blocked',
    'review',
    'running',
    'ready',
    'backlog',
    'done'
] as const satisfies readonly TaskColumn[]

export type TaskSwitcherGroup = {
    column: TaskColumn
    tasks: Task[]
}

/** Group into `TASK_SWITCHER_COLUMN_ORDER`, newest first inside each column,
 *  dropping archived tasks and the columns that have nothing left in them. */
export function groupTasksForSwitcher(tasks: Task[]): TaskSwitcherGroup[] {
    const byColumn = new Map<TaskColumn, Task[]>(
        TASK_SWITCHER_COLUMN_ORDER.map((column) => [column, []])
    )
    for (const task of tasks) {
        if (task.archivedAt !== null) continue
        byColumn.get(task.column)?.push(task)
    }
    return TASK_SWITCHER_COLUMN_ORDER
        .map((column) => ({
            column,
            tasks: (byColumn.get(column) ?? []).sort((a, b) => b.updatedAt - a.updatedAt)
        }))
        .filter((group) => group.tasks.length > 0)
}

/** Archived tasks, most recently archived first. Kept apart from the column
 *  groups: an archived task's column is where it stopped, not where it is. */
export function collectArchivedTasks(tasks: Task[]): Task[] {
    return tasks
        .filter((task) => task.archivedAt !== null)
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
}

/** Cards that are waiting on a human — what the tab badge counts. Archived
 *  tasks are nobody's problem, which is what `taskNeedsAttention` already says. */
export function countAttentionTasks(tasks: Task[]): number {
    return tasks.filter((task) => taskNeedsAttention(task)).length
}

export function TaskSwitcher(props: {
    api: ApiClient | null
    selectedSessionId: string | null
    /** Called after a row navigates, so an overlay host can close itself. */
    onNavigate?: () => void
}) {
    const { t } = useTranslation()
    // Archived included so this shares the sidebar's cache entry rather than
    // opening a second board query; `groupTasksForSwitcher` drops them again.
    const { tasks, isLoading, error } = useTasks(props.api, { includeArchived: true })
    // Same query the sidebar already runs, so this costs a cache read rather
    // than a request. The pending count lives on the session, not the task.
    const { sessions } = useSessions(props.api)
    const pendingBySession = useMemo(
        () => new Map(sessions.map((session) => [session.id, session.pendingRequestsCount ?? 0])),
        [sessions]
    )
    const scheduleByTask = useTaskSchedules(props.api)
    const groups = useMemo(() => groupTasksForSwitcher(tasks), [tasks])
    const archived = useMemo(() => collectArchivedTasks(tasks), [tasks])
    const lifecycle = useTaskLifecycle(props.api)
    const { actions } = lifecycle
    // Out of the way by default, one press back — the session list treats its
    // finished rows the same way.
    const [showArchived, setShowArchived] = useState(false)
    const [detailTaskId, setDetailTaskId] = useState<string | null>(null)

    const listError = error ?? actions.error
    const listRef = useRef<HTMLDivElement>(null)
    // The session the user just clicked, until the route catches up. Routing
    // to a chat takes a beat; the highlight should leave on the click, not
    // after the page has loaded.
    const [clickedSessionId, setClickedSessionId] = useState<string | null>(null)
    useEffect(() => {
        setClickedSessionId(null)
    }, [props.selectedSessionId])
    const selectedSessionId = clickedSessionId ?? props.selectedSessionId

    const renderRow = (task: Task, index: number) => (
        <TaskSwitcherRow
            key={task.id}
            index={index}
            task={task}
            selected={
                task.currentSessionId !== null
                && task.currentSessionId === selectedSessionId
            }
            pendingCount={
                task.currentSessionId
                    ? pendingBySession.get(task.currentSessionId) ?? 0
                    : 0
            }
            schedule={scheduleByTask.get(task.id)}
            isBusy={actions.isPending}
            onMove={lifecycle.move}
            onOpenDetail={setDetailTaskId}
            onNavigate={() => {
                setClickedSessionId(task.currentSessionId)
                props.onNavigate?.()
            }}
        />
    )

    return (
        <div className="flex min-h-0 w-full flex-1 flex-col">
            {/* Whose tasks these are, and the way in to managing that list.
                Always shown, unlike on the session tab: this is where the
                first user gets created. */}
            <div className="mx-auto flex w-full max-w-content items-end gap-3 px-3 pb-2 pt-2">
                <WorkspaceUserPicker
                    api={props.api}
                    className="min-w-0 flex-1 border-0 border-b border-[var(--app-rule)] bg-transparent py-1.5 text-[15px] text-[var(--app-fg)] focus:outline-none focus-visible:border-[var(--app-accent)]"
                />
                {archived.length > 0 ? (
                    <button
                        type="button"
                        onClick={() => setShowArchived(!showArchived)}
                        aria-pressed={showArchived}
                        className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition-colors duration-300 ${
                            showArchived
                                ? 'border-[var(--app-fg)] bg-[var(--app-fg)] text-[var(--app-bg)]'
                                : 'border-[var(--app-fg)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                        }`}
                    >
                        {t('sidebar.tasks.archived', { count: archived.length })}
                    </button>
                ) : null}
            </div>

            {lifecycle.orphanWarning ? (
                <p role="alert" className="mx-3 mb-1 flex items-start gap-2 px-2 py-1.5 text-xs text-[var(--app-accent)]">
                    <span className="min-w-0 flex-1">{t('board.archive.sessionStillAlive')}</span>
                    <button
                        type="button"
                        onClick={lifecycle.dismissOrphanWarning}
                        className="shrink-0 rounded-full border border-[var(--app-accent)] px-2 py-0.5 font-semibold"
                    >
                        {t('board.archive.dismiss')}
                    </button>
                </p>
            ) : null}

            <div className="app-scroll-y min-h-0 flex-1">
                <div ref={listRef} className="relative mx-auto flex w-full max-w-content flex-col pb-4">
                    <SelectionHighlight listRef={listRef} selectedSessionId={selectedSessionId} />
                    {listError ? (
                        <p role="alert" className="px-3 py-3 text-[13px] text-[var(--app-accent)]">{listError}</p>
                    ) : null}

                    {!error && isLoading && tasks.length === 0 ? (
                        <p className="px-2 py-3 text-xs text-[var(--app-hint)]">{t('board.loading')}</p>
                    ) : null}

                    {!error && !isLoading && groups.length === 0 ? (
                        <div className="px-2 py-6 text-center text-xs text-[var(--app-hint)]">
                            <p>{t('sidebar.tasks.empty')}</p>
                            <p className="mt-1">{t('sidebar.tasks.emptyHint')}</p>
                        </div>
                    ) : null}

                    {groups.map((group) => (
                        <section key={group.column} className="flex flex-col">
                            {/* Grouped lists are skimmed by heading, so the
                                heading carries the column's tone. */}
                            <h3 className={`pw-eyebrow flex items-baseline gap-2 px-3 pb-2 pt-5 ${taskColumnTone(group.column).text}`}>
                                <span>{t(`board.column.${group.column}`)}</span>
                                <span className="tabular-nums text-[var(--app-hint)]">{group.tasks.length}</span>
                            </h3>
                            {group.tasks.map(renderRow)}
                        </section>
                    ))}

                    {showArchived && archived.length > 0 ? (
                        <section className="flex flex-col">
                            <h3 className="pw-eyebrow flex items-baseline gap-2 px-3 pb-2 pt-5 text-[var(--app-hint)]">
                                <span>{t('board.detail.archived')}</span>
                                <span className="tabular-nums">{archived.length}</span>
                            </h3>
                            {archived.map(renderRow)}
                        </section>
                    ) : null}
                </div>
            </div>

            {detailTaskId ? (
                <Suspense fallback={null}>
                    <TaskDetailPanel
                        api={props.api}
                        taskId={detailTaskId}
                        lifecycle={lifecycle}
                        onClose={() => setDetailTaskId(null)}
                        onNavigate={() => {
                            setDetailTaskId(null)
                            props.onNavigate?.()
                        }}
                    />
                </Suspense>
            ) : null}
        </div>
    )
}

function TaskSwitcherRow(props: {
    index: number
    task: Task
    selected: boolean
    pendingCount: number
    schedule?: TaskSchedule
    isBusy: boolean
    onMove: (taskId: string, column: TaskColumn) => void
    onOpenDetail: (taskId: string) => void
    onNavigate?: () => void
}) {
    const { t } = useTranslation()
    const { task } = props
    const isArchived = task.archivedAt !== null

    // Ledger rows: a hairline above each, a grey wash rising on hover. The open
    // task is the one solid black bar in the list, drawn by the gliding
    // highlight in TaskSwitcher so it moves between rows instead of blinking.
    const rowClass = `group/row relative z-[1] flex w-full min-w-0 items-center gap-1.5 pr-3 transition-colors duration-300 ${
        isArchived ? 'opacity-70' : ''
    } ${props.selected
        ? 'text-[var(--app-highlight-fg)]'
        : 'pw-ledger pw-row-fill'}`
    // The group heading already names the column, so on a pointer device the
    // per-row controls wait for hover (or keyboard focus in the row) and then
    // take their place at the row's end, on the row's own hover fill; the open
    // row and touch screens always show them.
    const rowControls = props.selected
        ? 'flex shrink-0 items-center gap-1.5'
        : 'flex shrink-0 items-center gap-1.5 [@media(hover:hover)]:hidden [@media(hover:hover)]:group-hover/row:flex [@media(hover:hover)]:group-focus-within/row:flex'
    const linkClass = 'flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pl-3 text-left text-[15px]'
    const muted = props.selected ? 'text-current opacity-70 hover:opacity-100' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
    const hot = task.column === 'review' || task.column === 'blocked'

    const body = (
        <>
            {/* On the black bar a black dot would vanish; it takes the text colour. */}
            <StatusDot column={task.column} className={props.selected && !hot ? '!bg-current' : ''} />
            <span className="min-w-0 flex-1 truncate">{task.title}</span>
            {props.schedule ? (
                <span
                    role="img"
                    aria-label={t('board.schedule.title')}
                    title={`${props.schedule.cron} (${props.schedule.tz})`}
                    className={`shrink-0 ${props.schedule.enabled ? 'opacity-70' : 'opacity-30'}`}
                >
                    <ScheduleClockIcon className="h-3.5 w-3.5" />
                </span>
            ) : null}
            {props.pendingCount > 0 ? (
                <span
                    className="shrink-0 text-xs font-semibold tabular-nums text-[var(--app-accent)]"
                    title={t('board.card.answerMany', { count: props.pendingCount })}
                >
                    {props.pendingCount}
                </span>
            ) : null}
        </>
    )

    // A task that has never run has nothing to open. Rather than a dead row,
    // it opens the detail panel, which is where it can be started.
    const link = task.currentSessionId ? (
        <Link
            to="/sessions/$sessionId"
            params={{ sessionId: task.currentSessionId }}
            {...PRESERVE_SESSION_SIDEBAR_SCROLL}
            onClick={props.onNavigate}
            aria-current={props.selected ? 'page' : undefined}
            className={`${linkClass} ${props.selected ? 'text-current' : 'text-[var(--app-fg)]'}`}
        >
            {body}
        </Link>
    ) : (
        <button
            type="button"
            onClick={() => props.onOpenDetail(task.id)}
            title={t('sidebar.tasks.noSession')}
            className={`${linkClass} ${props.selected ? 'text-current' : 'text-[var(--app-hint)]'}`}
        >
            {body}
        </button>
    )

    // The select sits beside the link, not inside it: a control inside an
    // anchor would navigate on every press meant to change the column.
    return (
        <div
            data-task-id={task.id}
            data-selected={props.selected || undefined}
            className={rowClass}
            style={{ '--i': props.index } as CSSProperties}
        >
            {link}
            <div className={rowControls}>
                {/* An archived task has to be restored before it can move; the
                    panel is where that happens. */}
                {!isArchived ? (
                    <TaskColumnSelect
                        column={task.column}
                        disabled={props.isBusy}
                        onChange={(column) => props.onMove(task.id, column)}
                        className={`shrink-0 cursor-pointer bg-transparent px-0.5 py-0.5 text-xs font-semibold ${muted} focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent)] disabled:opacity-50 [&>option]:text-[var(--app-fg)] [&>option]:bg-[var(--app-bg)]`}
                    />
                ) : null}
                <button
                    type="button"
                    onClick={() => props.onOpenDetail(task.id)}
                    aria-label={t('sidebar.tasks.details')}
                    title={t('sidebar.tasks.details')}
                    className={`shrink-0 p-0.5 ${muted} focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent)]`}
                >
                    <InfoIcon className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    )
}

/**
 * One solid fill behind the open task that glides to whichever row gets
 * selected next, like the tab underline on Vercel or Linear. Measured from the
 * DOM rather than threaded through props: the row can sit in any group, and
 * groups reorder as tasks move.
 */
function SelectionHighlight(props: {
    listRef: React.RefObject<HTMLDivElement | null>
    selectedSessionId: string | null
}) {
    const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
    const hadBox = useRef(false)

    // useEffect, not useLayoutEffect: this component renders inside the list,
    // and a child's layout effect runs before the parent's ref is attached.
    useEffect(() => {
        const list = props.listRef.current
        if (!list) return
        const measure = () => {
            const row = list.querySelector<HTMLElement>('[data-selected]')
            if (!row) {
                setBox(null)
                return
            }
            // Layout offsets, not client rects: rows rise in with a transform,
            // and the fill should land where the row ends up, not where it is
            // mid-animation. The list is the rows' offset parent.
            setBox({
                top: row.offsetTop,
                left: row.offsetLeft,
                width: row.offsetWidth,
                height: row.offsetHeight
            })
        }
        measure()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(measure)
        observer.observe(list)
        const mutations = new MutationObserver(measure)
        mutations.observe(list, { subtree: true, attributes: true, attributeFilter: ['data-selected'], childList: true })
        return () => {
            observer.disconnect()
            mutations.disconnect()
        }
    }, [props.listRef, props.selectedSessionId])

    const animate = hadBox.current
    hadBox.current = box !== null
    if (!box) return null

    return (
        <div
            aria-hidden="true"
            className={`pw-highlight pointer-events-none absolute left-0 top-0 z-0 ${animate ? '' : 'pw-highlight-enter'}`}
            style={{
                transform: `translate(${box.left}px, ${box.top}px)`,
                width: box.width,
                height: box.height
            }}
        />
    )
}

/** The schedule marker: a plain clock, in the row's text colour. */
function ScheduleClockIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 7.5V12l3 2" />
        </svg>
    )
}
