import { createHash } from 'node:crypto'

import {
    ASSISTANT_ANSWER_MARKER,
    assistantRepoKey,
    DEFAULT_ASSISTANT_AGENT,
    isAssistantMemoryInContext,
    isOwnedByWorkspaceUser,
    neutraliseTaskContextTags,
    type AssistantAgent,
    type AssistantSessionResponse,
    type AttachmentMetadata
} from '@hapi/protocol'
import type { Store, StoredAssistantMemory, StoredAssistantQuestion, StoredTask, StoredWorkspaceUser } from '../store'
import type { SpawnExtra } from './rpcGateway'
import type { Session } from './syncEngine'

/**
 * The task assistant's hub side.
 *
 * Each workspace user has one assistant session for good. Sending to it means
 * finding that session — or reopening it after a runner restart, or spawning
 * it the first time — and deciding whether the person's view changed enough
 * that the assistant needs to be told (`taskContext`). Context rides on the
 * message, not on the system prompt: changing the system prompt restarts
 * Claude and throws away its prompt cache, and a person switches tasks a lot.
 */

/** New Claude assistants start on Opus; the person can switch in the panel.
 *  Other agents start on their own default. */
export const ASSISTANT_DEFAULT_MODEL: Partial<Record<AssistantAgent, string>> = { claude: 'opus' }

const ATTACH_TIMEOUT_MS = 30_000
/**
 * The hub sees a session go inactive (its socket drops) a few dozen ms before
 * the runner handles the child's exit. A reopen landing in that gap is
 * answered from the runner's spawn dedupe -- the child still looks alive -- and
 * nothing starts. One retry after the runner has caught up covers it.
 */
const REOPEN_RETRY_DELAY_MS = 1_500
const ATTACH_POLL_MS = 50
const TASK_PROMPT_EXCERPT = 500

/**
 * A pinned machine that is down is an error, not a cue to run elsewhere: the
 * person pinned it on purpose, usually to get away from another machine (a
 * broken login there, or their directories live here), and a silent fallback
 * would put them back where they did not want to be.
 */
export const PINNED_MACHINE_OFFLINE =
    'The machine chosen for the assistant is offline. Pick another machine, or Auto, at the top of the assistant panel.'

export type AssistantServiceDeps = {
    store: Store
    getSession: (sessionId: string, namespace: string) => Session | undefined
    listSessions: (namespace: string) => Session[]
    onlineMachineIds: (namespace: string) => string[]
    spawn: (machineId: string, agent: AssistantAgent, extra: SpawnExtra) => Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }>
    reopen: (sessionId: string, namespace: string) => Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }>
    /** Stop a session the person switched away from. */
    stop: (sessionId: string) => Promise<void>
    send: (sessionId: string, payload: {
        text: string
        localId?: string | null
        attachments?: AttachmentMetadata[]
        sentFrom: 'webapp'
        taskContext?: string
    }) => Promise<void>
    isSessionAttached?: (sessionId: string) => boolean
}

export type AssistantSendInput = {
    namespace: string
    workspaceUserId: string
    text: string
    localId?: string | null
    attachments?: AttachmentMetadata[]
    /** The task selected in the sidebar, if any. */
    contextTaskId?: string | null
}

export type AssistantSendResult =
    | { type: 'success'; sessionId: string; contextSent: boolean }
    | { type: 'error'; status: 403 | 404 | 503; message: string }

export class AssistantService {
    /**
     * What the assistant was last told, per session. In memory on purpose: a
     * hub restart costs one repeated context block, which is cheaper than
     * persisting a cache key.
     */
    private readonly lastContextKey = new Map<string, string>()
    /** One find-or-spawn per person at a time; a double-click must not spawn two. */
    private readonly resolving = new Map<string, Promise<{ sessionId: string } | { error: string }>>()

    private readonly reopenRetryDelayMs: number

    constructor(private readonly deps: AssistantServiceDeps & { reopenRetryDelayMs?: number }) {
        this.reopenRetryDelayMs = deps.reopenRetryDelayMs ?? REOPEN_RETRY_DELAY_MS
    }

