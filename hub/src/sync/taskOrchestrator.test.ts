import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { SyncEvent } from '@hapi/protocol'
import { Store } from '../store'
import type { StoredTask } from '../store'
import {
    PROMPT_ATTACH_TIMEOUT_MS,
    STARTUP_GRACE_MS,
    TaskOrchestrator,
    columnForFinishedRun,
    columnForLiveSession,
    runStatusForEndReason,
    type OrchestratorSession,
    type SpawnTaskSessionInput,
    type SpawnTaskSessionResult
} from './taskOrchestrator'

let store: Store
let orchestrator: TaskOrchestrator
let listeners: Array<(event: SyncEvent) => void>
let sessions: Map<string, OrchestratorSession>
let spawnCalls: SpawnTaskSessionInput[]
let spawnImpl: (input: SpawnTaskSessionInput) => Promise<SpawnTaskSessionResult>
let sentMessages: Array<{ sessionId: string; text: string }>
let sendImpl: (sessionId: string, text: string) => Promise<void>
let abortCalls: string[]
let stopCalls: Array<{ machineId: string; sessionId: string }>
let abortImpl: (sessionId: string) => Promise<void>
let published: StoredTask[]

/** What the hub's rename does to the row, minus the cache and the events. */
async function renameStoredSession(sessionId: string, name: string): Promise<void> {
    const row = store.sessions.getSession(sessionId)
    if (!row) throw new Error('Session not found')
    store.sessions.updateSessionMetadata(
        sessionId, { ...(row.metadata as object), name }, row.metadataVersion, row.namespace
    )
}

const sessionName = (id: string) =>
    (store.sessions.getSession(id)?.metadata as { name?: string } | undefined)?.name

function emit(event: SyncEvent): void {
    for (const listener of listeners) listener(event)
}

/** Board tasks need a real session row — `tasks.current_session_id` is an FK. */
function seedSession(id: string, overrides?: Partial<OrchestratorSession>): void {
    store.sessions.getOrCreateSession(
        id, { path: '/repo', host: 'box' }, null, 'default',
        undefined, undefined, undefined, id
    )
    sessions.set(id, { id, namespace: 'default', active: true, ...overrides })
}

function makeTask(overrides: Partial<Parameters<Store['tasks']['create']>[0]> = {}): StoredTask {
    return store.tasks.create({
        namespace: 'default',
        title: 'Fix the parser',
        prompt: 'Fix it.',
        workdir: '/repo',
        machineId: 'box-1',
        spawn: { flavor: 'claude' },
        ...overrides
    })
}

beforeEach(() => {
    store = new Store(':memory:')
    listeners = []
    sessions = new Map()
    spawnCalls = []
    abortCalls = []
    stopCalls = []
    published = []
    seedSession('sess-1')
    spawnImpl = async () => ({ type: 'success', sessionId: 'sess-1' })
    sentMessages = []
    sendImpl = async () => {}
    abortImpl = async () => {}

    orchestrator = new TaskOrchestrator({
        store,
        getSession: (id) => sessions.get(id) ?? null,
        spawnSession: async (input) => {
            spawnCalls.push(input)
            return await spawnImpl(input)
        },
        sendMessage: async (sessionId, text) => {
            sentMessages.push({ sessionId, text })
            await sendImpl(sessionId, text)
        },
        abortSession: async (id) => {
            abortCalls.push(id)
            await abortImpl(id)
        },
        stopSession: async (machineId, sessionId) => {
            stopCalls.push({ machineId, sessionId })
        },
        subscribe: (listener) => {
            listeners.push(listener)
            return () => {
                listeners = listeners.filter((entry) => entry !== listener)
            }
        },
        onTaskChanged: (task) => published.push(task),
        // No reattach window by default: these tests assert on what the sweep
        // and the session handlers decide, not on how long the hub waits for a
        // reconnect. The window's own behaviour has its own tests below.
        reattachWindowMs: 0,
        logger: { error: () => {} }
    })
})

afterEach(() => {
    orchestrator.stop()
    store.close()
})

describe('adopted tasks', () => {
    const adoptedSpawn = (nativeId: string) => ({
        flavor: 'claude' as const,
        adoptedSessionId: 'import-row',
        adoptedNativeSessionId: nativeId
    })

    it('resumes the native conversation and sends no prompt', async () => {
        // Resuming Claude opens a new HAPI row rather than reusing the imported
        // one, so the card starts like any other card — the only differences
        // are the resume id going down to the runner and the prompt staying put.
        const task = makeTask({ spawn: adoptedSpawn('native-abc') })

        const result = await orchestrator.startTask(task.id, 'default')

        expect(result.outcome).toBe('started')
        expect(spawnCalls).toHaveLength(1)
        expect(spawnCalls[0].resumeSessionId).toBe('native-abc')
        // `task.prompt` is only the adopted conversation's summary; delivering
        // it would inject a line nobody typed into an existing thread.
        expect(sentMessages).toEqual([])
        expect(store.tasks.get(task.id)?.currentSessionId).toBe('sess-1')
    })

    describe('when the hub can reopen sessions', () => {
        let reopenCalls: string[]
        let reopenImpl: (sessionId: string) => Promise<SpawnTaskSessionResult>
        let reopening: TaskOrchestrator

        beforeEach(() => {
            reopenCalls = []
            reopenImpl = async (sessionId) => ({ type: 'success', sessionId: `resumed-${sessionId}` })
            reopening = new TaskOrchestrator({
                store,
                getSession: (id) => sessions.get(id) ?? null,
                spawnSession: async (input) => {
                    spawnCalls.push(input)
                    return await spawnImpl(input)
                },
                sendMessage: async (sessionId, text) => { sentMessages.push({ sessionId, text }) },
                reopenSession: async (sessionId) => {
                    reopenCalls.push(sessionId)
                    return await reopenImpl(sessionId)
                },
                stopSession: async (machineId, sessionId) => {
                    stopCalls.push({ machineId, sessionId })
                    return 'stopped'
                },
                subscribe: () => () => {},
                reattachWindowMs: 0,
                logger: { error: () => {} }
            })
        })
        afterEach(() => reopening.stop())

        it('runs again in the session that holds the history', async () => {
            // Reproduced live: a re-run spawned a fresh session, which stays
            // empty until someone types (an adopted start sends nothing), so
            // the card opened on a blank chat with the history elsewhere.
            seedSession('import-row', { active: false })
            seedSession('resumed-import-row')
            seedSession('empty-run')
            const task = makeTask({ spawn: adoptedSpawn('native-abc') })
            store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user', sessionId: 'empty-run' })
            store.tasks.finishRun(store.tasks.getActiveRun(task.id)!.id, { status: 'succeeded', column: 'review' })

            const result = await reopening.startTask(task.id, 'default')

            expect(result).toMatchObject({ outcome: 'started', sessionId: 'resumed-import-row' })
            expect(reopenCalls).toEqual(['import-row'])
            expect(spawnCalls).toEqual([])
            expect(sentMessages).toEqual([])
            // The blank session the old start left is not kept alongside.
            expect(stopCalls).toEqual([{ machineId: 'box-1', sessionId: 'empty-run' }])
            expect(store.tasks.get(task.id)?.currentSessionId).toBe('resumed-import-row')
        })

        it('falls back to a fresh session resuming the native id', async () => {
            reopenImpl = async () => ({ type: 'error', message: 'machine offline' })
            const task = makeTask({ spawn: adoptedSpawn('native-abc') })

            const result = await reopening.startTask(task.id, 'default')

            expect(result.outcome).toBe('started')
            expect(spawnCalls[0].resumeSessionId).toBe('native-abc')
            expect(store.tasks.listRuns(task.id)).toHaveLength(1)
        })
    })

    it('still delivers the prompt for an ordinary card', async () => {
        const task = makeTask()

        await orchestrator.startTask(task.id, 'default')

        expect(spawnCalls[0].resumeSessionId).toBeUndefined()
        expect(sentMessages).toEqual([{ sessionId: 'sess-1', text: 'Fix it.' }])
    })

    it('blocks the card when the resume spawn fails', async () => {
        const task = makeTask({ spawn: adoptedSpawn('native-gone') })
        spawnImpl = async () => ({ type: 'error', message: 'No machine online' })

        const result = await orchestrator.startTask(task.id, 'default')

        expect(result.outcome).toBe('spawn-failed')
        const settled = store.tasks.get(task.id)
        expect(settled?.column).toBe('blocked')
        expect(settled?.lastRunStatus).toBe('failed')
    })
})

