import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
    useRouterState
} from '@tanstack/react-router'
import type { AgentState, AssistantGrant, AssistantMemory, AssistantQuestion, Task, TaskSchedule, TaskScheduleInput } from '@hapi/protocol'
import type { CreateTaskRequest } from '@hapi/protocol/apiTypes'
import { nextScheduleRuns } from '@hapi/protocol'
import '@fontsource-variable/host-grotesk'
import '../src/index.css'
import type { ApiClient } from '../src/api/client'
import type { DecryptedMessage, Session } from '../src/types/api'
import { AppContextProvider } from '../src/lib/app-context'
import { I18nProvider } from '../src/lib/i18n-context'
import { useTranslation } from '../src/lib/use-translation'
import { ToastProvider } from '../src/lib/toast-context'
import { queryKeys } from '../src/lib/query-keys'
import { ingestIncomingMessages } from '../src/lib/message-window-store'
import { setAssistantPanelOpen } from '../src/lib/assistantPanel'
import { normalizeDecryptedMessage } from '../src/chat/normalize'
import { reduceChatBlocks } from '../src/chat/reducer'
import { reconcileChatBlocks } from '../src/chat/reconcile'
import { buildVisibleChatBlocks } from '../src/chat/toolGroups'
import type { ChatBlock } from '../src/chat/types'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { HappyThread } from '../src/components/AssistantChat/HappyThread'
import { HappyComposer } from '../src/components/AssistantChat/HappyComposer'
import { AssistantHeaderButton, AssistantHost, useIsSplitLayout } from '../src/components/Assistant/AssistantHost'
import { SidebarHeader } from '../src/components/SidebarHeader'
import { TaskSwitcher, countAttentionTasks } from '../src/components/Tasks/TaskSwitcher'
import { StatusDot, taskColumnTone } from '../src/components/Tasks/StatusDot'
import { useNewTaskDialog } from '../src/components/Tasks/useNewTaskDialog'
import {
    ADOPTABLE_SESSIONS,
    ADOPTED_MESSAGES,
    ADOPTED_SESSION_ID,
    CODEX_REQUEST,
    CODEX_TOOL_ID,
    DIRECTORIES,
    HANDOFF_TASK,
    MACHINE,
    VIDEO,
    codexAfterApproval,
    ASSISTANT_HISTORY,
    ASSISTANT_SESSION_ID,
    INITIAL_MEMORIES,
    INITIAL_QUESTIONS,
    NEW_MEMORY,
    NOW,
    PING_REQUEST,
    PING_TOOL_ID,
    SESSIONS,
    TASK_MESSAGES,
    TASKS,
    WORKDIR,
    WORKSPACE_USER,
    buildBeats,
    user,
    type Beat
} from './assistant-panel-demo-data'

// Demo of the task assistant for screenshots and screen recordings: the real
// task list, the real assistant panel (chat, Memory, To answer), and a task's
// chat through the real pipeline, all over a fake API. Nothing talks to a hub.
//
//   ?lang=en      English interface and data (default: Chinese)
//   ?play=1       start before the conversation; each message you send plays
//                 the next scripted reply, and Allow on the request finishes it
//   ?video=1      the launch video's run (implies ?play=1): the handoff task
//                 is created through the New task dialog and runs to Review
//   ?path=/sessions/s-handoff   which task is open (phones start on the list)
//
// Locale, active workspace user and acknowledged FUEs are seeded by the HTML
// page: modules read them at import time, before this body runs.

const SEARCH = new URLSearchParams(window.location.search)
const PLAY = VIDEO || SEARCH.get('play') === '1'
/** `?after=1`: where the video's desktop part ends — the assistant has sent
 *  the message and the handoff task is running again. For the phone shots. */
const AFTER = SEARCH.get('after') === '1'
/** `?assistant=0`: the panel starts closed even on a desktop. */
const ASSISTANT_OPEN = SEARCH.get('assistant') !== '0'

const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } }
})