    /** The person's assistant session id, if one exists, without starting anything. */
    findSessionId(namespace: string, workspaceUserId: string): string | null {
        return this.findSession(namespace, workspaceUserId)?.id ?? null
    }

    getAgent(namespace: string, workspaceUserId: string): AssistantAgent {
        return this.deps.store.assistant.getAgent(workspaceUserId, namespace)
    }

    getMachineId(namespace: string, workspaceUserId: string): string | null {
        return this.deps.store.assistant.getMachineId(workspaceUserId, namespace)
    }

    /** What the panel shows: the conversation in reach, and where it runs. */
    describe(namespace: string, workspaceUserId: string): AssistantSessionResponse {
        const session = this.findSession(namespace, workspaceUserId)
        return {
            sessionId: session?.id ?? null,
            agent: this.getAgent(namespace, workspaceUserId),
            machineId: this.getMachineId(namespace, workspaceUserId),
            sessionMachineId: session?.metadata?.machineId ?? null
        }
    }

    /**
     * Switch the agent behind the assistant. Each agent keeps its own
     * conversation: the running one of the old agent is stopped, and the
     * next message finds (or starts) the new agent's. Switching back reopens
     * the old conversation.
     */
    async setAgent(namespace: string, workspaceUserId: string, agent: AssistantAgent): Promise<boolean> {
        if (!this.deps.store.workspaceUsers.get(workspaceUserId, namespace)) return false
        this.deps.store.assistant.setAgent(workspaceUserId, namespace, agent)
        const others = this.deps.listSessions(namespace)
            .filter((session) => session.active && isAssistantOf(session, workspaceUserId) && agentOf(session) !== agent)
        for (const session of others) {
            await this.deps.stop(session.id).catch(() => {})
        }
        return true
    }

    /**
     * Pin the assistant to a machine, or `null` to pick one automatically.
     * Like an agent switch: each machine keeps its own conversation, the one
     * running elsewhere is stopped, and the next message finds (or starts)
     * the one on the new machine. Memory, questions and grants belong to the
     * person, so they come along. Going back to Auto stops nothing: wherever
     * the assistant runs now is a fine automatic choice.
     */
    async setMachine(
        namespace: string,
        workspaceUserId: string,
        machineId: string | null
    ): Promise<'ok' | 'user-not-found' | 'machine-offline'> {
        if (!this.deps.store.workspaceUsers.get(workspaceUserId, namespace)) return 'user-not-found'
        if (machineId && !this.deps.onlineMachineIds(namespace).includes(machineId)) return 'machine-offline'
        this.deps.store.assistant.setMachineId(workspaceUserId, namespace, machineId)
        if (!machineId) return 'ok'
        const elsewhere = this.deps.listSessions(namespace)
            .filter((session) => session.active && isAssistantOf(session, workspaceUserId) && session.metadata?.machineId !== machineId)
        for (const session of elsewhere) {
            await this.deps.stop(session.id).catch(() => {})
        }
        return 'ok'
    }

    async send(input: AssistantSendInput): Promise<AssistantSendResult> {
        const { namespace, workspaceUserId } = input
        const user = this.deps.store.workspaceUsers.get(workspaceUserId, namespace)
        if (!user) {
            return { type: 'error', status: 404, message: 'Workspace user not found' }
        }

        let task: StoredTask | null = null
        if (input.contextTaskId) {
            task = this.deps.store.tasks.getByNamespace(input.contextTaskId, namespace)
            if (!task) {
                return { type: 'error', status: 404, message: 'Task not found' }
            }
            if (!isOwnedByWorkspaceUser([task.workdir, task.worktreePath], user.paths)) {
                return { type: 'error', status: 403, message: 'Task belongs to someone else' }
            }
        }

        const resolved = await this.ensureSession(user, task)
        if ('error' in resolved) {
            return { type: 'error', status: 503, message: resolved.error }
        }

        const context = this.buildContext(user, task)
        const changed = this.lastContextKey.get(resolved.sessionId) !== context.key
        await this.deps.send(resolved.sessionId, {
            text: input.text,
            localId: input.localId,
            attachments: input.attachments,
            sentFrom: 'webapp',
            ...(changed ? { taskContext: context.text } : {})
        })
        if (changed) {
            this.lastContextKey.set(resolved.sessionId, context.key)
        }
        return { type: 'success', sessionId: resolved.sessionId, contextSent: changed }
    }