describe('sessions no card owns', () => {
    /** A session the board did not spawn, as a terminal `dugong claude` leaves it. */
    function seedOffBoard(
        id: string,
        options?: { nativeId?: string | null; messages?: string[]; active?: boolean; path?: string; flavor?: string }
    ): void {
        const nativeId = options?.nativeId === undefined ? `native-${id}` : options.nativeId
        store.sessions.getOrCreateSession(id, {
            path: options?.path ?? '/repo',
            host: 'box',
            machineId: 'box-1',
            flavor: options?.flavor ?? 'claude',
            startedBy: 'terminal',
            ...(nativeId ? { claudeSessionId: nativeId } : {})
        }, null, 'default', undefined, undefined, undefined, id)
        for (const [index, text] of (options?.messages ?? ['what is the workdir?']).entries()) {
            store.messages.addImportedMessage(id, {
                role: 'user',
                content: { type: 'text', text },
                meta: { sentFrom: 'cli' }
            }, `${id}:u${index}`, index + 1)
        }
        sessions.set(id, { id, namespace: 'default', active: options?.active ?? true, thinking: true })
    }

    const cards = () => store.tasks.list('default')

    it('gives a live terminal session a running card', () => {
        orchestrator.start()
        seedOffBoard('term-1')

        emit({ type: 'session-updated', sessionId: 'term-1' })

        const [card] = cards()
        expect(card?.column).toBe('running')
        expect(card?.title).toBe('what is the workdir?')
        expect(card?.isolation).toBe('simple')
        expect(card?.currentSessionId).toBe('term-1')
        expect(card?.lastRunStatus).toBe('running')
        expect(card?.spawn).toMatchObject({ adoptedSessionId: 'term-1', adoptedNativeSessionId: 'native-term-1' })
    })

    it('settles the adopted run like any other when the session ends', () => {
        orchestrator.start()
        seedOffBoard('term-1')
        emit({ type: 'session-updated', sessionId: 'term-1' })

        emit({ type: 'session-ended', sessionId: 'term-1' })

        expect(cards()[0]?.column).toBe('review')
        expect(cards()[0]?.lastRunStatus).toBe('succeeded')
    })

    it('adopts once, however many updates follow', () => {
        orchestrator.start()
        seedOffBoard('term-1')

        emit({ type: 'session-added', sessionId: 'term-1' })
        emit({ type: 'session-updated', sessionId: 'term-1' })
        emit({ type: 'session-updated', sessionId: 'term-1' })

        expect(cards()).toHaveLength(1)
    })

    it('never gives a task assistant a card, live or on the startup sweep', () => {
        store.sessions.getOrCreateSession('assistant-1', {
            path: '/hapi/assistant/wu-1', host: 'box', machineId: 'box-1', flavor: 'claude',
            claudeSessionId: 'native-assistant', role: 'assistant', workspaceUserId: 'wu-1'
        }, null, 'default', undefined, undefined, undefined, 'assistant-1')
        store.messages.addImportedMessage('assistant-1', {
            role: 'user', content: { type: 'text', text: 'what is waiting on me?' }, meta: { sentFrom: 'webapp' }
        }, 'assistant-1:u0', 1)
        sessions.set('assistant-1', { id: 'assistant-1', namespace: 'default', active: true, thinking: true })

        orchestrator.start()
        emit({ type: 'session-updated', sessionId: 'assistant-1' })

        expect(cards()).toHaveLength(0)
        expect(orchestrator.adoptSession('assistant-1')).toEqual({ outcome: 'not-adoptable', reason: 'assistant' })
    })

    it('waits for the first message and the native id', () => {
        orchestrator.start()
        seedOffBoard('term-1', { messages: [], nativeId: null })

        emit({ type: 'session-updated', sessionId: 'term-1' })
        expect(cards()).toHaveLength(0)

        store.sessions.updateSessionMetadata(
            'term-1',
            { path: '/repo', host: 'box', machineId: 'box-1', flavor: 'claude', claudeSessionId: 'native-late' },
            1,
            'default'
        )
        emit({ type: 'session-updated', sessionId: 'term-1' })
        expect(cards()).toHaveLength(0)

        store.messages.addImportedMessage('term-1', {
            role: 'user', content: { type: 'text', text: 'hello' }, meta: { sentFrom: 'cli' }
        }, 'term-1:late', 1)
        emit({ type: 'session-updated', sessionId: 'term-1' })
        expect(cards()).toHaveLength(1)
    })

    it('leaves a session alone while another row carries its conversation', () => {
        // A resume reports a new row before the cache folds the old one into
        // it; the card, if any, follows the merge instead.
        orchestrator.start()
        seedOffBoard('old-row', { nativeId: 'native-shared', active: false })
        seedOffBoard('resumed-row', { nativeId: 'native-shared' })

        emit({ type: 'session-updated', sessionId: 'resumed-row' })

        expect(cards()).toHaveLength(0)
    })

    it('ignores a row in another namespace that carries the same native id', () => {
        orchestrator.start()
        store.sessions.getOrCreateSession('other-tenant', {
            path: '/repo', host: 'box', machineId: 'box-1', flavor: 'claude', claudeSessionId: 'native-shared'
        }, null, 'tenant', undefined, undefined, undefined, 'other-tenant')
        seedOffBoard('mine', { nativeId: 'native-shared' })

        emit({ type: 'session-updated', sessionId: 'mine' })

        expect(cards()).toHaveLength(1)
    })

    it('does not adopt the session a board start is still linking', async () => {
        orchestrator.start()
        const task = makeTask()
        seedOffBoard('spawned', { nativeId: 'native-spawned' })
        let release!: () => void
        spawnImpl = async () => {
            emit({ type: 'session-added', sessionId: 'spawned' })
            await new Promise<void>((resolve) => { release = resolve })
            return { type: 'success', sessionId: 'spawned' }
        }

        const starting = orchestrator.startTask(task.id, 'default')
        await Promise.resolve()
        release()
        await starting
        emit({ type: 'session-updated', sessionId: 'spawned' })

        expect(cards().map((card) => card.id)).toEqual([task.id])
        expect(store.tasks.get(task.id)?.currentSessionId).toBe('spawned')
    })

    it('hands a session to the card whose spawn timed out on it', () => {
        orchestrator.start()
        const task = makeTask({ isolation: 'simple' })
        const started = store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user' })
        if (started.outcome !== 'started') throw new Error('run did not open')
        store.tasks.finishRun(started.run.id, { status: 'failed', error: 'spawn timed out', column: 'blocked' })

        seedOffBoard('late-agent')
        emit({ type: 'session-updated', sessionId: 'late-agent' })

        expect(cards()).toHaveLength(1)
        const claimed = store.tasks.get(task.id)
        expect(claimed?.column).toBe('running')
        expect(claimed?.currentSessionId).toBe('late-agent')
    })

    it('never sends an adopted card its prompt, even without a native id', async () => {
        const task = makeTask({ spawn: { flavor: 'claude', adoptedSessionId: 'old-row' } })

        await orchestrator.startTask(task.id, 'default')

        expect(sentMessages).toEqual([])
    })

    describe('boot sweep', () => {
        it('puts finished conversations in review', () => {
            seedOffBoard('history', { active: false, messages: ['port the parser', 'now commit it'] })
            seedOffBoard('empty', { active: false, messages: [] })

            orchestrator.start()

            const [card] = cards()
            expect(cards()).toHaveLength(1)
            expect(card?.column).toBe('review')
            expect(card?.lastRunStatus).toBe('succeeded')
            expect(card?.prompt).toBe('port the parser')
            expect(card?.currentSessionId).toBe('history')
        })

        it('adopts conversations that never had a native id', () => {
            seedOffBoard('no-native', { active: false, nativeId: null })

            orchestrator.start()

            expect(cards()).toHaveLength(1)
            expect(cards()[0]?.spawn).not.toHaveProperty('adoptedNativeSessionId')
        })

        it('does not bring back a card the operator deleted', () => {
            seedOffBoard('deleted-card-session', { active: false })
            const task = makeTask()
            store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user', sessionId: 'deleted-card-session' })
            store.tasks.delete(task.id, 'default')

            orchestrator.start()

            expect(cards()).toHaveLength(0)
        })

        it('skips a conversation some card already holds under another row', () => {
            seedOffBoard('on-card', { active: false, nativeId: 'native-same' })
            const task = makeTask()
            store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user', sessionId: 'on-card' })
            seedOffBoard('import-dup', { active: false, nativeId: 'native-same' })

            orchestrator.start()

            expect(cards().map((card) => card.id)).toEqual([task.id])
        })
    })
})

