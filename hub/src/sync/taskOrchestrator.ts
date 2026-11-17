import {
    AgentFlavorSchema,
    TaskSpawnConfigSchema,
    backgroundAgentCountOf,
    deriveTaskTitle,
    encodeTaskError,
    isPermissionModeAllowedForFlavor,
    type AgentFlavor,
    type PermissionMode,
    type SessionEndReason,
    type SyncEvent,
    type TaskColumn,
    type TaskRunStatus,
    type TaskSpawnConfig
} from '@hapi/protocol'
import type { Store, StoredTask } from '../store'

/**
 * Task orchestration: turns session signals into column moves.
 *
 * The division of labour, top to bottom:
 *   - `store.tasks`  owns rows, `seq` bumps, and run atomicity.
 *   - this class     owns *policy* - which column a task belongs in, when a
 *                    run is over, and what to do about a hub restart.
 *   - the wiring     owns transport - spawning through the RPC gateway and
 *                    republishing task changes over SSE.
 *
 * It deliberately depends on narrow function-shaped collaborators rather than
 * on `SyncEngine` itself: the engine is a 4k-line object with a 16-positional
 * -argument spawn method, and a policy layer that imports it becomes untestable
 * by construction.
 *
 * HAPI wraps its agents rather than scraping their TUI, so the signals here are
 * already structured - `agentState.requests` is the permission/question queue,
 * `session-ended` carries a typed reason.
 */

/** The subset of a session this layer reads. */
export type OrchestratorSession = {
    id: string
    namespace: string
    active: boolean
    /** CLI-reported "a turn is in flight". False means the agent has stopped. */
    thinking?: boolean
    agentState?: { requests?: Record<string, unknown> | null } | null
    /** Work the agent kicked off and left running after its turn ended
     *  (backgrounded commands, subagents). */
    backgroundTaskCount?: number
    /** The subagent / workflow part of it. Read through
     *  `backgroundAgentCountOf`. */
    backgroundAgentCount?: number
    /** Background tasks the agent declared it is waiting on (hapi
     *  `await_background_task`). Hold like background agents do. */
    backgroundAwaitedCount?: number
    /** Written by the runner once it has created the task's worktree. Arrives
     *  asynchronously — the spawn call can return before it is set. */
    worktree?: { branch?: string; worktreePath?: string; basePath?: string } | null
    /** The mode the operator chose for this session, carried onto a task
     *  adopted from it so Start resumes the way the conversation ran. */
    permissionMode?: string
}

export type SpawnTaskSessionInput = {
    machineId: string
    directory: string
    flavor: AgentFlavor
    model?: string
    effort?: string
    modelReasoningEffort?: string
    permissionMode?: string
    yolo?: boolean
    serviceTier?: string
    collaborationMode?: string
    copilotAgentMode?: string
    sessionType: 'simple' | 'worktree'
    worktreeName?: string
    /** Commit-ish the worktree branch starts from. Without it git branches from
     *  whatever the primary checkout happens to be on. */
    worktreeBaseRef?: string
    /** The agent's own session id to continue, for an adopted task. Becomes
     *  `claude --resume <id>` in the runner's argv. */
    resumeSessionId?: string
}

export type SpawnTaskSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string }

export type TaskOrchestratorDeps = {
    store: Store
    getSession: (sessionId: string) => OrchestratorSession | null | undefined
    spawnSession: (input: SpawnTaskSessionInput) => Promise<SpawnTaskSessionResult>
    /**
     * Deliver the task's prompt to its freshly spawned session.
     *
     * Spawning only starts an agent; it does not tell it what to do. Without
     * this the agent comes up in the worktree and sits idle forever, which is
     * exactly what a task looks like when it silently does nothing.
     */
    sendMessage: (sessionId: string, text: string) => Promise<void>
    /**
     * Bring an ended session back up where it ran (same row, same worktree,
     * the agent's own conversation resumed). Optional: without it a task
     * cannot continue its last conversation and starts fresh instead.
     */
    reopenSession?: (sessionId: string, namespace: string) => Promise<SpawnTaskSessionResult>
    /** Ask the agent to stop. Optional so a headless test harness can omit it. */
    abortSession?: (sessionId: string) => Promise<void>
    /** Set a session's name. Optional so a headless test harness can omit it;
     *  see `nameSession` for why the board names its sessions. */
    renameSession?: (sessionId: string, name: string) => Promise<void>
    /**
     * End a session's process on its machine.
     *
     * Needed because a CLI outlives the hub: after a hub restart the boot sweep
     * marks its run `orphaned`, but the agent itself is still sitting there. A
     * re-run that only spawned would leave the old session running alongside
     * the new one, and the task would quietly own two.
     */
    stopSession?: (
        machineId: string,
        sessionId: string
    ) => Promise<'stopped' | 'already_gone' | 'still_alive' | undefined | unknown>
    /**
     * Whether the spawned session's CLI socket has attached yet.
     *
     * The prompt is delivered by emitting into that session's socket room, and
     * an emit into an empty room is simply dropped -- the row is stored but
     * nothing replays it. Meanwhile the spawn RPC resolves as soon as the
     * runner has *reported* the session id, which happens before the CLI
     * finishes connecting. The gap is tens of milliseconds and it decides
     * whether a task ever hears what it was asked to do.
     *
     * Optional: a headless harness with no socket server omits it and delivers
     * immediately, which is what its fake `sendMessage` expects anyway.
     */
    isSessionAttached?: (sessionId: string) => boolean
    subscribe: (listener: (event: SyncEvent) => void) => () => void
    /** Called for every task row this layer changes (the hub republishes it
     *  over SSE). */
    onTaskChanged?: (task: StoredTask) => void
    /** Override `REATTACH_WINDOW_MS`. Tests pass 0 to sweep synchronously; the
     *  hub leaves it unset. */
    reattachWindowMs?: number
    logger?: { error: (message: string, error?: unknown) => void }
}

// --- Policy (pure) ----------------------------------------------------

/**
 * How long after a run opens an idle session is still treated as starting up.
 *
 * Between spawning and the agent's first token there is a gap where `thinking`
 * is false but nothing is waiting on anyone. Without this the task would flash
 * through `blocked` on every start.
 */
export const STARTUP_GRACE_MS = 30_000

/**
 * How long after the hub boots a still-running run is given to be reclaimed by
 * a reconnecting agent before it is declared orphaned.
 *
 * The hub cannot ask at boot whether a run's agent is still alive: an agent is
 * a separate process that reconnects over the socket on its own schedule, so
 * at the instant the hub comes up *every* session looks inactive. Waiting is
 * the same question, asked over time instead of at once. Only what does not
 * reconnect in time becomes orphaned.
 *
 * Runs whose session is provably gone are not held for this window — see
 * `sessionGoneOnly`. Only the ambiguous ones wait it out.
 */