    /** After a compaction the assistant has forgotten the block; send it again. */
    forgetContext(sessionId: string): void {
        this.lastContextKey.delete(sessionId)
    }

    private findSession(namespace: string, workspaceUserId: string): Session | null {
        const agent = this.getAgent(namespace, workspaceUserId)
        const pinned = this.getMachineId(namespace, workspaceUserId)
        const matches = (session: Session) => isAssistantOf(session, workspaceUserId)
            && agentOf(session) === agent
            && (!pinned || session.metadata?.machineId === pinned)
        const pointer = this.deps.store.assistant.getSessionId(workspaceUserId, namespace)
        if (pointer) {
            const session = this.deps.getSession(pointer, namespace)
            if (session && matches(session)) return session
        }
        // The pointer can go stale: a reopen may fold the session into another
        // row, or the person switched agents or machines. The metadata is the ground
        // truth; the newest match wins.
        const found = this.deps.listSessions(namespace)
            .filter(matches)
            .sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt)[0]
        if (found && found.id !== pointer) {
            this.deps.store.assistant.setSessionId(workspaceUserId, namespace, found.id)
        }
        return found ?? null
    }

    private ensureSession(user: StoredWorkspaceUser, task: StoredTask | null) {
        const key = `${user.namespace}:${user.id}`
        const inFlight = this.resolving.get(key)
        if (inFlight) return inFlight
        const attempt = this.findOrStart(user, task).finally(() => this.resolving.delete(key))
        this.resolving.set(key, attempt)
        return attempt
    }

    private async findOrStart(
        user: StoredWorkspaceUser,
        task: StoredTask | null
    ): Promise<{ sessionId: string } | { error: string }> {
        const { namespace } = user
        const existing = this.findSession(namespace, user.id)
        if (existing?.active) {
            return { sessionId: existing.id }
        }

        // A conversation lives on the machine that ran it. When that machine is
        // offline the person still needs an assistant: start a fresh one on a
        // machine that is up. Memory, questions and grants carry over; the
        // old conversation does not.
        const online = this.deps.onlineMachineIds(namespace)
        const pinned = this.getMachineId(namespace, user.id)
        if (pinned && !online.includes(pinned)) {
            return { error: PINNED_MACHINE_OFFLINE }
        }
        const existingMachine = existing?.metadata?.machineId
        const canReopen = existing !== null && (!existingMachine || online.includes(existingMachine))

        let sessionId: string
        if (existing && canReopen) {
            let reopened = await this.deps.reopen(existing.id, namespace)
            if (reopened.type !== 'success') {
                await new Promise((resolve) => setTimeout(resolve, this.reopenRetryDelayMs))
                reopened = await this.deps.reopen(existing.id, namespace)
            }
            if (reopened.type !== 'success') {
                return { error: `Could not reopen the assistant: ${reopened.message}` }
            }
            sessionId = reopened.sessionId
        } else {
            const machineId = pinned
                ?? (task?.machineId && online.includes(task.machineId) ? task.machineId : online[0])
            if (!machineId) {
                return { error: 'No machine is online to run the assistant' }
            }
            const spawned = await this.deps.spawn(machineId, this.getAgent(namespace, user.id), {
                assistant: { workspaceUserId: user.id, addDirs: user.paths }
            })
            if (spawned.type !== 'success') {
                return { error: `Could not start the assistant: ${spawned.message}` }
            }
            sessionId = spawned.sessionId
        }

        this.deps.store.assistant.setSessionId(user.id, namespace, sessionId)
        await this.waitForAttach(sessionId)
        return { sessionId }
    }

    private async waitForAttach(sessionId: string): Promise<void> {
        const isAttached = this.deps.isSessionAttached
        if (!isAttached) return
        const deadline = Date.now() + ATTACH_TIMEOUT_MS
        while (!isAttached(sessionId) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, ATTACH_POLL_MS))
        }
    }

    private buildContext(user: StoredWorkspaceUser, task: StoredTask | null): { key: string; text: string } {
        const repo = task ? assistantRepoKey(task.workdir) : null
        const memories = this.deps.store.assistant.listMemories(user.namespace, user.id)
            .filter((memory) => isAssistantMemoryInContext(memory, { taskId: task?.id ?? null, repo }))
        const index = formatMemoryIndex(memories)
        const text = task ? formatTask(task, index) : formatNoTask(index)
        const key = createHash('sha256').update(text).digest('hex')
        return { key, text }
    }
}