describe('column policy', () => {
    it('sends a session with pending requests to review', () => {
        // Not `running`: an agent stopped on a prompt is waiting on the
        // operator, not making progress.
        expect(columnForLiveSession({
            id: 's', namespace: 'default', active: true,
            agentState: { requests: { 'req-1': { tool: 'Bash' } } }
        })).toBe('review')
        // Still reporting `thinking`, or holding background work, does not
        // change that.
        expect(columnForLiveSession({
            id: 's', namespace: 'default', active: true, thinking: true, backgroundTaskCount: 1,
            agentState: { requests: { 'req-1': { tool: 'AskUserQuestion' } } }
        })).toBe('review')
    })

    it('keeps a thinking session in running', () => {
        const base = { id: 's', namespace: 'default', active: true, thinking: true }
        expect(columnForLiveSession({ ...base, agentState: { requests: {} } })).toBe('running')
        expect(columnForLiveSession({ ...base, agentState: null })).toBe('running')
        expect(columnForLiveSession(base)).toBe('running')
    })

    it('sends an idle session to review — the turn ended', () => {
        // `thinking` going false means the turn ended. Prose questions land
        // here too: they are indistinguishable from finishing.
        const idle = { id: 's', namespace: 'default', active: true, thinking: false }
        expect(columnForLiveSession(idle)).toBe('review')
        expect(columnForLiveSession({ ...idle, agentState: { requests: {} } })).toBe('review')
    })

    it('holds an idle session in running while background work outlives the turn', () => {
        // The visible turn ended, but the agent left something running, so
        // the task is not reviewable yet.
        const idle = { id: 's', namespace: 'default', active: true, thinking: false }
        expect(columnForLiveSession({ ...idle, backgroundTaskCount: 2 })).toBe('running')
        // ...and releases it once the last one finishes.
        expect(columnForLiveSession({ ...idle, backgroundTaskCount: 0 })).toBe('review')
    })

    it('holds only on background agents, not on processes the agent left up', () => {
        // A dev server started for the operator to look at never finishes;
        // holding on it would keep the card out of review for good.
        const idle = { id: 's', namespace: 'default', active: true, thinking: false }
        expect(columnForLiveSession({ ...idle, backgroundTaskCount: 1, backgroundAgentCount: 0 })).toBe('review')
        expect(columnForLiveSession({ ...idle, backgroundTaskCount: 3, backgroundAgentCount: 1 })).toBe('running')
        // A CLI that predates the split reports only the total: every task
        // still holds, as before.
        expect(columnForLiveSession({ ...idle, backgroundTaskCount: 1 })).toBe('running')
    })

    it('holds on a background process only when the agent declared it is waiting on it', () => {
        const idle = { id: 's', namespace: 'default', active: true, thinking: false }
        // A preview server: undeclared, so the card goes to review.
        expect(columnForLiveSession({ ...idle, backgroundTaskCount: 1, backgroundAgentCount: 0, backgroundAwaitedCount: 0 })).toBe('review')
        // A long run the agent is waiting on, next to that server.
        expect(columnForLiveSession({ ...idle, backgroundTaskCount: 2, backgroundAgentCount: 0, backgroundAwaitedCount: 1 })).toBe('running')
        // A pid the agent waits on need not show up in the snapshot at all.
        expect(columnForLiveSession({ ...idle, backgroundTaskCount: 0, backgroundAgentCount: 0, backgroundAwaitedCount: 1 })).toBe('running')
        // A prompt still wins.
        expect(columnForLiveSession({
            ...idle, backgroundAwaitedCount: 1, agentState: { requests: { r: { tool: 'Bash' } } }
        })).toBe('review')
    })

    it('holds off during the startup window, before the first token', () => {
        const idle = { id: 's', namespace: 'default', active: true, thinking: false }
        const startedAt = 1_000_000

        expect(columnForLiveSession(idle, {
            startupGraceUntil: startedAt + STARTUP_GRACE_MS,
            now: startedAt + 1_000
        })).toBe('running')

        expect(columnForLiveSession(idle, {
            startupGraceUntil: startedAt + STARTUP_GRACE_MS,
            now: startedAt + STARTUP_GRACE_MS + 1
        })).toBe('review')
    })

    it('sends a card with a pending request to review regardless of the window', () => {
        expect(columnForLiveSession(
            {
                id: 's', namespace: 'default', active: true, thinking: false,
                agentState: { requests: { 'r': {} } }
            },
            { startupGraceUntil: Number.MAX_SAFE_INTEGER }
        )).toBe('review')
    })

    it('maps end reasons onto run statuses, ignoring session replacement', () => {
        expect(runStatusForEndReason('completed')).toBe('succeeded')
        expect(runStatusForEndReason(undefined)).toBe('succeeded')
        expect(runStatusForEndReason('error')).toBe('failed')
        expect(runStatusForEndReason('terminated')).toBe('canceled')
        expect(runStatusForEndReason('handoff')).toBeNull()
        expect(runStatusForEndReason('cleared')).toBeNull()
    })

    it('routes a finished run to the column its outcome calls for', () => {
        expect(columnForFinishedRun('succeeded')).toBe('review')
        expect(columnForFinishedRun('canceled')).toBe('ready')
        // A plain failure goes back to `ready` — `blocked` is reserved for
        // faults that need the operator's attention.
        expect(columnForFinishedRun('failed')).toBe('ready')
        // `orphaned` is the session-died equivalent, so it does land in blocked.
        expect(columnForFinishedRun('orphaned')).toBe('blocked')
    })
})