export const REATTACH_WINDOW_MS = 30_000

/**
 * How long a spawn is given to attach its CLI socket before the prompt goes out
 * regardless.
 *
 * Attaching normally takes tens of milliseconds, so this is a ceiling for a
 * machine under load rather than an expected wait. On expiry the prompt is sent
 * anyway: the send is what records the operator's intent, and a dropped emit is
 * no worse than the refusal would have been.
 */
export const PROMPT_ATTACH_TIMEOUT_MS = 10_000
const PROMPT_ATTACH_POLL_MS = 25

/**
 * Which column a task with a live session belongs in.
 *
 *  - `running` — the agent is working: mid-turn, or holding background work.
 *  - `review` — the ball is in the operator's court. Either the turn ended
 *    (`thinking` went false), or the agent is **stopped on a permission
 *    prompt or a question** it raised.
 *  - `blocked` — reserved for **errors** (API failure, dead session,
 *    undeliverable prompt); never used for "waiting on you".
 *
 * A task waiting on the operator goes to `review` rather than staying in
 * `running` with a marker: `running` would read as work in progress when
 * nothing is progressing. It still carries the marker, and once the request
 * is answered the agent resumes thinking and the task goes back to `running`
 * on its own.
 *
 * An agent that ends its turn with a plain-prose question ("which of these did
 * you mean?") lands in `review` too, because it is indistinguishable from
 * finishing — no request is raised, it simply stops.
 *
 * The last rule is the background hold. A turn can end while work the agent
 * started is still going: such a task stays in `running` rather than being
 * called reviewable, is released to `review` when the last one finishes, and
 * is pulled back out of `review` if background work reappears. Both
 * directions fall out of `backgroundAgentCount` here, because every change to
 * it republishes the session and re-runs this.
 *
 * Only background *agents* hold: Task-tool subagents and workflows. A
 * backgrounded shell does not: the usual one still
 * running after the turn is a dev server the agent started so you could look
 * at it, and it never finishes — holding on it kept those tasks in `running`
 * with nobody told there was something to review. A shell that does finish
 * wakes the agent, and `thinking` brings the task back on its own.
 *
 * Except when the agent says otherwise: one that ends its turn waiting on a
 * shell whose result it needs (a long run it will follow up on) declares it
 * through the hapi `await_background_task` tool, and `backgroundAwaitedCount`
 * holds the task like an agent would. The CLI drops a declaration when the
 * task or process is gone or the agent starts its next turn, and the count
 * resets with the session, so an undeclared server still never holds.
 */
export function columnForLiveSession(
    session: OrchestratorSession,
    options?: { startupGraceUntil?: number; now?: number }
): TaskColumn {
    // Checked first: an agent stopped on a prompt usually still reports
    // `thinking`, and background work does not make it any less stuck.
    if (hasPendingRequests(session)) return 'review'
    if (session.thinking) return 'running'
    if (backgroundAgentCountOf(session) > 0) return 'running'
    if ((session.backgroundAwaitedCount ?? 0) > 0) return 'running'

    // Between spawn and the first token there is no turn to have ended.
    const now = options?.now ?? Date.now()
    if (options?.startupGraceUntil !== undefined && now < options.startupGraceUntil) {
        return 'running'
    }

    return 'review'
}

/** Whether the agent is holding something for the operator to answer. Sends
 *  the task to `review`; the web side reads the same requests for its marker. */
export function hasPendingRequests(session: OrchestratorSession): boolean {
    const requests = session.agentState?.requests
    return requests !== null && requests !== undefined && Object.keys(requests).length > 0
}

/**
 * Map a session's end reason onto a run status.
 *
 * `handoff` and `cleared` return null: the session is being replaced (local to
 * remote, or `/clear` spawning a successor), but the *task* is not over. Ending
 * the run there would bounce a task into review mid-flight.
 *
 * A missing reason is treated as a clean finish - that is what an agent exiting
 * normally without an explicit reason means.
 */
export function runStatusForEndReason(reason: SessionEndReason | undefined): TaskRunStatus | null {
    switch (reason) {
        case 'error':
            return 'failed'
        case 'terminated':
            return 'canceled'
        case 'handoff':
        case 'cleared':
            return null
        case 'completed':
        case undefined:
            return 'succeeded'
        default:
            return 'succeeded'
    }
}

/**
 * Where a finished run leaves its task (the mapping follows agetor's design):
 *
 *   succeeded  -> review
 *   canceled   -> ready
 *   orphaned   -> blocked   (the agent went away mid-run)
 *   failed     -> ready     (an ordinary failure is just something to run again)
 *
 * `blocked` is kept for faults that need the operator's attention. The call
 * sites add one more: a run that never started (spawn refused, prompt
 * undeliverable) is settled directly into `blocked`, because routing it to
 * `ready` would invite pressing Start against an unreachable runner over and
 * over.
 */
export function columnForFinishedRun(status: TaskRunStatus): TaskColumn {
    if (status === 'succeeded') return 'review'
    if (status === 'orphaned') return 'blocked'
    return 'ready'
}

/**
 * Wrap a task row as the SSE event clients listen for. `data` rides as
 * `unknown` on the wire (see the schema comment on `task-updated`); the
 * runtime shape is `Task`, and `StoredTask` already matches it field for field.
 */
export function toTaskUpdatedEvent(task: StoredTask): SyncEvent {
    return {
        type: 'task-updated',
        taskId: task.id,
        namespace: task.namespace,
        data: task
    }
}

// --- Orchestrator -----------------------------------------------------

export type StartTaskResult =
    | { outcome: 'started'; task: StoredTask; runId: string; sessionId: string }
    | { outcome: 'task-not-found' }
    | { outcome: 'already-running'; task: StoredTask }
    /** Archived tasks are not run; unarchive first. */
    | { outcome: 'archived'; task: StoredTask }
    | { outcome: 'no-machine'; task: StoredTask }
    | { outcome: 'invalid-spawn-config'; task: StoredTask; message: string }
    | { outcome: 'spawn-failed'; task: StoredTask; message: string }
    | { outcome: 'prompt-failed'; task: StoredTask; message: string }

/**
 * What became of the session a task was pointing at.
 *
 * `still-alive` is the one that matters: the runner answered, and its answer
 * was that it has no handle on that session, so nothing was signalled. It
 * happens whenever the runner restarted after spawning the agent -- exactly the
 * situation that produces an `orphaned` run in the first place.
 */
export type RetireSessionOutcome =
    | 'stopped'
    | 'already-gone'
    | 'still-alive'
    | 'none'
    | 'failed'