// ---------------------------------------------------------------------------
// Demo state behind the fake API.

const state = {
    tasks: TASKS.map((task) => ({ ...task })),
    memories: [...INITIAL_MEMORIES],
    questions: [...INITIAL_QUESTIONS],
    assistantLog: [...ASSISTANT_HISTORY] as DecryptedMessage[],
    agentState: { requests: {}, completedRequests: {} } as NonNullable<AgentState>,
    grants: [] as AssistantGrant[],
    schedules: [] as TaskSchedule[],
    taskMessages: { ...TASK_MESSAGES, ...(VIDEO ? { 's-handoff': [] } : {}) } as Record<string, DecryptedMessage[]>,
    taskAgentState: {
        's-codex': { requests: { [CODEX_TOOL_ID]: { ...CODEX_REQUEST, createdAt: NOW - 60_000 } }, completedRequests: {} }
    } as Record<string, NonNullable<AgentState>>,
    thinking: false,
    beatIndex: 0
}

const beats: Beat[] = buildBeats(() => Date.now())

const invalidate = (key: readonly unknown[]) => void queryClient.invalidateQueries({ queryKey: key })

// Task chats and their requests re-render through this, not through queries.
let version = 0
const listeners = new Set<() => void>()
function bump(): void {
    version += 1
    for (const listener of listeners) listener()
}
function useDemoVersion(): number {
    return useSyncExternalStore((listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
    }, () => version)
}