describe('startTask', () => {
    it('opens a run, spawns, and links the session', async () => {
        const task = makeTask({ baseRef: 'main', worktreeName: 'parser-fix' })
        const result = await orchestrator.startTask(task.id, 'default')

        expect(result.outcome).toBe('started')
        if (result.outcome !== 'started') return

        expect(spawnCalls).toHaveLength(1)
        expect(spawnCalls[0]).toMatchObject({
            machineId: 'box-1',
            directory: '/repo',
            flavor: 'claude',
            sessionType: 'worktree',
            worktreeName: 'parser-fix'
        })

        const stored = store.tasks.get(task.id)
        expect(stored?.column).toBe('running')
        expect(stored?.currentSessionId).toBe('sess-1')
        expect(store.tasks.getRun(result.runId)?.sessionId).toBe('sess-1')
    })

    it('delivers the task prompt to the spawned session', async () => {
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')

        // Spawning alone leaves the agent idle in its worktree. This assertion
        // is the one that was missing when the board shipped unable to start
        // any actual work.
        expect(sentMessages).toEqual([{ sessionId: 'sess-1', text: task.prompt }])
    })

    it('settles a failed prompt delivery into blocked', async () => {
        sendImpl = async () => { throw new Error('session gone') }
        const task = makeTask()

        const result = await orchestrator.startTask(task.id, 'default')
        expect(result.outcome).toBe('prompt-failed')

        const stored = store.tasks.get(task.id)
        // `blocked` is the error column — this needs looking at, not re-running blindly.
        expect(stored?.column).toBe('blocked')
        expect(stored?.lastRunStatus).toBe('failed')
        expect(stored?.lastError).toBe('hapi:run.promptUndelivered|session gone')
        expect(store.tasks.getActiveRun(task.id)).toBeNull()
    })

    it('passes the pinned base ref to the runner so the worktree branches from it', async () => {
        const task = makeTask({ baseRef: 'main' })
        await orchestrator.startTask(task.id, 'default')
        expect(spawnCalls[0].worktreeBaseRef).toBe('main')
    })

    it('copies the runner-created worktree onto the card', async () => {
        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true,
            worktree: { branch: 'hapi-0821-abcd', worktreePath: '/repo-worktrees/0821-abcd' }
        })
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')

        const stored = store.tasks.get(task.id)
        expect(stored?.branch).toBe('hapi-0821-abcd')
        expect(stored?.worktreePath).toBe('/repo-worktrees/0821-abcd')
    })

    it('picks the worktree up later when the runner reports it after the spawn returns', async () => {
        const task = makeTask()
        orchestrator.start()
        await orchestrator.startTask(task.id, 'default')
        // Nothing known yet — this is the real-world ordering.
        expect(store.tasks.get(task.id)?.branch).toBeNull()

        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true,
            worktree: { branch: 'hapi-late', worktreePath: '/repo-worktrees/late' }
        })
        emit({ type: 'session-updated', sessionId: 'sess-1' })

        expect(store.tasks.get(task.id)?.branch).toBe('hapi-late')
        expect(store.tasks.get(task.id)?.worktreePath).toBe('/repo-worktrees/late')
    })

    it('follows each run onto the worktree it came up in', async () => {
        // Every run gets a fresh worktree; a card stuck on the first one would
        // leave every later one unreachable for review and teardown.
        const task = makeTask()
        orchestrator.start()
        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true,
            worktree: { branch: 'hapi-first', worktreePath: '/wt/first' }
        })
        await orchestrator.startTask(task.id, 'default')
        const firstRun = store.tasks.getActiveRun(task.id)!
        expect(store.tasks.getRun(firstRun.id)?.worktreePath).toBe('/wt/first')
        await orchestrator.cancelTask(task.id, 'default')

        seedSession('sess-2', { worktree: { branch: 'hapi-second', worktreePath: '/wt/second' } })
        spawnImpl = async () => ({ type: 'success', sessionId: 'sess-2' })
        await orchestrator.startTask(task.id, 'default')

        expect(store.tasks.get(task.id)).toMatchObject({ branch: 'hapi-second', worktreePath: '/wt/second' })
        expect(store.tasks.getRun(firstRun.id)?.worktreePath).toBe('/wt/first')
    })

    it('lets a session off the latest run only fill blanks', async () => {
        const task = makeTask()
        orchestrator.start()
        await orchestrator.startTask(task.id, 'default')
        await orchestrator.cancelTask(task.id, 'default')
        store.tasks.update(task.id, 'default', { branch: 'hapi-original', worktreePath: '/wt/original' })

        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true,
            worktree: { branch: 'hapi-other', worktreePath: '/wt/other' }
        })
        emit({ type: 'session-updated', sessionId: 'sess-1' })

        expect(store.tasks.get(task.id)?.branch).toBe('hapi-original')
    })

    it('passes simple isolation through untouched', async () => {
        const task = makeTask({ isolation: 'simple' })
        await orchestrator.startTask(task.id, 'default')
        expect(spawnCalls[0].sessionType).toBe('simple')
    })

    it('retires the session a previous run left behind', async () => {
        // A CLI outlives the hub, so after a restart the card still points at a
        // live agent. Spawning without stopping it would give one card two.
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')
        store.tasks.finishRun(store.tasks.getActiveRun(task.id)!.id, { status: 'orphaned' })
        stopCalls.length = 0

        await orchestrator.startTask(task.id, 'default')
        expect(stopCalls).toEqual([{ machineId: 'box-1', sessionId: 'sess-1' }])
    })

    it('starts anyway when the stale session cannot be stopped', async () => {
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')
        store.tasks.finishRun(store.tasks.getActiveRun(task.id)!.id, { status: 'orphaned' })

        const failing = new TaskOrchestrator({
            store,
            getSession: (id) => sessions.get(id) ?? null,
            spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
            sendMessage: async () => {},
            stopSession: async () => { throw new Error('machine offline') },
            subscribe: () => () => {},
            logger: { error: () => {} }
        })

        expect((await failing.startTask(task.id, 'default')).outcome).toBe('started')
    })

    it('does not try to stop anything on a first run', async () => {
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')
        expect(stopCalls).toHaveLength(0)
    })

    it('refuses a task with no machine, without opening a run', async () => {
        const task = makeTask({ machineId: null })
        const result = await orchestrator.startTask(task.id, 'default')

        expect(result.outcome).toBe('no-machine')
        expect(store.tasks.listRuns(task.id)).toHaveLength(0)
        expect(spawnCalls).toHaveLength(0)
    })

    it('rejects an unparseable spawn config before touching the runner', async () => {
        const task = makeTask({ spawn: { flavor: 'not-an-agent' } })
        const result = await orchestrator.startTask(task.id, 'default')

        expect(result.outcome).toBe('invalid-spawn-config')
        expect(store.tasks.listRuns(task.id)).toHaveLength(0)
        expect(spawnCalls).toHaveLength(0)
    })

    it('reports a missing task and a namespace mismatch the same way', async () => {
        const task = makeTask()
        expect((await orchestrator.startTask('nope', 'default')).outcome).toBe('task-not-found')
        expect((await orchestrator.startTask(task.id, 'other')).outcome).toBe('task-not-found')
    })

    it('refuses to start a task that is already running', async () => {
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')
        const second = await orchestrator.startTask(task.id, 'default')

        expect(second.outcome).toBe('already-running')
        expect(spawnCalls).toHaveLength(1)
        expect(store.tasks.listRuns(task.id)).toHaveLength(1)
    })

    it('settles a failed spawn into blocked', async () => {
        spawnImpl = async () => ({ type: 'error', message: 'runner offline' })
        const task = makeTask()
        const result = await orchestrator.startTask(task.id, 'default')

        expect(result.outcome).toBe('spawn-failed')
        expect(sentMessages).toHaveLength(0)
        const stored = store.tasks.get(task.id)
        expect(stored?.column).toBe('blocked')
        expect(stored?.lastRunStatus).toBe('failed')
        expect(stored?.lastError).toBe('runner offline')
        // The card is restartable, not wedged.
        expect(store.tasks.getActiveRun(task.id)).toBeNull()
    })

    it('treats a thrown spawn the same as a reported failure', async () => {
        spawnImpl = async () => { throw new Error('socket hung up') }
        const task = makeTask()
        const result = await orchestrator.startTask(task.id, 'default')

        expect(result.outcome).toBe('spawn-failed')
        expect(store.tasks.get(task.id)?.lastError).toBe('socket hung up')
        expect(store.tasks.get(task.id)?.column).toBe('blocked')
    })

    it('picks up state the session reported while the spawn was still in flight', async () => {
        // Already holding a request when the rows were linked — that parks the
        // card in review, even inside the startup window.
        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true,
            agentState: { requests: { 'req-1': { tool: 'Bash' } } }
        })
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')

        expect(store.tasks.get(task.id)?.column).toBe('review')
    })
})