export type ContinueTaskResult =
    | { outcome: 'started'; task: StoredTask; runId: string; sessionId: string }
    | { outcome: 'task-not-found' }
    | { outcome: 'already-running'; task: StoredTask }
    | { outcome: 'archived'; task: StoredTask }
    /** Nothing to continue, or it could not be reopened; start fresh instead. */
    | { outcome: 'unavailable'; message: string }
    | { outcome: 'prompt-failed'; task: StoredTask; message: string }

export type CancelTaskResult =
    | { outcome: 'canceled'; task: StoredTask }
    | { outcome: 'task-not-found' }
    | { outcome: 'not-running'; task: StoredTask }

/**
 * How recently a task's spawn must have failed for a session showing up in its
 * directory to be handed to it. Covers a spawn RPC that timed out on a slow
 * machine; much older than this and the session is someone else's.
 */
const FAILED_SPAWN_CLAIM_WINDOW_MS = 15 * 60_000

/**
 * Why a session cannot become a task.
 *  - `not-resumable`: only checked with `requireResumable` — the session is not
 *    a Claude or Codex conversation with a native id to resume.
 *  - `machine-not-allowed`: the caller's `allowMachine` refused its machine.
 */
export type AdoptRefusalReason =
    | 'no-workdir'
    | 'no-machine'
    | 'unknown-flavor'
    | 'assistant'
    | 'not-resumable'
    | 'machine-not-allowed'

export type AdoptSessionResult =
    | { outcome: 'adopted'; task: StoredTask }
    | { outcome: 'already-on-board'; task: StoredTask | null }
    | { outcome: 'not-found' }
    | { outcome: 'not-adoptable'; reason: AdoptRefusalReason; flavor?: string }

type AdoptableMetadata = {
    /** `assistant`: a workspace user's task assistant, never a task. */
    role?: string
    flavor?: string
    path?: string
    machineId?: string
    worktreeBasePath?: string
    name?: string
    summary?: string
    claudeSessionId?: string
    codexSessionId?: string
}

function readAdoptableMetadata(value: unknown): AdoptableMetadata {
    const metadata = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    const text = (field: unknown): string | undefined =>
        typeof field === 'string' && field.trim() ? field : undefined
    const worktree = metadata.worktree as { basePath?: unknown } | undefined
    const summary = metadata.summary as { text?: unknown } | undefined
    return {
        role: text(metadata.role),
        flavor: text(metadata.flavor),
        path: text(metadata.path),
        machineId: text(metadata.machineId),
        worktreeBasePath: text(worktree?.basePath),
        name: text(metadata.name),
        summary: text(summary?.text),
        claudeSessionId: text(metadata.claudeSessionId),
        codexSessionId: text(metadata.codexSessionId)
    }
}

/**
 * The first thing a human typed in a session, for labelling an adopted task.
 *
 * Reads the transcript rather than the session summary: the summary tracks the
 * latest exchange, and on a finished conversation that is whatever was asked
 * last — an instruction already carried out, which reads on the task as a
 * to-do that will never be done.
 */
function firstUserText(store: Store, sessionId: string): string | null {
    for (const message of store.messages.getAllMessages(sessionId)) {
        const content = message.content as { role?: unknown; content?: { type?: unknown; text?: unknown } } | null
        if (!content || content.role !== 'user') continue
        const body = content.content
        if (body?.type !== 'text' || typeof body.text !== 'string') continue
        const text = body.text.trim()
        if (text) return text
    }
    return null
}

export class TaskOrchestrator {
    private readonly deps: TaskOrchestratorDeps
    private unsubscribe: (() => void) | null = null
    /** When the reattach window closes; undefined once it has. */
    private reattachWindowUntil: number | undefined
    private reattachTimer: ReturnType<typeof setTimeout> | null = null
    /** Task spawns between opening their run and linking the session. */
    private spawnsInFlight = 0
    /** Sessions known to belong to a task, so the per-event adoption check stops
     *  asking the store once the answer can no longer change. */
    private readonly boardSessionIds = new Set<string>()

    constructor(deps: TaskOrchestratorDeps) {
        this.deps = deps
    }

    /**
     * Sweep what is provably dead, give the rest a chance to come back, then
     * start listening.
     *
     * The old version of this swept everything at once, and it was wrong in a
     * way that only showed up in practice: an agent outlives the hub (it is
     * spawned detached — `cli/src/runner/run.ts`, "Sessions stay alive when
     * runner stops"), so a hub restart finds live agents whose sessions have
     * simply not reconnected yet. Declaring all of them orphaned parked their
     * tasks in `ready` while the agents carried on working, and nothing ever
     * moved those tasks again — `syncColumnFromSession` does not touch `ready`.
     *
     * So the sweep now splits by whether the run can still be claimed:
     *  - session row gone, or never linked — swept immediately, nothing can
     *    reclaim it
     *  - session row present but inactive — held for `REATTACH_WINDOW_MS`,
     *    which is the reconnecting CLI's chance to prove the run is alive
     */
    start(): void {
        if (this.unsubscribe) return

        void this.nameMisnamedSessions().catch((error) => {
            this.logError('Failed to catch up on session names', error)
        })

        const window = this.deps.reattachWindowMs ?? REATTACH_WINDOW_MS
        if (window <= 0) {
            // No window at all: one sweep, everything settled now.
            this.reconcileOrphans()
            this.adoptOffBoardSessions()
        } else {
            this.reconcileOrphans({ sessionGoneOnly: true })
            this.reattachWindowUntil = Date.now() + window
            // `unref` where available: a pending sweep must not hold a test
            // runner or a shutting-down hub open for half a minute.
            this.reattachTimer = setTimeout(() => {
                this.reattachTimer = null
                this.reattachWindowUntil = undefined
                try {
                    this.sweepUnreclaimedRuns()
                } catch (error) {
                    this.logError('Failed to sweep unreclaimed runs', error)
                }
                // After the window, not before: whether an adopted task lands
                // in `running` or `review` depends on which agents reconnected.
                try {
                    this.adoptOffBoardSessions()
                } catch (error) {
                    this.logError('Failed to adopt off-board sessions', error)
                }
            }, window)
            this.reattachTimer.unref?.()
        }

        this.unsubscribe = this.deps.subscribe((event) => {
            try {
                this.handleEvent(event)
            } catch (error) {
                this.logError('Failed to handle sync event', error)
            }
        })
    }

    stop(): void {
        this.unsubscribe?.()
        this.unsubscribe = null
        if (this.reattachTimer) {
            clearTimeout(this.reattachTimer)
            this.reattachTimer = null
        }
        this.reattachWindowUntil = undefined
    }

    /** Whether a run that has not reported in yet still deserves the benefit of
     *  the doubt. Open only in the first `REATTACH_WINDOW_MS` after boot. */
    private withinReattachWindow(now: number): boolean {
        return this.reattachWindowUntil !== undefined && now < this.reattachWindowUntil
    }