function appendTaskMessage(sessionId: string, message: DecryptedMessage): void {
    state.taskMessages = { ...state.taskMessages, [sessionId]: [...(state.taskMessages[sessionId] ?? []), message] }
    bump()
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function assistantSession(): Session {
    return {
        id: ASSISTANT_SESSION_ID,
        active: true,
        thinking: state.thinking,
        activeAt: Date.now(),
        updatedAt: Date.now(),
        agentState: state.agentState,
        agentStateVersion: 1,
        metadataVersion: 1,
        permissionMode: 'auto',
        model: 'opus',
        backgroundTaskCount: 0,
        metadata: { path: WORKDIR, host: 'devbox', name: `${WORKSPACE_USER.name} · assistant`, flavor: 'claude', role: 'assistant' }
    } as unknown as Session
}

function pushAssistantSession(): void {
    queryClient.setQueryData(queryKeys.session(ASSISTANT_SESSION_ID), { session: assistantSession() })
}

/** `live`: the thread is on screen, so the message also goes into its store. */
function appendAssistant(message: DecryptedMessage, live: boolean): void {
    state.assistantLog.push(message)
    if (live) ingestIncomingMessages(ASSISTANT_SESSION_ID, [message])
}

const DEMO_TASKS_KEY = ['demo', 'tasks'] as const

function setTaskColumn(taskId: string, column: Task['column']): void {
    state.tasks = state.tasks.map((task) => (task.id === taskId ? { ...task, column, updatedAt: Date.now() } : task))
    refreshTasks()
}

function refreshTasks(): void {
    invalidate(queryKeys.tasks)
    invalidate(DEMO_TASKS_KEY)
    bump()
}

/** The handoff task's first run, as the video shows it: tool calls arrive at
 *  about eight times real speed, then the turn ends and the task goes to Review. */
async function runHandoffTask(prompt: string): Promise<void> {
    const [, ...rest] = TASK_MESSAGES['s-handoff']
    state.taskMessages = { ...state.taskMessages, 's-handoff': [user(prompt, Date.now())] }
    bump()
    for (const message of rest) {
        await sleep(650)
        appendTaskMessage('s-handoff', { ...message, createdAt: Date.now() })
    }
    await sleep(700)
    setTaskColumn('t-handoff', 'review')
}

async function playBeat(beat: Beat, live: boolean): Promise<void> {
    state.thinking = live
    if (live) pushAssistantSession()
    for (const step of beat.steps) {
        if (live) await sleep(step.delayMs)
        appendAssistant(step.message(), live)
        if (step.effect === 'add-memory') {
            state.memories = [{ ...NEW_MEMORY, createdAt: Date.now(), updatedAt: Date.now() }, ...state.memories]
            invalidate(queryKeys.assistantMemories(WORKSPACE_USER.id))
        }
    }
    if (beat.after === 'ask-permission') {
        state.agentState = {
            ...state.agentState,
            requests: { [PING_TOOL_ID]: { ...PING_REQUEST, createdAt: Date.now() } }
        }
    }
    if (beat.after === 'task-running') {
        setTaskColumn('t-handoff', 'running')
    }
    state.thinking = false
    if (live) pushAssistantSession()
}

// Without ?play the first two beats have already happened, and the message to
// the task is waiting for approval; with ?after the third has too.
if (!PLAY) {
    const played = AFTER ? 3 : 2
    for (const beat of beats.slice(0, played)) {
        if (beat.prompt) state.assistantLog.push(user(beat.prompt, NOW - 6 * 60_000))
        void playBeat(beat, false)
    }
    if (AFTER) {
        state.agentState = {
            requests: {},
            completedRequests: { [PING_TOOL_ID]: { ...PING_REQUEST, createdAt: NOW - 3 * 60_000, completedAt: NOW - 3 * 60_000, status: 'approved' } }
        }
    }
    state.beatIndex = played
}

/** `after`: the cursor of a tail request; the reply is then that page, not a fresh latest window. */
function messagesPage(all: DecryptedMessage[], after: number | null) {
    const messages = after === null ? all : all.filter((m) => (m.seq ?? 0) > after)
    const last = all.at(-1)
    return {
        messages,
        page: {
            direction: after === null ? 'latest' as const : 'after' as const,
            limit: 200,
            epoch: 1,
            reset: false,
            nextBeforeSeq: null,
            nextBeforeAt: null,
            nextAfterSeq: messages.at(-1)?.seq ?? after,
            nextAfterAt: messages.at(-1)?.createdAt ?? null,
            snapshotHeadSeq: last?.seq ?? null,
            snapshotHeadAt: last?.createdAt ?? null,
            hasMore: false
        }
    }
}

function taskSession(id: string, title: string, thinking = false): Session {
    return {
        id,
        active: true,
        thinking,
        agentState: state.taskAgentState[id] ?? null,
        permissionMode: 'default',
        metadata: { path: WORKDIR, host: 'devbox', name: title, flavor: 'claude' }
    } as unknown as Session
}

const handlers: Record<string, (...args: never[]) => unknown> = {
    getTasks: async () => ({ tasks: state.tasks, counts: {} }),
    getTask: async (taskId: string) => ({ task: state.tasks.find((task) => task.id === taskId) ?? null, runs: [] }),
    getSessions: async () => ({ sessions: SESSIONS }),
    getWorkspaceUsers: async () => ({ workspaceUsers: [WORKSPACE_USER] }),
    getMachines: async () => ({ machines: [MACHINE] }),
    checkMachinePathsExists: async (_machineId: string, paths: string[]) => ({ exists: Object.fromEntries(paths.map((path) => [path, true])) }),
    listMachineDirectory: async (_machineId: string, path: string) => ({
        success: true,
        entries: (DIRECTORIES[path] ?? []).map((entry) => ({ name: entry.name, type: 'directory', isGitRepo: entry.isGitRepo }))
    }),
    createTask: async (payload: CreateTaskRequest) => {
        const task: Task = {
            ...HANDOFF_TASK,
            title: payload.title?.trim() || HANDOFF_TASK.title,
            prompt: payload.prompt ?? HANDOFF_TASK.prompt,
            column: payload.start ? 'running' : 'backlog',
            createdAt: Date.now(),
            updatedAt: Date.now()
        }
        state.tasks = [task, ...state.tasks.filter((candidate) => candidate.id !== task.id)]
        refreshTasks()
        if (payload.start) void runHandoffTask(task.prompt)
        return { task, start: payload.start ? { outcome: 'started', sessionId: 's-handoff' } : undefined }
    },
    getClaudeSessions: async () => ({ success: true, sessions: ADOPTABLE_SESSIONS, machineId: MACHINE.id }),
    importClaudeSessions: async () => ({ success: true, results: [{ claudeSessionId: ADOPTABLE_SESSIONS[0].id, hapiSessionId: ADOPTED_SESSION_ID, action: 'created' }] }),
    adoptTask: async (payload: { title?: string }) => {
        const task: Task = {
            ...HANDOFF_TASK,
            id: 't-adopted',
            title: payload.title?.trim() || ADOPTABLE_SESSIONS[0].title,
            prompt: ADOPTABLE_SESSIONS[0].title,
            column: 'review',
            currentSessionId: ADOPTED_SESSION_ID,
            branch: null,
            worktreePath: null,
            isolation: 'simple',
            createdAt: Date.now(),
            updatedAt: Date.now()
        }
        state.tasks = [task, ...state.tasks]
        state.taskMessages = { ...state.taskMessages, [ADOPTED_SESSION_ID]: ADOPTED_MESSAGES }
        refreshTasks()
        return { task }
    },
    getTaskSchedules: async () => ({ schedules: state.schedules }),
    getTaskSchedule: async (taskId: string) => ({ schedule: state.schedules.find((schedule) => schedule.taskId === taskId) ?? null }),
    getTaskScheduleSlots: async () => ({ slots: [] }),
    saveTaskSchedule: async (taskId: string, input: TaskScheduleInput) => {
        const schedule: TaskSchedule = {
            taskId,
            namespace: 'default',
            cron: input.cron,
            tz: input.tz,
            enabled: true,
            catchup: input.catchup ?? true,
            overlap: input.overlap ?? 'skip',
            sessionMode: input.sessionMode ?? 'fresh',
            maxRunMs: input.maxRunMs ?? 60 * 60_000,
            nextRunAt: nextScheduleRuns(input.cron, input.tz, Date.now(), 1)[0] ?? null,
            pausedReason: null,
            createdAt: Date.now(),
            updatedAt: Date.now()
        }
        state.schedules = [schedule, ...state.schedules.filter((candidate) => candidate.taskId !== taskId)]
        invalidate(queryKeys.taskSchedules(WORKSPACE_USER.id))
        invalidate(queryKeys.taskSchedule(taskId))
        return { schedule }
    },
    getSlashCommands: async () => ({ success: true, commands: [] }),
    getSkills: async () => ({ success: true, skills: [] }),
    moveTask: async () => ({}),
    abortSession: async () => {},

    getAssistantSession: async () => ({ sessionId: ASSISTANT_SESSION_ID, agent: 'claude' }),
    setAssistantAgent: async (payload: { agent: string }) => ({ sessionId: ASSISTANT_SESSION_ID, agent: payload.agent }),
    getAssistantGrants: async () => ({ grants: state.grants }),
    revokeAssistantGrant: async () => {},
    getAssistantMemories: async () => ({ memories: state.memories }),
    createAssistantMemory: async (payload: Partial<AssistantMemory>) => {
        const memory = { ...NEW_MEMORY, ...payload, id: `mem-${Date.now()}`, createdBy: 'human', lastEditedBy: 'human', source: null, previous: null, updatedAt: Date.now() } as AssistantMemory
        state.memories = [memory, ...state.memories]
        invalidate(queryKeys.assistantMemories(WORKSPACE_USER.id))
        return { memory }
    },
    updateAssistantMemory: async (id: string, patch: Partial<AssistantMemory>) => {
        state.memories = state.memories.map((m) => (m.id === id ? { ...m, ...patch, lastEditedBy: 'human', previous: null, updatedAt: Date.now() } : m))
        invalidate(queryKeys.assistantMemories(WORKSPACE_USER.id))
        return { memory: state.memories.find((m) => m.id === id) }
    },
    deleteAssistantMemory: async (id: string) => {
        state.memories = state.memories.filter((m) => m.id !== id)
        invalidate(queryKeys.assistantMemories(WORKSPACE_USER.id))
    },
    undoAssistantMemory: async (id: string) => {
        const memory = state.memories.find((m) => m.id === id)
        state.memories = memory?.previous
            ? state.memories.map((m) => (m.id === id ? { ...m, ...memory.previous!, previous: null } : m))
            : state.memories.filter((m) => m.id !== id)
        invalidate(queryKeys.assistantMemories(WORKSPACE_USER.id))
        return { memory: state.memories.find((m) => m.id === id) ?? null }
    },
    getAssistantQuestions: async () => ({ questions: state.questions }),
    answerAssistantQuestion: async (id: string, answer: string) => {
        state.questions = state.questions.map((q): AssistantQuestion => (q.id === id
            ? { ...q, answer, status: answer === q.chosen ? 'confirmed' : 'overridden', answeredAt: Date.now() }
            : q))
        return { question: state.questions.find((q) => q.id === id), reworkError: null }
    },

    getSession: async (sessionId: string) => {
        if (sessionId === ASSISTANT_SESSION_ID) return { session: assistantSession() }
        const task = state.tasks.find((candidate) => candidate.currentSessionId === sessionId)
        return { session: taskSession(sessionId, task?.title ?? '') }
    },
    getMessages: async (sessionId: string, options: { afterSeq?: number | null }) => {
        const all = sessionId === ASSISTANT_SESSION_ID ? state.assistantLog : TASK_MESSAGES[sessionId] ?? []
        return messagesPage(all, options.afterSeq ?? null)
    },
    sendAssistantMessage: async (payload: { text: string; localId?: string }) => {
        appendAssistant(user(payload.text, Date.now(), payload.localId ?? null), true)
        const beat = beats[state.beatIndex]
        if (beat?.prompt) {
            state.beatIndex += 1
            void playBeat(beat, true)
        }
        return { sessionId: ASSISTANT_SESSION_ID }
    },
    approvePermission: async (sessionId: string, requestId: string, options?: { decision?: string }) => {
        if (sessionId === 's-codex' && requestId === CODEX_TOOL_ID) {
            state.taskAgentState = {
                ...state.taskAgentState,
                's-codex': {
                    requests: {},
                    completedRequests: { [CODEX_TOOL_ID]: { ...CODEX_REQUEST, createdAt: NOW - 60_000, completedAt: Date.now(), status: 'approved' } }
                }
            }
            setTaskColumn('t-codex', 'running')
            for (const message of codexAfterApproval(() => Date.now())) {
                await sleep(900)
                appendTaskMessage('s-codex', message())
            }
            await sleep(600)
            setTaskColumn('t-codex', 'review')
            return
        }
        if (sessionId !== ASSISTANT_SESSION_ID || requestId !== PING_TOOL_ID) return
        state.agentState = {
            requests: {},
            completedRequests: {
                [PING_TOOL_ID]: {
                    ...PING_REQUEST,
                    createdAt: Date.now(),
                    completedAt: Date.now(),
                    status: 'approved',
                    decision: options?.decision === 'approved_for_session' ? 'approved_for_session' : 'approved'
                }
            }
        }
        pushAssistantSession()
        if (options?.decision === 'approved_for_session') {
            state.grants = [{ id: 'grant-ping', workspaceUserId: WORKSPACE_USER.id, tool: PING_REQUEST.tool, createdAt: Date.now() }]
            invalidate(queryKeys.assistantGrants(WORKSPACE_USER.id))
        }
        const beat = beats[state.beatIndex]
        if (beat && !beat.prompt) {
            state.beatIndex += 1
            await playBeat(beat, true)
        }
    },
    denyPermission: async (sessionId: string, requestId: string) => {
        if (sessionId !== ASSISTANT_SESSION_ID || requestId !== PING_TOOL_ID) return
        state.agentState = {
            requests: {},
            completedRequests: { [PING_TOOL_ID]: { ...PING_REQUEST, createdAt: Date.now(), completedAt: Date.now(), status: 'denied' } }
        }
        pushAssistantSession()
    }
}

// Anything the demo does not script stays pending rather than failing, so a
// stray query shows its loading state instead of an error.
const fakeApi = new Proxy({} as ApiClient, {
    get(_target, property: string) {
        return handlers[property] ?? (() => new Promise(() => {}))
    }
})

// ---------------------------------------------------------------------------
// A task's chat over static messages, through the real pipeline. The real
// SessionChat needs a live hub; the thread and composer it renders are these.

function StaticThread(props: { session: Session; messages: DecryptedMessage[]; agentState?: AgentState | null }) {
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const normalized = useMemo(
        () => props.messages.map(normalizeDecryptedMessage).filter((m): m is NonNullable<typeof m> => m !== null),
        [props.messages]
    )
    const reduced = useMemo(() => reduceChatBlocks(normalized, props.agentState ?? null, {}), [normalized, props.agentState])
    const reconciled = useMemo(() => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current), [reduced.blocks])
    blocksByIdRef.current = reconciled.byId
    const blocks = useMemo(() => buildVisibleChatBlocks(reconciled.blocks, { hasMoreMessages: false }), [reconciled.blocks])

    const runtime = useHappyRuntime({
        session: props.session,
        blocks,
        messagesVersion: 1,
        historyVersion: 1,
        isSending: false,
        onSendMessage: () => {},
        onAbort: async () => {}
    })

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <div className="flex min-h-0 flex-1 flex-col">
                <HappyThread
                    api={fakeApi}
                    session={props.session}
                    sessionId={props.session.id}
                    metadata={null}
                    disabled={false}
                    onRefresh={() => {}}
                    onViewModeChange={() => {}}
                    isSyncingTail={false}
                    messagesWarning={null}
                    hasMoreMessages={false}
                    isLoadingMoreMessages={false}
                    onLoadMore={async () => ({ kind: 'stopped' as const, reason: 'exhausted' as const })}
                    onCancelLoadMore={() => {}}
                    unseenCount={0}
                    rawMessagesCount={props.messages.length}
                    normalizedMessagesCount={normalized.length}
                    messagesVersion={1}
                    historyVersion={1}
                    forceScrollToken={0}
                    outlineOpen={false}
                    outlineItems={[]}
                    onOutlineOpenChange={() => {}}
                />
                <HappyComposer sessionId={props.session.id} active thinking={props.session.thinking} />
            </div>
        </AssistantRuntimeProvider>
    )
}