describe('session events', () => {
    // `start()` runs the boot sweep before it subscribes, so it has to happen
    // before the run exists — otherwise the sweep would orphan the very run
    // the test just opened.
    async function startedTask(): Promise<StoredTask> {
        orchestrator.start()
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')
        published.length = 0
        return task
    }

    it('moves a card to review when the agent asks for something', async () => {
        // Reported: a card stuck on a permission prompt sat in running with an
        // "Answer" badge, looking busy while it was really waiting on a reply.
        const task = await startedTask()

        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true, thinking: true,
            agentState: { requests: { 'req-1': { tool: 'Edit' } } }
        })
        emit({ type: 'session-updated', sessionId: 'sess-1' })

        expect(store.tasks.get(task.id)?.column).toBe('review')
    })

    it('moves it back to running once the request is answered', async () => {
        const task = await startedTask()

        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true,
            agentState: { requests: { 'req-1': { tool: 'Edit' } } }
        })
        emit({ type: 'session-updated', sessionId: 'sess-1' })
        expect(store.tasks.get(task.id)?.column).toBe('review')
        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true, thinking: true, agentState: { requests: {} }
        })
        emit({ type: 'session-updated', sessionId: 'sess-1' })

        expect(store.tasks.get(task.id)?.column).toBe('running')
    })

    it('moves a card to review when the agent stops talking', async () => {
        // Reported bug: the agent finished its turn with a question and the card
        // stayed in `running`, so the board showed work in progress when it was
        // really waiting on a reply.
        const task = await startedTask()
        store.tasks.update(task.id, 'default', {})
        const run = store.tasks.getActiveRun(task.id)!
        // Past the startup window.
        store.tasks.setPullRequest(task.id, 'default', null)
        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true, thinking: false, agentState: { requests: {} }
        })
        // Age the run so the grace window has elapsed.
        const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        db.prepare('UPDATE task_runs SET started_at = ? WHERE id = ?').run(Date.now() - 120_000, run.id)

        emit({ type: 'session-updated', sessionId: 'sess-1' })
        expect(store.tasks.get(task.id)?.column).toBe('review')
    })

    it('holds the card in running until background work finishes, then releases it', async () => {
        // The background hold keeps the task in `running` past the end of the
        // turn, and lets it into `review` when the last one is done.
        const task = await startedTask()
        const run = store.tasks.getActiveRun(task.id)!
        const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        db.prepare('UPDATE task_runs SET started_at = ? WHERE id = ?').run(Date.now() - 120_000, run.id)

        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true, thinking: false, backgroundTaskCount: 1
        })
        emit({ type: 'session-updated', sessionId: 'sess-1' })
        expect(store.tasks.get(task.id)?.column).toBe('running')

        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true, thinking: false, backgroundTaskCount: 0
        })
        emit({ type: 'session-updated', sessionId: 'sess-1' })
        expect(store.tasks.get(task.id)?.column).toBe('review')
    })

    it('pulls a reviewed card back to running when background work reappears', async () => {
        // `pullBackParkedTask`: the turn is over and the card is parked in
        // review, then something the agent started shows up running again.
        const task = await startedTask()
        const run = store.tasks.getActiveRun(task.id)!
        const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        db.prepare('UPDATE task_runs SET started_at = ? WHERE id = ?').run(Date.now() - 120_000, run.id)
        store.tasks.move(task.id, 'default', 'review')

        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true, thinking: false, backgroundTaskCount: 1
        })
        emit({ type: 'session-updated', sessionId: 'sess-1' })

        expect(store.tasks.get(task.id)?.column).toBe('running')
    })

    it('releases the card to review when only a background process is left', async () => {
        // The agent started a dev server and ended its turn: that is the
        // moment to review, even though the server keeps running.
        const task = await startedTask()
        const run = store.tasks.getActiveRun(task.id)!
        const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        db.prepare('UPDATE task_runs SET started_at = ? WHERE id = ?').run(Date.now() - 120_000, run.id)

        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true, thinking: false,
            backgroundTaskCount: 2, backgroundAgentCount: 1
        })
        emit({ type: 'session-updated', sessionId: 'sess-1' })
        expect(store.tasks.get(task.id)?.column).toBe('running')

        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true, thinking: false,
            backgroundTaskCount: 1, backgroundAgentCount: 0
        })
        emit({ type: 'session-updated', sessionId: 'sess-1' })
        expect(store.tasks.get(task.id)?.column).toBe('review')
    })

    it('holds the card while a declared background task runs, then releases it to review', async () => {
        // The agent ended its turn on a long run it will follow up on, with a
        // preview server also up. Only the run holds; when it ends, review.
        const task = await startedTask()
        const run = store.tasks.getActiveRun(task.id)!
        const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        db.prepare('UPDATE task_runs SET started_at = ? WHERE id = ?').run(Date.now() - 120_000, run.id)

        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true, thinking: false,
            backgroundTaskCount: 2, backgroundAgentCount: 0, backgroundAwaitedCount: 1
        })
        emit({ type: 'session-updated', sessionId: 'sess-1' })
        expect(store.tasks.get(task.id)?.column).toBe('running')

        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true, thinking: false,
            backgroundTaskCount: 1, backgroundAgentCount: 0, backgroundAwaitedCount: 0
        })
        emit({ type: 'session-updated', sessionId: 'sess-1' })
        expect(store.tasks.get(task.id)?.column).toBe('review')
    })

    it('leaves a card the operator moved to done alone', async () => {
        // `review` is part of the automatic flow (a task there goes back to
        // running when work resumes), so `done` is the human end state the
        // orchestrator must never override.
        const task = await startedTask()
        store.tasks.move(task.id, 'default', 'done')

        sessions.set('sess-1', {
            id: 'sess-1', namespace: 'default', active: true,
            agentState: { requests: { 'req-1': { tool: 'Edit' } } }
        })
        emit({ type: 'session-updated', sessionId: 'sess-1' })

        expect(store.tasks.get(task.id)?.column).toBe('done')
    })

    it('does not declare a just-spawned run interrupted', async () => {
        // Regression: a session row starts inactive and only flips when the CLI
        // reports in. Without the startup guard, linking the run immediately
        // settled it as orphaned — every new task died on arrival.
        const task = makeTask()
        orchestrator.start()
        sessions.set('sess-1', { id: 'sess-1', namespace: 'default', active: false })

        await orchestrator.startTask(task.id, 'default')
        emit({ type: 'session-updated', sessionId: 'sess-1' })

        expect(store.tasks.get(task.id)?.lastRunStatus).toBe('running')
        expect(store.tasks.get(task.id)?.column).toBe('running')
    })

    it('pulls a reviewed card back to running when the agent resumes work', async () => {
        // A follow-up turn on the same session means the task is live again.
        const task = await startedTask()
        store.tasks.move(task.id, 'default', 'review')

        sessions.set('sess-1', { id: 'sess-1', namespace: 'default', active: true, thinking: true })
        emit({ type: 'session-updated', sessionId: 'sess-1' })

        expect(store.tasks.get(task.id)?.column).toBe('running')
    })

    it('sends a completed session to review', async () => {
        const task = await startedTask()
        emit({ type: 'session-ended', sessionId: 'sess-1', reason: 'completed' })

        const stored = store.tasks.get(task.id)
        expect(stored?.column).toBe('review')
        expect(stored?.lastRunStatus).toBe('succeeded')
        expect(stored?.lastError).toBeNull()
        expect(store.tasks.getActiveRun(task.id)).toBeNull()
    })

    it('sends a failed session back to ready with the reason attached', async () => {
        // Ordinary failure: restartable rather than parked in the fault
        // column.
        const task = await startedTask()
        emit({ type: 'session-ended', sessionId: 'sess-1', reason: 'error' })

        const stored = store.tasks.get(task.id)
        expect(stored?.column).toBe('ready')
        expect(stored?.lastRunStatus).toBe('failed')
        expect(stored?.lastError).toBe('hapi:run.sessionError|error')
    })

    it('ignores handoff and clear — the session is replaced, the task is not over', async () => {
        const task = await startedTask()
        emit({ type: 'session-ended', sessionId: 'sess-1', reason: 'handoff' })
        emit({ type: 'session-ended', sessionId: 'sess-1', reason: 'cleared' })

        expect(store.tasks.get(task.id)?.column).toBe('running')
        expect(store.tasks.getActiveRun(task.id)).not.toBeNull()
    })

    it('keeps the session pointer when an inactive session orphans the run', async () => {
        // Regression: settling an interrupted run used to clear
        // `current_session_id`, which is the card's only route into the chat.
        // The session row is still there — it just went quiet — so the pointer
        // has to survive, or a hub restart turns every live card into a dead
        // end with no transcript and no way to resume.
        const task = await startedTask()
        const run = store.tasks.getActiveRun(task.id)!
        const db = (store as unknown as { db: Database }).db
        db.prepare('UPDATE task_runs SET started_at = ? WHERE id = ?')
            .run(run.startedAt - STARTUP_GRACE_MS - 1, run.id)

        sessions.set('sess-1', { id: 'sess-1', namespace: 'default', active: false })
        emit({ type: 'session-updated', sessionId: 'sess-1' })

        const stored = store.tasks.get(task.id)
        expect(stored?.lastRunStatus).toBe('orphaned')
        expect(stored?.column).toBe('blocked')
        expect(stored?.currentSessionId).toBe('sess-1')
    })

    it('settles a run whose session was deleted, even though the FK already cleared the pointer', async () => {
        const task = await startedTask()

        await store.sessions.deleteSession('sess-1', 'default')
        expect(store.tasks.get(task.id)?.currentSessionId).toBeNull()
        emit({ type: 'session-removed', sessionId: 'sess-1' })

        const stored = store.tasks.get(task.id)
        expect(stored?.lastRunStatus).toBe('orphaned')
        // An interrupted run is a fault, so it lands in the error column.
        expect(stored?.column).toBe('blocked')
        expect(store.tasks.getActiveRun(task.id)).toBeNull()
    })

    it('republishes a card whose session was merged into another id', async () => {
        // A resumed agent comes back under a new session id and the old row is
        // folded into it. The store has already moved the card by the time the
        // event lands, so the run must stay open and the card must be announced
        // on its new session rather than declared orphaned.
        const task = await startedTask()
        seedSession('sess-2')
        store.tasks.reassignSession('sess-1', 'sess-2')
        await store.sessions.deleteSession('sess-1', 'default')

        emit({ type: 'session-removed', sessionId: 'sess-1', mergedInto: 'sess-2' })

        const stored = store.tasks.get(task.id)
        expect(stored?.lastRunStatus).toBe('running')
        expect(stored?.currentSessionId).toBe('sess-2')
        expect(published.map((entry) => entry.id)).toEqual([task.id])
    })

    it('ignores events for sessions no task owns', async () => {
        await startedTask()
        seedSession('sess-stray')
        emit({ type: 'session-updated', sessionId: 'sess-stray' })
        emit({ type: 'session-ended', sessionId: 'sess-stray', reason: 'completed' })
        expect(published).toHaveLength(0)
    })

    it('stops listening after stop()', async () => {
        const task = await startedTask()
        orchestrator.stop()

        emit({ type: 'session-ended', sessionId: 'sess-1', reason: 'completed' })
        expect(store.tasks.get(task.id)?.column).toBe('running')
    })
})