    /**
     * Settle the runs that never got reclaimed once the reattach window closed.
     *
     * This cannot go through the SQL sweep, and the reason is worth stating:
     * `sessions.active` is only ever written *false* — on session-end, and when
     * a keep-alive expires. A live session's `active = true` is set on the sync
     * engine's in-memory copy and never written back to the row. So every row
     * in that table reads `active = 0`, and any sweep keyed on it declares
     * healthy sessions dead. (An earlier version of the reattach window did
     * exactly that, and only postponed the mistake by 30 seconds.)
     *
     * The engine's own view is the one that knows, so ask it per run: whatever
     * it still reports as active is alive and keeps its run.
     */
    private sweepUnreclaimedRuns(): void {
        const store = this.deps.store
        const unreclaimed = store.tasks.listRunningRuns()
            .filter((run) => {
                if (!run.sessionId) return true
                return this.deps.getSession(run.sessionId)?.active !== true
            })
            .map((run) => run.runId)
        if (unreclaimed.length === 0) return
        this.reconcileOrphans({ runIds: unreclaimed })
    }

    /**
     * Flip stuck `running` rows to `orphaned` and park their tasks in `ready`.
     *
     * `ready`, not `blocked`: there are two ways a run can be orphaned, and
     * only one is a fault worth flagging.
     *
     *   - the *hub* restarted underneath a live run (this sweep)
     *   - the *agent's session* died while the hub watched (that path settles
     *     through `columnForFinishedRun('orphaned')`, which is `blocked`)
     *
     * Restarting the hub is something the operator did and says nothing about
     * the task, which is simply ready to go again. Routing it to `blocked` (an
     * earlier version did) meant every hub restart during development buried
     * every task in the error column.
     */
    reconcileOrphans(
        options?: { machineId?: string; namespace?: string; sessionGoneOnly?: boolean; runIds?: readonly string[] }
    ): string[] {
        const result = this.deps.store.tasks.reconcileOrphanedRuns(options)
        for (const taskId of result.taskIds) {
            this.publishTask(this.deps.store.tasks.get(taskId))
        }
        return result.taskIds
    }

    async startTask(
        taskId: string,
        namespace: string,
        options?: {
            origin?: 'user' | 'followup' | 'reconcile' | 'scheduled'
            /** Delivered instead of `task.prompt` (a scheduled run wraps it). */
            prompt?: string
        }
    ): Promise<StartTaskResult> {
        const store = this.deps.store
        const task = store.tasks.getByNamespace(taskId, namespace)
        if (!task) return { outcome: 'task-not-found' }
        if (task.archivedAt !== null) return { outcome: 'archived', task }
        if (store.tasks.getActiveRun(task.id)) return { outcome: 'already-running', task }
        if (!task.machineId) return { outcome: 'no-machine', task }

        const parsedSpawn = TaskSpawnConfigSchema.safeParse(task.spawn)
        if (!parsedSpawn.success) {
            return {
                outcome: 'invalid-spawn-config',
                task,
                message: parsedSpawn.error.issues.map((issue) => issue.message).join('; ')
            }
        }

        // A previous run may have left a session behind — most often after a hub
        // restart, where the sweep settles the run but cannot reach the agent.
        // Retiring it here keeps one task to one live session.
        await this.retireSession(task)

        // The run row opens *before* the spawn call so a task never sits in
        // `ready` while an agent is already coming up. The `already-running`
        // guard inside `startRun` is what makes a double click safe.
        const started = store.tasks.startRun({
            taskId: task.id,
            namespace,
            origin: options?.origin ?? 'user'
        })
        if (started.outcome === 'task-not-found') return { outcome: 'task-not-found' }
        if (started.outcome === 'already-running') return { outcome: 'already-running', task }

        this.publishTask(started.task)

        let spawned: SpawnTaskSessionResult
        // Held until the session is linked: in between, the new session is on
        // no task yet and would otherwise be adopted onto a second one.
        this.spawnsInFlight += 1
        try {
            spawned = await this.deps.spawnSession(this.toSpawnInput(task, parsedSpawn.data))
        } catch (error) {
            spawned = { type: 'error', message: error instanceof Error ? error.message : String(error) }
        }

        if (spawned.type === 'error') {
            this.spawnsInFlight -= 1
            const settled = store.tasks.finishRun(started.run.id, {
                status: 'failed',
                error: spawned.message,
                // Never started — see the note on columnForFinishedRun.
                column: 'blocked'
            })
            if (settled.outcome === 'finished') {
                this.publishTask(settled.task)
            }
            return { outcome: 'spawn-failed', task, message: spawned.message }
        }

        store.tasks.attachRunSession(started.run.id, spawned.sessionId)
        this.spawnsInFlight -= 1

        // Spawning starts an agent; it does not give it the task. Deliver the
        // prompt now, and treat a failure here as a failed run - an agent
        // sitting in a worktree with no instructions is not a running task.
        //
        // Wait for the CLI to attach first. Delivery is a socket-room emit with
        // no replay behind it, so sending before the room has an occupant loses
        // the prompt outright -- the task then sits in `running` with an agent
        // that was never told anything, until someone types into it by hand and
        // the agent invents its own errand from whatever is lying around the
        // worktree. Observed live: one task lost its prompt by 49ms while
        // another two minutes later won by 2ms.
        await this.waitForSessionAttached(spawned.sessionId)

        // Re-read the title: the task may have been renamed mid-spawn.
        await this.nameSession(spawned.sessionId, store.tasks.get(task.id)?.title ?? task.title)

        // An adopted task's agent was resumed into a conversation that already
        // has its own history. `task.prompt` is only that conversation's
        // summary, kept as the task's description — delivering it would inject
        // a line nobody typed.
        if (!parsedSpawn.data.adoptedNativeSessionId && !parsedSpawn.data.adoptedSessionId) {
            try {
                await this.deps.sendMessage(spawned.sessionId, options?.prompt ?? task.prompt)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                const settled = store.tasks.finishRun(started.run.id, {
                    status: 'failed',
                    error: encodeTaskError('run.promptUndelivered', message),
                    // Never started — see the note on columnForFinishedRun.
                    column: 'blocked'
                })
                if (settled.outcome === 'finished') {
                    this.publishTask(settled.task)
                }
                return { outcome: 'prompt-failed', task, message }
            }
        }

        // The runner records the worktree it created on the session; copy it
        // onto the task. It may not have landed yet, in which case the
        // session-updated handler picks it up later.
        this.syncWorktreeFromSession(spawned.sessionId)

        // The session may already have reported state while the spawn call was
        // still in flight - those events found no task and were dropped. Sync
        // once now that the link exists.
        const synced = this.syncColumnFromSession(spawned.sessionId)
        const current = synced ?? store.tasks.get(task.id)
        if (!synced) {
            this.publishTask(current)
        }

        return {
            outcome: 'started',
            task: current ?? started.task,
            runId: started.run.id,
            sessionId: spawned.sessionId
        }
    }