function isAssistantOf(session: Session, workspaceUserId: string): boolean {
    return session.metadata?.role === 'assistant' && session.metadata.workspaceUserId === workspaceUserId
}

/** Assistants from before the agent choice carry no flavor and were Claude. */
function agentOf(session: Session): string {
    return session.metadata?.flavor ?? DEFAULT_ASSISTANT_AGENT
}

const SCOPE_LABEL: Record<StoredAssistantMemory['scope'], string> = {
    user: 'user',
    repo: 'repo',
    task: 'task'
}

function formatMemoryIndex(memories: StoredAssistantMemory[]): string {
    if (memories.length === 0) return 'Memory index: (empty)'
    const order: StoredAssistantMemory['scope'][] = ['task', 'repo', 'user']
    const lines = [...memories]
        .sort((a, b) => order.indexOf(a.scope) - order.indexOf(b.scope))
        .map((memory) => `- [${SCOPE_LABEL[memory.scope]}] ${memory.name} — ${memory.description}`)
    return ['Memory index (read a body with memory_read):', ...lines].join('\n')
}

function formatTask(task: StoredTask, index: string): string {
    const prompt = task.prompt.length > TASK_PROMPT_EXCERPT
        ? `${task.prompt.slice(0, TASK_PROMPT_EXCERPT)}…`
        : task.prompt
    return neutraliseTaskContextTags(formatTaskText(task, prompt, index))
}

function formatTaskText(task: StoredTask, prompt: string, index: string): string {
    const facts = [
        `task id: ${task.id}`,
        task.currentSessionId ? `session: ${task.currentSessionId}` : 'session: none (never started)',
        task.branch ? `branch: ${task.branch}` : null,
        `repo: ${task.workdir}`,
        task.worktreePath ? `worktree: ${task.worktreePath}` : null,
        task.lastRunStatus ? `last run: ${task.lastRunStatus}` : null,
        task.lastError ? `last error: ${task.lastError}` : null
    ].filter(Boolean).join(' · ')
    return [
        `The person is looking at task "${task.title}" (column: ${task.column}).`,
        facts,
        `Task prompt: ${prompt}`,
        index,
        task.currentSessionId
            ? 'Use inspect_peer on the task\'s session for what it has actually done.'
            : null
    ].filter(Boolean).join('\n')
}

function formatNoTask(index: string): string {
    return neutraliseTaskContextTags(['The person is looking at their task list, no single task selected.', index].join('\n'))
}

/**
 * What the hub tells the assistant when the person picked something other
 * than what it went ahead with. The first line is what the chat shows; the
 * rest is for the assistant.
 */
export function reworkPrompt(question: StoredAssistantQuestion): string {
    const answer = question.answer ?? ''
    return [
        `${ASSISTANT_ANSWER_MARKER} ${question.question} → ${answer}`,
        '',
        `You went ahead with "${question.chosen}" on this question; the person picked "${answer}" instead.`,
        `Undo it the way you noted: ${question.rollback}`,
        `Then continue with "${answer}", and tell the task sessions it affects.`,
        'If the change reflects a general preference, file it as a feedback memory so you choose right next time.'
    ].join('\n')
}