describe('cancelTask', () => {
    it('aborts the agent and returns the card to ready', async () => {
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')

        const result = await orchestrator.cancelTask(task.id, 'default')
        expect(result.outcome).toBe('canceled')
        expect(abortCalls).toEqual(['sess-1'])

        const stored = store.tasks.get(task.id)
        expect(stored?.column).toBe('ready')
        expect(stored?.lastRunStatus).toBe('canceled')
    })

    it('settles the run even when the abort call fails', async () => {
        abortImpl = async () => { throw new Error('runner gone') }
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')

        expect((await orchestrator.cancelTask(task.id, 'default')).outcome).toBe('canceled')
        expect(store.tasks.get(task.id)?.lastRunStatus).toBe('canceled')
    })

    it('reports a task that is not running', async () => {
        const task = makeTask()
        expect((await orchestrator.cancelTask(task.id, 'default')).outcome).toBe('not-running')
        expect((await orchestrator.cancelTask('nope', 'default')).outcome).toBe('task-not-found')
    })
})

describe('archived tasks', () => {
    it('are not started or continued', async () => {
        const task = makeTask()
        store.tasks.archive(task.id, 'default')

        expect((await orchestrator.startTask(task.id, 'default')).outcome).toBe('archived')
        expect((await orchestrator.continueTask(task.id, 'default', { origin: 'scheduled', prompt: 'again' })).outcome)
            .toBe('archived')
        expect(spawnCalls).toHaveLength(0)
        expect(store.tasks.listRuns(task.id)).toHaveLength(0)
    })
})