    /**
     * Run a task again inside its last conversation.
     *
     * The session is reopened before a run is opened: if it cannot come back
     * (transcript gone, machine changed) the caller starts fresh and no failed
     * run is left behind. The run reuses the session's worktree, so it is
     * recorded on the run up front — the runner does not report a worktree
     * for a session it resumed rather than created.
     */
    async continueTask(
        taskId: string,
        namespace: string,
        options: { origin: 'scheduled'; prompt: string }
    ): Promise<ContinueTaskResult> {
        const store = this.deps.store
        const task = store.tasks.getByNamespace(taskId, namespace)
        if (!task) return { outcome: 'task-not-found' }
        if (task.archivedAt !== null) return { outcome: 'archived', task }
        if (store.tasks.getActiveRun(task.id)) return { outcome: 'already-running', task }
        if (!task.currentSessionId) return { outcome: 'unavailable', message: 'no previous session' }
        if (!this.deps.reopenSession) return { outcome: 'unavailable', message: 'reopen not supported' }
        const [previousRun] = store.tasks.listRuns(task.id, 1)

        let reopened: SpawnTaskSessionResult
        this.spawnsInFlight += 1
        try {
            reopened = await this.deps.reopenSession(task.currentSessionId, namespace)
        } catch (error) {
            reopened = { type: 'error', message: error instanceof Error ? error.message : String(error) }
        } finally {
            this.spawnsInFlight -= 1
        }
        if (reopened.type === 'error') return { outcome: 'unavailable', message: reopened.message }

        const started = store.tasks.startRun({
            taskId: task.id,
            namespace,
            origin: options.origin,
            sessionId: reopened.sessionId,
            branch: previousRun?.branch ?? task.branch,
            worktreePath: previousRun?.worktreePath ?? task.worktreePath
        })
        if (started.outcome !== 'started') {
            // A Start or a delete landed while the session was coming back.
            // The agent just reopened belongs to no run, so stop it — unless
            // the run that won is in that very session.
            if (store.tasks.getActiveRun(task.id)?.sessionId !== reopened.sessionId) {
                await this.retireSession({ ...task, currentSessionId: reopened.sessionId })
            }
            return started.outcome === 'task-not-found'
                ? { outcome: 'task-not-found' }
                : { outcome: 'already-running', task }
        }
        this.boardSessionIds.add(reopened.sessionId)
        this.publishTask(started.task)

        await this.waitForSessionAttached(reopened.sessionId)
        await this.nameSession(reopened.sessionId, store.tasks.get(task.id)?.title ?? task.title)
        try {
            await this.deps.sendMessage(reopened.sessionId, options.prompt)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const settled = store.tasks.finishRun(started.run.id, {
                status: 'failed',
                error: encodeTaskError('run.promptUndelivered', message),
                column: 'blocked'
            })
            if (settled.outcome === 'finished') this.publishTask(settled.task)
            return { outcome: 'prompt-failed', task, message }
        }

        const synced = this.syncColumnFromSession(reopened.sessionId)
        const current = synced ?? store.tasks.get(task.id)
        if (!synced) this.publishTask(current)
        return { outcome: 'started', task: current ?? started.task, runId: started.run.id, sessionId: reopened.sessionId }
    }

    /**
     * Copy the runner-created worktree onto the run and the task.
     *
     * The task follows its latest run. Each run spawns its own worktree — the
     * runner never reuses a path or branch that already exists — so a task
     * that kept pointing at the first one would leave every later one
     * unreachable: `Open PR` and teardown both key off `task.branch` /
     * `task.worktreePath`. A session that is not the latest run's (a finished
     * task the operator is still chatting in) only fills blanks.
     */
    private syncWorktreeFromSession(sessionId: string): StoredTask | null {
        const store = this.deps.store
        const resolved = this.resolveTaskForSession(sessionId)
        if (!resolved) return null

        const { task, runId } = resolved
        const worktree = this.deps.getSession(sessionId)?.worktree
        if (!worktree?.branch && !worktree?.worktreePath) return task

        if (runId) {
            store.tasks.setRunWorktree(runId, { branch: worktree.branch, worktreePath: worktree.worktreePath })
        }

        const isLatestRun = runId !== null && task.lastRunId === runId
        const patch: { branch?: string; worktreePath?: string } = {}
        if (worktree.branch && (isLatestRun ? task.branch !== worktree.branch : !task.branch)) {
            patch.branch = worktree.branch
        }
        if (worktree.worktreePath && (isLatestRun ? task.worktreePath !== worktree.worktreePath : !task.worktreePath)) {
            patch.worktreePath = worktree.worktreePath
        }
        if (Object.keys(patch).length === 0) return task

        const updated = store.tasks.update(task.id, task.namespace, patch)
        this.publishTask(updated)
        return updated
    }

    /**
     * Block until this session's CLI socket is in its room, or the ceiling.
     *
     * Polled rather than event-driven on purpose: the attach is a socket
     * lifecycle fact, not something the sync event stream reports, and the
     * window being waited on is normally a few dozen milliseconds.
     */
    private async waitForSessionAttached(sessionId: string): Promise<boolean> {
        const isAttached = this.deps.isSessionAttached
        if (!isAttached) return true

        const deadline = Date.now() + PROMPT_ATTACH_TIMEOUT_MS
        while (!isAttached(sessionId)) {
            if (Date.now() >= deadline) {
                this.logError(
                    `Session ${sessionId} never attached within ${PROMPT_ATTACH_TIMEOUT_MS}ms; `
                    + 'delivering the prompt anyway'
                )
                return false
            }
            await new Promise((resolve) => setTimeout(resolve, PROMPT_ATTACH_POLL_MS))
        }
        return true
    }

    async cancelTask(taskId: string, namespace: string): Promise<CancelTaskResult> {
        const store = this.deps.store
        const task = store.tasks.getByNamespace(taskId, namespace)
        if (!task) return { outcome: 'task-not-found' }

        const active = store.tasks.getActiveRun(task.id)
        if (!active) return { outcome: 'not-running', task }

        // Best-effort: the agent may already be gone. The run is settled either
        // way, otherwise a failed abort leaves an uncancellable task.
        if (active.sessionId && this.deps.abortSession) {
            try {
                await this.deps.abortSession(active.sessionId)
            } catch (error) {
                this.logError(`Failed to abort session ${active.sessionId}`, error)
            }
        }

        const settled = store.tasks.finishRun(active.id, {
            status: 'canceled',
            column: columnForFinishedRun('canceled')
        })
        if (settled.outcome !== 'finished') {
            return { outcome: 'not-running', task }
        }

        this.publishTask(settled.task)
        return { outcome: 'canceled', task: settled.task ?? task }
    }

