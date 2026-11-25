import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { ASSISTANT_AGENTS, getFlavorLabel, type AssistantAgent, type Task } from '@hapi/protocol'
import { readableError, type ApiClient } from '@/api/client'
import { StatusDot, taskColumnTone } from '@/components/Tasks/StatusDot'
import { CloseIcon } from '@/components/icons'
import { useActiveWorkspaceUser } from '@/hooks/queries/useWorkspaceUsers'
import { useMachines } from '@/hooks/queries/useMachines'
import { getMachineTitle, useMachineLabels } from '@/hooks/useMachineLabels'
import { useMachinePathsExists } from '@/hooks/useMachinePathsExists'
import {
    useAnswerAssistantQuestion,
    useAssistantActions,
    useAssistantGrants,
    useAssistantMemories,
    useAssistantQuestions,
    useAssistantSessionId
} from '@/hooks/queries/useAssistant'
import { useTasks } from '@/hooks/queries/useTasks'
import { useTranslation } from '@/lib/use-translation'
import { assistantRepoKey, isAssistantMemoryInContext } from '@hapi/protocol'
import { AssistantChat } from './AssistantChat'
import { AssistantMemoryTab, isFreshAssistantChange } from './AssistantMemoryTab'
import { AssistantQuestionsTab } from './AssistantQuestionsTab'
import { BrainIcon } from './icons'

/**
 * The task assistant: one permanent conversation per workspace user, looking
 * at whichever task is selected on the left, with the memory it keeps in the
 * second tab.
 *
 * Desktop: a resizable column beside the chat. Phone: a full-screen sheet,
 * which is a modal dialog (Escape closes it, focus comes back on close).
 */

const SEEN_KEY = (workspaceUserId: string) => `hapi.assistant.v1.memorySeenAt.${workspaceUserId}`

function readSeenAt(workspaceUserId: string): number {
    try {
        return Number(localStorage.getItem(SEEN_KEY(workspaceUserId)) ?? 0) || 0
    } catch {
        return 0
    }
}

/**
 * What a hand-built modal owes: focus moves in on open and back to where it
 * was on close, and Escape closes — unless something inside (the composer's
 * suggestions, a popover) already used that Escape.
 */
function useModalSheet(enabled: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void): void {
    const onCloseRef = useRef(onClose)
    onCloseRef.current = onClose
    useEffect(() => {
        if (!enabled) return
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
        ref.current?.focus()
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !event.defaultPrevented) onCloseRef.current()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('keydown', onKeyDown)
            previous?.focus()
        }
    }, [enabled, ref])
}

export function AssistantPanel(props: {
    api: ApiClient | null
    task: Task | null
    fullScreen?: boolean
    width?: number
    onClose: () => void
}) {
    const { t } = useTranslation()
    const { activeUser } = useActiveWorkspaceUser(props.api)
    const workspaceUserId = activeUser?.id ?? null
    const titleId = useId()
    const asideRef = useRef<HTMLElement>(null)
    useModalSheet(Boolean(props.fullScreen), asideRef, props.onClose)

    const className = props.fullScreen
        ? 'pw-sheet-in fixed inset-0 z-50 flex flex-col bg-[var(--app-bg)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] focus:outline-none'
        : 'pw-panel-in flex h-full shrink-0 flex-col bg-[var(--app-bg)]'

    return (
        <aside
            ref={asideRef}
            className={className}
            style={props.fullScreen ? undefined : { width: props.width }}
            {...(props.fullScreen
                ? { role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId, tabIndex: -1 }
                : { 'aria-label': t('assistant.title') })}
        >
            {props.api && workspaceUserId ? (
                <PanelBody
                    key={workspaceUserId}
                    api={props.api}
                    workspaceUserId={workspaceUserId}
                    paths={activeUser?.paths ?? NO_PATHS}
                    task={props.task}
                    titleId={titleId}
                    onClose={props.onClose}
                />
            ) : (
                <>
                    <PanelHeader titleId={titleId} onClose={props.onClose} tab={null} onTab={() => {}} freshCount={0} openQuestions={0} />
                    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-[13px] text-[var(--app-hint)]">
                        <p className="text-[15px] text-[var(--app-fg)]">{t('assistant.pickUser.title')}</p>
                        <p>{t('assistant.pickUser.body')}</p>
                    </div>
                </>
            )}
        </aside>
    )
}