describe('continueTask', () => {
    /** An orchestrator that can reopen, with a hook that runs while the
     *  reopen is in flight. */
    function withReopen(duringReopen: () => Promise<void>): TaskOrchestrator {
        return new TaskOrchestrator({
            store,
            getSession: (id) => sessions.get(id) ?? null,
            spawnSession: async () => ({ type: 'success', sessionId: 'sess-2' }),
            sendMessage: async (sessionId, text) => { sentMessages.push({ sessionId, text }) },
            reopenSession: async (sessionId) => {
                await duringReopen()
                return { type: 'success', sessionId }
            },
            stopSession: async (machineId, sessionId) => {
                stopCalls.push({ machineId, sessionId })
                return 'stopped'
            },
            subscribe: () => () => {},
            reattachWindowMs: 0,
            logger: { error: () => {} }
        })
    }

    /** A task whose last run finished in `sess-1`, so there is something to continue. */
    function finishedTask(): StoredTask {
        const task = makeTask()
        store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user', sessionId: 'sess-1' })
        store.tasks.finishRun(store.tasks.getActiveRun(task.id)!.id, { status: 'succeeded', column: 'review' })
        return store.tasks.get(task.id) as StoredTask
    }

    it('stops the reopened session when a Start wins the race', async () => {
        const task = finishedTask()
        seedSession('sess-2')
        const racing = withReopen(async () => {
            store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user', sessionId: 'sess-2' })
        })

        const result = await racing.continueTask(task.id, 'default', { origin: 'scheduled', prompt: 'again' })

        expect(result.outcome).toBe('already-running')
        expect(stopCalls).toEqual([{ machineId: 'box-1', sessionId: 'sess-1' }])
        expect(sentMessages).toEqual([])
    })

    it('stops the reopened session when the task was deleted meanwhile', async () => {
        const task = finishedTask()
        const racing = withReopen(async () => {
            store.tasks.delete(task.id, 'default')
        })

        const result = await racing.continueTask(task.id, 'default', { origin: 'scheduled', prompt: 'again' })

        expect(result.outcome).toBe('task-not-found')
        expect(stopCalls).toEqual([{ machineId: 'box-1', sessionId: 'sess-1' }])
    })

    it('leaves the session alone when the winning run is in it', async () => {
        const task = finishedTask()
        const racing = withReopen(async () => {
            store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user', sessionId: 'sess-1' })
        })

        expect((await racing.continueTask(task.id, 'default', { origin: 'scheduled', prompt: 'again' })).outcome)
            .toBe('already-running')
        expect(stopCalls).toEqual([])
    })
})