    /**
     * Stop the agent session a task still points at.
     *
     * Best-effort by design, and the caller is told which it was: the agent may
     * already be gone, or its machine may be unreachable, and neither is a
     * reason to fail the thing that asked. Two callers want this and want it
     * for the same reason -- a session outliving the run that opened it. A
     * restart is the usual way that happens: the sweep settles the run but
     * cannot reach the agent, leaving a live process no run row admits to.
     * `startTask` retires it so one task owns one session; archiving and
     * deleting retire it because the task is about to be hidden or gone, and
     * then nothing in the UI can reach that session again.
     */
    async retireSession(task: StoredTask): Promise<RetireSessionOutcome> {
        if (!task.currentSessionId || !task.machineId || !this.deps.stopSession) {
            return 'none'
        }
        try {
            const status = await this.deps.stopSession(task.machineId, task.currentSessionId)
            // The runner answers with what it managed to do, and `still_alive`
            // is a refusal wearing a 200: it means the runner has no handle on
            // that session -- a restart drops the ones it spawned -- so nothing
            // was signalled and the agent is, as it says, still alive. Calling
            // that 'stopped' would be the worst kind of wrong here: the task
            // disappears, and the process it promised to end keeps running with
            // nothing left pointing at it.
            if (status === 'still_alive') {
                // The runner also says `still_alive` for any session it simply
                // does not know -- after a runner restart that is every session
                // older than the restart, including ones whose agent exited
                // weeks ago. Its answer alone cannot tell those apart from a
                // real orphan, but the hub can: a live agent keeps its socket
                // to the hub, so a session the hub holds as inactive has nobody
                // behind it. Warning about those told the operator to go kill a
                // process that did not exist.
                if (this.deps.getSession(task.currentSessionId)?.active !== true) {
                    return 'already-gone'
                }
                this.logError(
                    `Runner could not stop session ${task.currentSessionId}: no handle on it`
                )
                return 'still-alive'
            }
            if (status === 'already_gone') return 'already-gone'
            return 'stopped'
        } catch (error) {
            this.logError(`Failed to stop session ${task.currentSessionId}`, error)
            return 'failed'
        }
    }

    handleEvent(event: SyncEvent): void {
        switch (event.type) {
            case 'session-added':
            case 'session-updated':
                this.adoptLiveSession(event.sessionId)
                // Worktree metadata usually arrives after the spawn call has
                // already returned, so this is the path that actually catches it.
                this.syncWorktreeFromSession(event.sessionId)
                this.syncColumnFromSession(event.sessionId)
                return
            case 'session-ended':
                this.settleRunForSession(event.sessionId, event.reason)
                return
            case 'session-removed':
                // A merged session is not a lost one: the store has already
                // moved the task onto the surviving id, so the task is
                // republished rather than orphaned.
                if (event.mergedInto) {
                    this.publishTask(this.deps.store.tasks.getBySession(event.mergedInto))
                    return
                }
                this.detachSession(event.sessionId)
                return
            default:
                return
        }
    }

    /**
     * Resolve the task a session belongs to.
     *
     * Prefers the in-flight run over `task.currentSessionId`: the latter is an
     * FK with `ON DELETE SET NULL`, so it is already gone by the time a
     * `session-removed` event arrives. Falls back to the pointer for sessions
     * with no open run (a finished task the operator is still chatting with).
     */
    private resolveTaskForSession(sessionId: string): { task: StoredTask; runId: string | null } | null {
        const store = this.deps.store

        const run = store.tasks.getActiveRunBySession(sessionId)
        if (run) {
            const task = store.tasks.get(run.taskId)
            if (task) return { task, runId: run.id }
        }

        const task = store.tasks.getBySession(sessionId)
        return task ? { task, runId: null } : null
    }

    /**
     * Re-derive the column of the task that owns `sessionId`.
     *
     * Only tasks in `running`, `blocked` or `review` are touched; `backlog`,
     * `ready` and `done` belong to the operator and are never corrected here.
     */
    private syncColumnFromSession(sessionId: string): StoredTask | null {
        const store = this.deps.store
        const resolved = this.resolveTaskForSession(sessionId)
        if (!resolved) return null
        const { task } = resolved
        // `review` is included: a task in review goes back to `running` when
        // work resumes on it, and a follow-up turn in the same session is
        // exactly that.
        if (task.column !== 'running' && task.column !== 'blocked' && task.column !== 'review') return null

        const session = this.deps.getSession(sessionId)
        if (!session) return null

        const now = Date.now()
        const activeRun = store.tasks.getActiveRunBySession(sessionId)
        const startupGraceUntil = activeRun ? activeRun.startedAt + STARTUP_GRACE_MS : undefined
        const withinStartup = startupGraceUntil !== undefined && now < startupGraceUntil

        // The session went quiet without a `session-ended` (the hub expires an
        // agent that stops sending keep-alives). The boot sweep deliberately
        // leaves live sessions alone, so this is where such a run gets settled.
        //
        // Two windows hold it off, and they answer different questions:
        //  - the startup grace covers a *young run*: a session row is created
        //    inactive and only flips once the CLI reports in, so without it
        //    every fresh run is declared interrupted the moment it is linked.
        //  - the reattach window covers a *young hub*: after a restart the
        //    agents are still out there and reconnect on their own schedule,
        //    and a run whose session has not checked in yet says nothing about
        //    whether the agent is alive. An hour-old run hits this one and not
        //    the other, which is exactly the case the boot sweep used to get
        //    wrong.
        if (!session.active && !withinStartup && !this.withinReattachWindow(now)) {
            if (activeRun) {
                // The session pointer deliberately survives. The agent went
                // quiet, but its row — and its whole transcript — is still
                // there, so an orphaned run stays openable: there is something
                // worth re-reading. Clearing the pointer here took the task's
                // only way back into the chat with it. `startTask` already retires a stale session
                // before it spawns, so keeping it costs nothing.
                // Contrast `detachSession`, which clears: there the session row
                // really is gone.
                const settled = store.tasks.finishRun(activeRun.id, {
                    status: 'orphaned',
                    error: encodeTaskError('run.interrupted'),
                    column: columnForFinishedRun('orphaned')
                })
                if (settled.outcome === 'finished') {
                    this.publishTask(settled.task)
                    return settled.task
                }
            }
            return null
        }

        const column = columnForLiveSession(session, { startupGraceUntil })
        if (column === task.column) return task

        const moved = store.tasks.move(task.id, task.namespace, column)
        this.publishTask(moved)
        return moved
    }