const NO_PATHS: string[] = []

type PanelTab = 'chat' | 'memory' | 'questions'

/** Value of the "Auto" machine option; machine ids are never empty. */
const AUTO_MACHINE = ''

type MachineChoice = {
    /** Pinned machine id, or null for automatic. */
    value: string | null
    options: Array<{ id: string; label: string }>
    /** Where an automatic assistant runs now, if known. */
    autoLabel: string | null
    onChange: (machineId: string | null) => void
    pending: boolean
}

const PANEL_TABS: PanelTab[] = ['chat', 'memory', 'questions']

/** Ids tying each tab to its panel; unique per mounted panel. */
function tabIds(base: string, tab: PanelTab): { tab: string; panel: string } {
    return { tab: `${base}-tab-${tab}`, panel: `${base}-panel-${tab}` }
}

const selectClass = 'border-0 border-b border-[var(--app-rule)] bg-transparent py-0.5 text-xs font-semibold text-[var(--app-fg)] focus:outline-none focus-visible:border-[var(--app-accent)] disabled:opacity-50'

function PanelHeader(props: {
    titleId: string
    tab: PanelTab | null
    onTab: (tab: PanelTab) => void
    freshCount: number
    openQuestions: number
    onClose: () => void
    agent?: { value: AssistantAgent; onChange: (agent: AssistantAgent) => void; pending: boolean }
    machine?: MachineChoice
}) {
    const { t } = useTranslation()
    const tabClass = (active: boolean) =>
        `relative -mb-px flex items-baseline gap-1 border-b-2 py-2 text-[13px] font-semibold transition-colors duration-300 ${active ? 'border-[var(--app-fg)] text-[var(--app-fg)]' : 'border-transparent text-[var(--app-hint)] hover:text-[var(--app-fg)]'}`
    const count = (value: number) => value > 0
        ? <span key={value} className="pw-bump text-[10px] font-semibold tabular-nums text-[var(--app-accent)]">{value}</span>
        : null
    return (
        <div className="border-b border-[var(--app-rule)] px-4">
            <div className="flex items-center gap-2 pt-3">
                <span id={props.titleId} className="min-w-0 flex-1 truncate text-[17px] font-medium tracking-[-0.02em] text-[var(--app-fg)]">{t('assistant.title')}</span>
                {props.agent ? (
                    <select
                        value={props.agent.value}
                        disabled={props.agent.pending}
                        onChange={(event) => props.agent?.onChange(event.target.value as AssistantAgent)}
                        className={selectClass}
                        title={t('assistant.agent.hint')}
                        aria-label={t('assistant.agent.hint')}
                    >
                        {ASSISTANT_AGENTS.map((agent) => (
                            <option key={agent} value={agent}>{getFlavorLabel(agent)}</option>
                        ))}
                    </select>
                ) : null}
                {props.machine ? (
                    <select
                        value={props.machine.value ?? AUTO_MACHINE}
                        disabled={props.machine.pending}
                        onChange={(event) => props.machine?.onChange(event.target.value || null)}
                        className={`${selectClass} max-w-[10rem] truncate`}
                        title={t('assistant.machine.hint')}
                        aria-label={t('assistant.machine.hint')}
                    >
                        <option value={AUTO_MACHINE}>
                            {props.machine.autoLabel
                                ? t('assistant.machine.autoOn', { machine: props.machine.autoLabel })
                                : t('assistant.machine.auto')}
                        </option>
                        {props.machine.options.map((option) => (
                            <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                    </select>
                ) : null}
                <button
                    type="button"
                    onClick={props.onClose}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors duration-300 hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    title={t('assistant.close')}
                    aria-label={t('assistant.close')}
                >
                    <CloseIcon className="h-4 w-4" />
                </button>
            </div>
            {props.tab ? (
                <div className="flex gap-5" role="tablist">
                    {PANEL_TABS.map((tab) => {
                        const ids = tabIds(props.titleId, tab)
                        const selected = props.tab === tab
                        return (
                            <button
                                key={tab}
                                type="button"
                                role="tab"
                                id={ids.tab}
                                aria-controls={ids.panel}
                                aria-selected={selected}
                                onClick={() => props.onTab(tab)}
                                className={tabClass(selected)}
                            >
                                {t(`assistant.tab.${tab}`)}
                                {tab === 'memory' ? count(props.freshCount) : tab === 'questions' ? count(props.openQuestions) : null}
                            </button>
                        )
                    })}
                </div>
            ) : <div className="h-3" />}
        </div>
    )
}

function PanelBody(props: {
    api: ApiClient
    workspaceUserId: string
    paths: string[]
    task: Task | null
    titleId: string
    onClose: () => void
}) {
    const { t } = useTranslation()
    const [tab, setTab] = useState<PanelTab>('chat')
    const assistant = useAssistantSessionId(props.api, props.workspaceUserId)
    const { sessionId, agent, machineId, sessionMachineId, setSessionId, setAgent, setMachine, refresh: refreshSessionId } = assistant
    const [agentPending, setAgentPending] = useState(false)
    const [agentError, setAgentError] = useState<string | null>(null)
    const changeAgent = (next: AssistantAgent) => {
        if (next === agent || agentPending) return
        setAgentPending(true)
        setAgentError(null)
        void setAgent(next)
            .catch((error: unknown) => setAgentError(readableError(error)))
            .finally(() => setAgentPending(false))
    }

    // Machines: the online ones, plus the pinned one when it is down, so the
    // select still says where the assistant is meant to run.
    const { machines } = useMachines(props.api, true)
    const machineLabels = useMachineLabels(machines)
    const labelOf = (id: string) => machineLabels[id] ?? id.slice(0, 8)
    const machineOptions = machines.map((machine) => ({ id: machine.id, label: getMachineTitle(machine) }))
    if (machineId && !machines.some((machine) => machine.id === machineId)) {
        machineOptions.push({ id: machineId, label: t('assistant.machine.offline', { machine: labelOf(machineId) }) })
    }
    const [machinePending, setMachinePending] = useState(false)
    const [machineError, setMachineError] = useState<string | null>(null)
    const changeMachine = (next: string | null) => {
        if (next === machineId || machinePending) return
        setMachinePending(true)
        setMachineError(null)
        void setMachine(next)
            .catch((error: unknown) => setMachineError(readableError(error)))
            .finally(() => setMachinePending(false))
    }
    // The person's directories are registered once for every machine; the
    // runner passes on only those its machine has, and this says which not.
    const assistantMachineId = machineId ?? sessionMachineId
    const { pathExistence } = useMachinePathsExists(props.api, assistantMachineId, props.paths)
    const missingPaths = props.paths.filter((path) => pathExistence[path] === false)

    const { memories } = useAssistantMemories(props.api, props.workspaceUserId)
    const grants = useAssistantGrants(props.api, props.workspaceUserId)
    const actions = useAssistantActions(props.api, props.workspaceUserId)
    const { questions } = useAssistantQuestions(props.api, props.workspaceUserId)
    const answer = useAnswerAssistantQuestion(props.api, props.workspaceUserId)
    const { tasks } = useTasks(props.api, { includeArchived: true })
    const taskTitles = new Map(tasks.map((task) => [task.id, task.title]))
    const openQuestions = questions.filter((question) => question.status === 'open').length
    const [seenAt, setSeenAt] = useState(() => readSeenAt(props.workspaceUserId))
    const [openMemoryId, setOpenMemoryId] = useState<string | null>(null)

    // "View" on a memory card in the chat.
    useEffect(() => {
        const open = (event: Event) => {
            setOpenMemoryId((event as CustomEvent<string>).detail)
            setTab('memory')
        }
        window.addEventListener('hapi:assistant-open-memory', open)
        return () => window.removeEventListener('hapi:assistant-open-memory', open)
    }, [])

    // Leaving the memory tab counts as having seen what was in it.
    const previousTab = useRef(tab)
    useEffect(() => {
        if (previousTab.current === 'memory' && tab !== 'memory') {
            const now = Date.now()
            setSeenAt(now)
            try {
                localStorage.setItem(SEEN_KEY(props.workspaceUserId), String(now))
            } catch {
                // Not remembering is fine; the badge just comes back.
            }
        }
        previousTab.current = tab
    }, [tab, props.workspaceUserId])

    // × on the viewing bar sets the selected task aside for a question about
    // all of them; picking another task on the left follows it again.
    const selectedTaskId = props.task?.id ?? null
    const [detached, setDetached] = useState<{ from: string | null; set: boolean }>({ from: selectedTaskId, set: false })
    if (detached.from !== selectedTaskId) {
        setDetached({ from: selectedTaskId, set: false })
    }
    const task = detached.set && detached.from === selectedTaskId ? null : props.task

    // The task the conversation was about when the panel opened; a different
    // one on the left means the next message carries its context.
    const [conversationTaskId, setConversationTaskId] = useState(task?.id ?? null)
    const switched = (task?.id ?? null) !== conversationTaskId

    const repo = task ? assistantRepoKey(task.workdir) : null
    const related = memories.filter((memory) => isAssistantMemoryInContext(memory, { taskId: task?.id ?? null, repo }))
    const freshCount = memories.filter((memory) => isFreshAssistantChange(memory, seenAt)).length
    const tone = task ? taskColumnTone(task.column) : null

    return (
        <>
            <PanelHeader
                titleId={props.titleId}
                tab={tab}
                onTab={setTab}
                freshCount={freshCount}
                openQuestions={openQuestions}
                onClose={props.onClose}
                agent={{ value: agent, onChange: changeAgent, pending: agentPending }}
                machine={{
                    value: machineId,
                    options: machineOptions,
                    autoLabel: !machineId && sessionMachineId ? labelOf(sessionMachineId) : null,
                    onChange: changeMachine,
                    pending: machinePending
                }}
            />
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-4 py-2 text-[13px]">
                <span className="pw-eyebrow shrink-0 text-[var(--app-hint)]">{t('assistant.viewing')}</span>
                {task ? (
                    <>
                        <StatusDot column={task.column} />
                        <span className="min-w-0 flex-1 truncate text-[var(--app-fg)]">{task.title}</span>
                        <span className={`pw-eyebrow shrink-0 ${tone?.text ?? ''}`}>{t(`board.column.${task.column}`)}</span>
                        <button
                            type="button"
                            onClick={() => setDetached({ from: selectedTaskId, set: true })}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors duration-300 hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                            title={t('assistant.viewing.detach')}
                            aria-label={t('assistant.viewing.detach')}
                        >
                            <CloseIcon className="h-3 w-3" />
                        </button>
                    </>
                ) : props.task ? (
                    <>
                        <span className="min-w-0 flex-1 truncate text-[var(--app-hint)]">{t('assistant.viewing.all')}</span>
                        <button
                            type="button"
                            onClick={() => setDetached({ from: selectedTaskId, set: false })}
                            className="pw-underline min-w-0 max-w-[50%] shrink truncate text-[var(--app-fg)]"
                            title={props.task.title}
                        >
                            {t('assistant.viewing.reattach', { title: props.task.title })}
                        </button>
                    </>
                ) : (
                    <span className="flex-1 text-[var(--app-hint)]">{t('assistant.viewing.all')}</span>
                )}
                <button
                    type="button"
                    onClick={() => setTab('memory')}
                    className="flex shrink-0 items-center gap-1 text-[var(--app-hint)] transition-colors duration-300 hover:text-[var(--app-fg)]"
                    title={t('assistant.viewing.memoriesHint')}
                    aria-label={t('assistant.viewing.memoriesHint')}
                >
                    <BrainIcon className="h-3.5 w-3.5" />
                    <span className="tabular-nums">{related.length}</span>
                </button>
            </div>

            {agentError ? (
                <p role="alert" className="border-b border-[var(--app-border)] px-4 py-2 text-xs text-[var(--app-accent)]">
                    {t('assistant.agent.error', { error: agentError })}
                </p>
            ) : null}

            {machineError ? (
                <p role="alert" className="border-b border-[var(--app-border)] px-4 py-2 text-xs text-[var(--app-accent)]">
                    {t('assistant.machine.error', { error: machineError })}
                </p>
            ) : null}

            {tab === 'chat' && missingPaths.length > 0 ? (
                <p className="border-b border-[var(--app-border)] px-4 py-2 text-xs text-[var(--app-badge-warning-text)]">
                    {t('assistant.machine.missingPaths', {
                        machine: labelOf(assistantMachineId ?? ''),
                        paths: missingPaths.join(', ')
                    })}
                </p>
            ) : null}

            {tab === 'chat' && switched ? (
                <p className="border-b border-[var(--app-border)] px-4 py-2 text-xs text-[var(--app-hint)]">
                    {task
                        ? t('assistant.switched', { title: task.title, count: related.length })
                        : t('assistant.switched.all', { count: related.length })}
                </p>
            ) : null}

            <div
                role="tabpanel"
                id={tabIds(props.titleId, tab).panel}
                aria-labelledby={tabIds(props.titleId, tab).tab}
                className="flex min-h-0 flex-1 flex-col"
            >
                {tab === 'chat' && assistant.isLoading ? (
                    <p className="px-4 py-8 text-center text-[13px] text-[var(--app-hint)]">{t('assistant.session.loading')}</p>
                ) : tab === 'chat' && assistant.error ? (
                    // Not "not started": the lookup failed, and a first message
                    // sent now could start a second assistant.
                    <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
                        <p role="alert" className="text-[13px] text-[var(--app-accent)]">
                            {t('assistant.session.error', { error: assistant.error })}
                        </p>
                        <button
                            type="button"
                            onClick={refreshSessionId}
                            className="pw-ghost-sweep rounded-full border border-[var(--app-fg)] px-3 py-1 text-xs font-semibold text-[var(--app-fg)]"
                        >
                            {t('assistant.session.retry')}
                        </button>
                    </div>
                ) : tab === 'chat' ? (
                    <AssistantChat
                        key={`${agent}:${machineId ?? AUTO_MACHINE}`}
                        api={props.api}
                        workspaceUserId={props.workspaceUserId}
                        sessionId={sessionId}
                        onSessionId={setSessionId}
                        onSessionGone={refreshSessionId}
                        contextTaskId={task?.id ?? null}
                        onSent={() => setConversationTaskId(task?.id ?? null)}
                    />
                ) : tab === 'questions' ? (
                    <AssistantQuestionsTab questions={questions} grants={grants} taskTitles={taskTitles} answer={answer} />
                ) : (
                    <AssistantMemoryTab
                        workspaceUserId={props.workspaceUserId}
                        task={task}
                        memories={memories}
                        grants={grants}
                        actions={actions}
                        seenAt={seenAt}
                        initialOpenId={openMemoryId}
                        onOpenSource={() => setTab('chat')}
                    />
                )}
            </div>
        </>
    )
}