// ---------------------------------------------------------------------------
// Shell, laid out like the app's sessions page.

function PlusIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function sidebarToggleClass(active: boolean): string {
    return `p-1 rounded-full transition-colors ${
        active
            ? 'bg-[var(--app-subtle-bg)] text-[var(--app-link)]'
            : 'text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
    }`
}

function BackIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function CenterHeader(props: { task: Task | null; split: boolean }) {
    const { t } = useTranslation()
    const tone = props.task ? taskColumnTone(props.task.column) : null
    return (
        <div className="flex items-center gap-2 border-b border-[var(--app-divider)] px-4 py-2">
            {props.split ? null : (
                <button
                    type="button"
                    onClick={() => void router.navigate({ to: '/' })}
                    className="-ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                    aria-label={t('common.back')}
                >
                    <BackIcon className="h-5 w-5" />
                </button>
            )}
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    {props.task ? <StatusDot column={props.task.column} /> : null}
                    <span className="truncate text-sm font-medium text-[var(--app-fg)]">{props.task?.title ?? ''}</span>
                    {props.task ? <span className={`pw-eyebrow text-xs ${tone?.text}`}>{t(`board.column.${props.task.column}`)}</span> : null}
                </div>
                <div className="truncate text-xs text-[var(--app-hint)]">{props.task?.worktreePath ?? WORKDIR} · claude · opus</div>
            </div>
            {/* On a phone the task's header carries the assistant button. */}
            {props.split ? null : <AssistantHeaderButton className={sidebarToggleClass} iconClassName="h-5 w-5" />}
        </div>
    )
}