    private settleRunForSession(sessionId: string, reason: SessionEndReason | undefined): void {
        const store = this.deps.store
        const status = runStatusForEndReason(reason)
        if (status === null) return

        const active = store.tasks.getActiveRunBySession(sessionId)
        if (!active) return

        const settled = store.tasks.finishRun(active.id, {
            status,
            error: status === 'failed' ? encodeTaskError('run.sessionError', reason ?? 'error') : null,
            column: columnForFinishedRun(status)
        })
        if (settled.outcome === 'finished') {
            this.publishTask(settled.task)
        }
    }

    /**
     * A deleted session leaves its run stranded in `running` forever unless it
     * is settled here. The task's own pointer is already NULL by now (the FK
     * cascade fired with the delete), so this has to go through the run.
     */
    private detachSession(sessionId: string): void {
        const store = this.deps.store
        const active = store.tasks.getActiveRunBySession(sessionId)
        if (!active) return

        const settled = store.tasks.finishRun(active.id, {
            status: 'orphaned',
            error: encodeTaskError('run.sessionDeleted'),
            column: columnForFinishedRun('orphaned'),
            clearSession: true
        })
        if (settled.outcome === 'finished') {
            this.publishTask(settled.task)
        }
    }

    /**
     * Give a session that no task owns a task of its own.
     *
     * Every conversation belongs to a task — there is no separate session
     * list to find it in otherwise. So a session no task spawned (started from
     * a terminal, forked, imported) gets a task rather than staying invisible.
     *
     * A live session gets a `running` run, so the task follows the agent like
     * one it started; a finished one gets a settled run and lands in `column`
     * (default `review`). Either way the task resumes the native conversation
     * on Start and never sends its prompt — see `startTask`.
     */
    adoptSession(
        sessionId: string,
        options?: {
            namespace?: string
            title?: string
            permissionMode?: PermissionMode
            column?: TaskColumn
            origin?: 'user' | 'reconcile'
            /** Refuse a session Start could not resume (anything but a Claude
             *  or Codex conversation with its native id). An operator adopting
             *  by hand expects Start to continue that conversation. */
            requireResumable?: boolean
            /** Whether the caller may use the session's machine. */
            allowMachine?: (machineId: string) => boolean
        }
    ): AdoptSessionResult {
        const store = this.deps.store
        const row = store.sessions.getSession(sessionId)
        if (!row || (options?.namespace !== undefined && row.namespace !== options.namespace)) {
            return { outcome: 'not-found' }
        }
        if (store.tasks.isSessionOnBoard(sessionId)) {
            this.boardSessionIds.add(sessionId)
            return { outcome: 'already-on-board', task: store.tasks.getBySession(sessionId) }
        }

        const metadata = readAdoptableMetadata(row.metadata)
        // The assistant helps manage tasks; it is not one.
        if (metadata.role === 'assistant') return { outcome: 'not-adoptable', reason: 'assistant' }
        if (!metadata.path) return { outcome: 'not-adoptable', reason: 'no-workdir' }
        const machineId = metadata.machineId ?? row.machineId
        if (!machineId) return { outcome: 'not-adoptable', reason: 'no-machine' }
        const flavor = AgentFlavorSchema.safeParse(metadata.flavor ?? 'claude')
        if (!flavor.success) return { outcome: 'not-adoptable', reason: 'unknown-flavor' }
        // Resuming opens a *new* HAPI row that continues the same native
        // conversation (`claude --resume` / `codex resume`), so the task has to
        // carry the native id, not just the imported row's.
        const nativeSessionId = flavor.data === 'codex'
            ? metadata.codexSessionId
            : flavor.data === 'claude' ? metadata.claudeSessionId : undefined
        if (options?.requireResumable && !nativeSessionId) {
            return { outcome: 'not-adoptable', reason: 'not-resumable', flavor: flavor.data }
        }
        if (options?.allowMachine && !options.allowMachine(machineId)) {
            return { outcome: 'not-adoptable', reason: 'machine-not-allowed' }
        }

        const opening = firstUserText(store, sessionId)
        const title = options?.title
            ?? metadata.name
            ?? (opening ? deriveTaskTitle(opening) : null)
            ?? (metadata.summary ? deriveTaskTitle(metadata.summary) : null)
            ?? deriveTaskTitle(metadata.path)
        const session = this.deps.getSession(sessionId)
        const permissionMode = options?.permissionMode ?? session?.permissionMode

        const task = store.tasks.create({
            namespace: row.namespace,
            title,
            // Never delivered — an adopted task starts by resuming, not by
            // being told what to do. Kept as the task's description.
            prompt: opening ?? title,
            workdir: metadata.path,
            machineId,
            // The conversation is anchored to the directory it already ran
            // in; a worktree would move the task away from its own history.
            isolation: 'simple',
            column: 'review',
            spawn: {
                flavor: flavor.data,
                // Carried on the task, not just on the session row: starting a
                // task spawns from its own spawn config.
                ...(permissionMode && isPermissionModeAllowedForFlavor(permissionMode as PermissionMode, flavor.data)
                    ? { permissionMode }
                    : {}),
                adoptedSessionId: sessionId,
                ...(nativeSessionId ? { adoptedNativeSessionId: nativeSessionId } : {})
            }
        })

        const origin = options?.origin ?? 'reconcile'
        if (session?.active) {
            const started = store.tasks.startRun({
                taskId: task.id,
                namespace: row.namespace,
                origin,
                sessionId,
                column: columnForLiveSession(session)
            })
            this.boardSessionIds.add(sessionId)
            const adopted = started.outcome === 'started' ? started.task : store.tasks.get(task.id)
            this.publishTask(adopted)
            void this.nameSession(sessionId, title)
            return { outcome: 'adopted', task: adopted ?? task }
        }

        // A run the task did not perform, recorded so the UI can talk about
        // the conversation it just took over: `Open chat` keys off a finished
        // run with an openable status, and the session pointer comes with it.
        const column = options?.column ?? 'review'
        const started = store.tasks.startRun({ taskId: task.id, namespace: row.namespace, origin, sessionId, column })
        if (started.outcome === 'started') {
            store.tasks.finishRun(started.run.id, { status: 'succeeded', column })
        }
        this.boardSessionIds.add(sessionId)
        const adopted = store.tasks.get(task.id) ?? task
        this.publishTask(adopted)
        void this.nameSession(sessionId, title)
        return { outcome: 'adopted', task: adopted }
    }

    /**
     * The card was renamed; the conversation it runs follows.
     *
     * Earlier runs' sessions keep the name they ran under: they are history,
     * and the card's `Open chat` no longer leads to them.
     */
    async taskRenamed(task: StoredTask): Promise<void> {
        this.publishTask(task)
        if (task.currentSessionId) {
            await this.nameSession(task.currentSessionId, task.title)
        }
    }