describe('boot reconciliation', () => {
    /** A second hub process coming up against the same DB. */
    function reboot(overrides?: { reattachWindowMs?: number }): TaskOrchestrator {
        return new TaskOrchestrator({
            store,
            getSession: (id) => sessions.get(id) ?? null,
            spawnSession: async () => ({ type: 'error', message: 'unused' }),
            sendMessage: async () => {},
            subscribe: (listener) => {
                listeners.push(listener)
                return () => {
                    listeners = listeners.filter((entry) => entry !== listener)
                }
            },
            onTaskChanged: (changed) => published.push(changed),
            ...overrides
        })
    }

    it('sweeps stuck running rows when it starts', async () => {
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')
        expect(store.tasks.get(task.id)?.column).toBe('running')

        // A fresh hub process comes up against the same DB, with no reattach
        // window — the sweep decides everything on the spot.
        const rebooted = reboot({ reattachWindowMs: 0 })
        published.length = 0
        rebooted.start()

        const stored = store.tasks.get(task.id)
        // `ready`, not `blocked`: restarting the hub is not the task's fault.
        // `blocked` is for a session that died with the hub watching.
        expect(stored?.column).toBe('ready')
        expect(stored?.lastRunStatus).toBe('orphaned')
        expect(published.map((entry) => entry.id)).toEqual([task.id])
        rebooted.stop()
    })

    it('holds a run whose session has not reconnected yet', async () => {
        // An agent outlives the hub, so a session that has
        // not checked in a second after boot says nothing about whether its
        // agent is alive. Sweeping it here parked live work in `ready` and
        // nothing ever moved it again.
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')
        sessions.set('sess-1', { id: 'sess-1', namespace: 'default', active: false })

        const rebooted = reboot()
        rebooted.start()

        expect(store.tasks.get(task.id)?.column).toBe('running')
        expect(store.tasks.getActiveRun(task.id)).not.toBeNull()
        rebooted.stop()
    })

    it('leaves a held run alone when its session reconnects', async () => {
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')
        const rebooted = reboot()
        rebooted.start()

        // The CLI reports in inside the window and picks the run back up.
        sessions.set('sess-1', { id: 'sess-1', namespace: 'default', active: true, thinking: true })
        emit({ type: 'session-updated', sessionId: 'sess-1' })

        expect(store.tasks.get(task.id)?.column).toBe('running')
        expect(store.tasks.get(task.id)?.lastRunStatus).toBe('running')
        rebooted.stop()
    })

    it('keeps a run the sync engine still reports as active when the window closes', async () => {
        // The closing sweep asks the engine, not the `sessions` table: that
        // column is only ever written false, so a SQL-only sweep would settle
        // every healthy session the moment the window expired.
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')
        sessions.set('sess-1', { id: 'sess-1', namespace: 'default', active: true, thinking: true })

        const rebooted = reboot({ reattachWindowMs: 20 })
        rebooted.start()
        await new Promise((resolve) => setTimeout(resolve, 80))

        expect(store.tasks.get(task.id)?.lastRunStatus).toBe('running')
        expect(store.tasks.getActiveRun(task.id)).not.toBeNull()
        rebooted.stop()
    })

    it('settles a run nothing reclaimed once the window closes', async () => {
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')
        sessions.set('sess-1', { id: 'sess-1', namespace: 'default', active: false })

        const rebooted = reboot({ reattachWindowMs: 20 })
        rebooted.start()
        await new Promise((resolve) => setTimeout(resolve, 80))

        expect(store.tasks.get(task.id)?.lastRunStatus).toBe('orphaned')
        expect(store.tasks.get(task.id)?.column).toBe('ready')
        rebooted.stop()
    })

    it('sweeps a run whose session is gone without waiting out the window', async () => {
        // Nothing can reclaim a run whose session row no longer exists, so the
        // window does not apply to it.
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')
        await store.sessions.deleteSession('sess-1', 'default')

        const rebooted = reboot()
        rebooted.start()

        expect(store.tasks.get(task.id)?.column).toBe('ready')
        expect(store.tasks.get(task.id)?.lastRunStatus).toBe('orphaned')
        rebooted.stop()
    })

    it('start() is idempotent', async () => {
        orchestrator.start()
        orchestrator.start()
        expect(listeners).toHaveLength(1)
    })
})

describe('prompt delivery waits for the CLI to attach', () => {
    /** An orchestrator whose attach signal the test drives by hand. */
    function withAttach(attached: () => boolean, sent: Array<{ sessionId: string; text: string }>) {
        return new TaskOrchestrator({
            store,
            getSession: (id) => sessions.get(id) ?? null,
            spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
            sendMessage: async (sessionId, text) => { sent.push({ sessionId, text }) },
            isSessionAttached: attached,
            subscribe: () => () => {},
            reattachWindowMs: 0,
            logger: { error: () => {} }
        })
    }

    it('holds the prompt until the session attaches', async () => {
        const task = makeTask()
        const sent: Array<{ sessionId: string; text: string }> = []
        let attached = false
        const started = withAttach(() => attached, sent).startTask(task.id, 'default')

        // The spawn has resolved and the run row is open, but nothing has been
        // said to the agent yet -- an emit now would go into an empty room.
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(sent).toHaveLength(0)

        attached = true
        expect((await started).outcome).toBe('started')
        expect(sent).toEqual([{ sessionId: 'sess-1', text: task.prompt }])
    })

    it('delivers immediately when the session is already attached', async () => {
        const task = makeTask()
        const sent: Array<{ sessionId: string; text: string }> = []
        expect((await withAttach(() => true, sent).startTask(task.id, 'default')).outcome).toBe('started')
        expect(sent).toHaveLength(1)
    })

    it('delivers anyway once the ceiling passes', async () => {
        const task = makeTask()
        const sent: Array<{ sessionId: string; text: string }> = []
        const orchestratorWithTimeout = withAttach(() => false, sent)
        // Reach past the real ceiling without waiting it out.
        const realNow = Date.now
        let offset = 0
        Date.now = () => realNow() + offset
        try {
            const started = orchestratorWithTimeout.startTask(task.id, 'default')
            await new Promise((resolve) => setTimeout(resolve, 30))
            offset = PROMPT_ATTACH_TIMEOUT_MS + 1
            expect((await started).outcome).toBe('started')
        } finally {
            Date.now = realNow
        }
        // A prompt that cannot be delivered is still worth sending: the row is
        // what records what the operator asked for.
        expect(sent).toEqual([{ sessionId: 'sess-1', text: task.prompt }])
    })

    it('delivers with no wait when the harness supplies no attach signal', async () => {
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')
        expect(sentMessages).toEqual([{ sessionId: 'sess-1', text: task.prompt }])
    })
})

describe('one name for a card and its session', () => {
    beforeEach(() => {
        orchestrator.stop()
        orchestrator = new TaskOrchestrator({
            store,
            getSession: (id) => sessions.get(id) ?? null,
            spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
            sendMessage: async () => {},
            renameSession: renameStoredSession,
            subscribe: () => () => {},
            onTaskChanged: (task) => published.push(task),
            reattachWindowMs: 0
        })
    })

    it('names the session it spawns after the card', async () => {
        const task = makeTask({ title: 'Parser: stop dropping quotes' })

        await orchestrator.startTask(task.id, 'default')

        expect(sessionName('sess-1')).toBe('Parser: stop dropping quotes')
    })

    it('keeps the names in step from either side', async () => {
        const task = makeTask()
        await orchestrator.startTask(task.id, 'default')

        const renamed = store.tasks.update(task.id, 'default', { title: 'Parse it right' })!
        await orchestrator.taskRenamed(renamed)
        expect(sessionName('sess-1')).toBe('Parse it right')

        await renameStoredSession('sess-1', 'Quotes, finally')
        orchestrator.sessionRenamed('sess-1', 'Quotes, finally')
        expect(store.tasks.get(task.id)?.title).toBe('Quotes, finally')
        expect(published.at(-1)?.title).toBe('Quotes, finally')
    })

    it('renames sessions that drifted while nothing kept them in step', async () => {
        // Cards from before the board named its sessions: the session is
        // labelled by its own summary, the card by what someone called it.
        const task = makeTask({ title: 'Release notes' })
        store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user', sessionId: 'sess-1', column: 'review' })
        await renameStoredSession('sess-1', 'you are the release manager, read the log and')

        orchestrator.start()

        await Promise.resolve()
        expect(sessionName('sess-1')).toBe('Release notes')
    })
})