function Shell() {
    const { t } = useTranslation()
    useDemoVersion()
    const newTask = useNewTaskDialog(fakeApi)
    const pathname = useRouterState({ select: (s) => s.location.pathname })
    const selectedSessionId = pathname.startsWith('/sessions/') ? pathname.slice('/sessions/'.length) : null
    const split = useIsSplitLayout()
    const { data } = useQuery({ queryKey: DEMO_TASKS_KEY, queryFn: async () => (await fakeApi.getTasks()).tasks })
    const tasks = data ?? state.tasks
    const task = selectedSessionId ? tasks.find((candidate) => candidate.currentSessionId === selectedSessionId) ?? null : null
    const agentState = selectedSessionId ? state.taskAgentState[selectedSessionId] ?? null : null
    const session = useMemo(
        () => taskSession(selectedSessionId ?? 'none', task?.title ?? '', task?.column === 'running'),
        [selectedSessionId, task, agentState]
    )

    const sidebar = (
        <div className="flex min-h-0 w-full flex-col split:w-[340px] split:shrink-0 split:border-r split:border-[var(--app-divider)]">
            <SidebarHeader
                attentionCount={countAttentionTasks(tasks)}
                actions={(
                    <div className="flex shrink-0 items-center gap-1">
                        {split ? <AssistantHeaderButton className={sidebarToggleClass} iconClassName="h-5 w-5" /> : null}
                        <button
                            type="button"
                            onClick={() => newTask.open()}
                            className="pw-sweep flex h-8 w-8 items-center justify-center rounded-full bg-[var(--app-button)] text-[var(--app-button-text)]"
                            title={t('board.newTask')}
                        >
                            <PlusIcon className="h-5 w-5" />
                        </button>
                    </div>
                )}
            />
            <TaskSwitcher api={fakeApi} selectedSessionId={selectedSessionId} />
        </div>
    )
    const center = (
        <div className="flex min-w-0 flex-1 flex-col">
            <CenterHeader task={task} split={split} />
            {selectedSessionId ? (
                <StaticThread key={selectedSessionId} session={session} messages={state.taskMessages[selectedSessionId] ?? []} agentState={agentState} />
            ) : (
                <div className="flex-1" />
            )}
        </div>
    )

    return (
        <div className="flex h-screen min-h-0 bg-[var(--app-bg)]">
            {split ? <>{sidebar}{center}</> : selectedSessionId ? center : sidebar}
            <AssistantHost api={fakeApi} tasks={tasks} selectedSessionId={selectedSessionId} isSessionsIndex={!selectedSessionId} />
            {newTask.dialog}
        </div>
    )
}

function OpenAssistantOnDesktop(props: { children: ReactNode }) {
    const split = useIsSplitLayout()
    useEffect(() => {
        setAssistantPanelOpen(split && ASSISTANT_OPEN)
    }, [])
    return <>{props.children}</>
}

const rootRoute = createRootRoute({ component: Shell })
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null })
const sessionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/sessions/$sessionId', component: () => null })
const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, sessionRoute]),
    history: createMemoryHistory({
        initialEntries: [new URLSearchParams(window.location.search).get('path') ?? (window.innerWidth < 920 ? '/' : '/sessions/s-handoff')]
    })
})

ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <AppContextProvider value={{ api: fakeApi, token: '', baseUrl: '' }}>
            <I18nProvider>
                <ToastProvider>
                    <OpenAssistantOnDesktop>
                        <RouterProvider router={router} />
                    </OpenAssistantOnDesktop>
                </ToastProvider>
            </I18nProvider>
        </AppContextProvider>
    </QueryClientProvider>
)