    /** A card's session was renamed by hand; the card follows. */
    sessionRenamed(sessionId: string, name: string): StoredTask | null {
        const store = this.deps.store
        const task = store.tasks.getBySession(sessionId)
        if (!task || task.title === name) return task
        const updated = store.tasks.update(task.id, task.namespace, { title: name })
        this.publishTask(updated)
        return updated
    }

    /**
     * Give a card's session the card's name.
     *
     * A card and the conversation it runs are one piece of work, so they carry
     * one name, and the card's is the one that counts. Left to itself a
     * session is labelled by its agent's summary, which tracks whatever was
     * asked last, or by the first line of its opening prompt - neither is the
     * name someone gave the work.
     */
    private async nameSession(sessionId: string, name: string): Promise<void> {
        const rename = this.deps.renameSession
        if (!rename) return
        const row = this.deps.store.sessions.getSession(sessionId)
        if (!row || readAdoptableMetadata(row.metadata).name === name) return
        try {
            await rename(sessionId, name)
        } catch (error) {
            // A label, not the work: a run must not fail over it.
            this.logError(`Failed to name session ${sessionId}`, error)
        }
    }

    /** Catch up on pairs that drifted before the board kept them in step. */
    private async nameMisnamedSessions(): Promise<void> {
        for (const { sessionId, title } of this.deps.store.tasks.listMisnamedSessions()) {
            await this.nameSession(sessionId, title)
        }
    }

    /**
     * Adopt a live session the moment it has something to show.
     *
     * Waits for three things, each guarding against a second task for one
     * conversation:
     *  - no task spawn in flight: that session is about to be linked to the
     *    task that spawned it;
     *  - the native id, and no other row carrying it: until then a resume or
     *    reopen may still fold this row into one that already has a task;
     *  - a first message: an agent that came up and never spoke is not a
     *    conversation yet.
     */
    private adoptLiveSession(sessionId: string): void {
        if (this.boardSessionIds.has(sessionId)) return
        const store = this.deps.store
        if (store.tasks.isSessionOnBoard(sessionId)) {
            this.boardSessionIds.add(sessionId)
            return
        }
        if (this.spawnsInFlight > 0) return

        const session = this.deps.getSession(sessionId)
        if (!session?.active) return
        const row = store.sessions.getSession(sessionId)
        if (!row) return
        const metadata = readAdoptableMetadata(row.metadata)
        // Checked before `claimForFailedSpawn`, which would otherwise be free
        // to hand the assistant to a task whose spawn timed out.
        if (metadata.role === 'assistant') return
        const flavor = metadata.flavor ?? 'claude'
        if (flavor === 'claude' || flavor === 'codex') {
            const nativeSessionId = flavor === 'codex' ? metadata.codexSessionId : metadata.claudeSessionId
            if (!nativeSessionId) return
            if (store.tasks.hasNativeSessionSibling(sessionId, nativeSessionId, row.namespace)) return
        }
        if (store.messages.countMessages(sessionId) === 0) return

        if (this.claimForFailedSpawn(row.namespace, sessionId, metadata, session)) return
        this.adoptSession(sessionId)
    }

    /**
     * Hand a session to the task whose spawn gave up on it.
     *
     * The hub's spawn RPC can time out while the runner carries on and the
     * agent comes up anyway. The task has already been settled as `failed` by
     * then, and without this the agent it asked for would be adopted onto a
     * second task beside it.
     */
    private claimForFailedSpawn(
        namespace: string,
        sessionId: string,
        metadata: AdoptableMetadata,
        session: OrchestratorSession
    ): boolean {
        const store = this.deps.store
        const machineId = metadata.machineId
        if (!machineId || !metadata.path) return false
        const since = Date.now() - FAILED_SPAWN_CLAIM_WINDOW_MS
        const candidate = store.tasks.list(namespace, { machineId })
            .filter((task) => task.lastRunStatus === 'failed'
                && task.currentSessionId === null
                && task.updatedAt >= since
                && (task.workdir === metadata.path || task.workdir === metadata.worktreeBasePath))
            .find((task) => {
                const [lastRun] = store.tasks.listRuns(task.id, 1)
                return lastRun !== undefined && lastRun.sessionId === null
            })
        if (!candidate) return false

        const started = store.tasks.startRun({
            taskId: candidate.id,
            namespace,
            origin: 'reconcile',
            sessionId,
            column: columnForLiveSession(session)
        })
        if (started.outcome !== 'started') return false
        this.boardSessionIds.add(sessionId)
        this.publishTask(started.task)
        return true
    }

    /**
     * Give every off-board session with a transcript a task. Runs once the
     * reattach window closes, which is also what migrates the conversations
     * that predate tasks. A conversation some task already holds under
     * another row is skipped.
     */
    private adoptOffBoardSessions(): void {
        const store = this.deps.store
        for (const sessionId of store.tasks.listOffBoardSessionIds()) {
            const row = store.sessions.getSession(sessionId)
            if (!row) continue
            const metadata = readAdoptableMetadata(row.metadata)
            const nativeSessionId = metadata.flavor === 'codex' ? metadata.codexSessionId : metadata.claudeSessionId
            if (nativeSessionId
                && store.tasks.hasNativeSessionSibling(sessionId, nativeSessionId, row.namespace, { onBoardOnly: true })) {
                continue
            }
            const result = this.adoptSession(sessionId)
            if (result.outcome === 'not-adoptable' && result.reason !== 'assistant') {
                this.logError(`Session ${sessionId} left off the board: ${result.reason}`)
            }
        }
    }

    private toSpawnInput(task: StoredTask, spawn: TaskSpawnConfig): SpawnTaskSessionInput {
        return {
            machineId: task.machineId as string,
            directory: task.workdir,
            flavor: spawn.flavor,
            model: spawn.model,
            effort: spawn.effort,
            modelReasoningEffort: spawn.modelReasoningEffort,
            permissionMode: spawn.permissionMode,
            yolo: spawn.yolo,
            serviceTier: spawn.serviceTier,
            collaborationMode: spawn.collaborationMode,
            copilotAgentMode: spawn.copilotAgentMode,
            sessionType: task.isolation === 'simple' ? 'simple' : 'worktree',
            worktreeName: task.worktreeName ?? undefined,
            worktreeBaseRef: task.baseRef ?? undefined,
            resumeSessionId: spawn.adoptedNativeSessionId
        }
    }

    private publishTask(task: StoredTask | null | undefined): void {
        if (!task) return
        this.deps.onTaskChanged?.(task)
    }

    private logError(message: string, error?: unknown): void {
        if (this.deps.logger) {
            this.deps.logger.error(`[TaskOrchestrator] ${message}`, error)
            return
        }
        console.error(`[TaskOrchestrator] ${message}`, error)
    }
}
