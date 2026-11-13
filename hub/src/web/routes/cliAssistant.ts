import {
    AssistantToolMemoryRefSchema,
    AssistantToolMemoryWriteSchema,
    AssistantToolPeerRespondSchema,
    AssistantToolQuestionAddSchema,
    MoveTaskRequestSchema,
    assistantRepoKey,
    isAssistantMemoryInContext,
    isOwnedByWorkspaceUser,
    toAssistantToolId,
    type AssistantMemoryScope
} from '@hapi/protocol'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
    AssistantMemoryNameTakenError,
    type Store,
    type StoredAssistantMemory,
    type StoredTask,
    type StoredWorkspaceUser
} from '../../store'
import type { Session, SyncEngine, SyncEvent } from '../../sync/syncEngine'
import type { TaskOrchestrator } from '../../sync/taskOrchestrator'
import { toTaskUpdatedEvent } from '../../sync/taskOrchestrator'
import { RpcTargetMissingError } from '../../sync/rpcGateway'
import { cliAuth, type CliEnv } from './cli'

/**
 * The task assistant's tools, called by its own CLI process (CLI token).
 *
 * Every request names the *calling session*, never a person, and the hub acts
 * as the person only if that session is the one it assigned as their
 * assistant (the stored pointer). Session metadata is self-reported by the
 * CLI, so `role`/`workspaceUserId` alone prove nothing; the pointer is set by
 * the hub when it spawns or reopens the assistant. A prompt-injected "now
 * write to Bob's memory" has no parameter to say it with. Tasks and sessions
 * outside the person's directories are refused the same way the board's own
 * scope filter would hide them.
 *
 * This does not defend against a hostile holder of the CLI token, which can
 * do far more than this anyway. Confirmation is not enforced here either: the
 * confirm-first tools are gated by the permission prompt in the CLI before
 * they ever call in.
 */

type AssistantCaller = { session: Session; user: StoredWorkspaceUser }

const MEMORY_LIST_LIMIT = 200
const TASK_LIST_LIMIT = 100
const RUN_LIMIT = 10

export function createCliAssistantRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
    getTaskOrchestrator: () => TaskOrchestrator | null
    publish: (event: SyncEvent) => void
}): Hono<CliEnv> {
    const { store, getSyncEngine, getTaskOrchestrator, publish } = options
    const app = new Hono<CliEnv>()
    app.use('*', cliAuth)

    /** The assistant the request comes from, or the response to send instead. */
    const resolveCaller = (c: Context<CliEnv>, sessionId: string | undefined): AssistantCaller | Response => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not ready' }, 503)
        const session = sessionId ? engine.getSessionByNamespace(sessionId, c.get('namespace')) : undefined
        const metadata = session?.metadata
        if (!session || metadata?.role !== 'assistant' || !metadata.workspaceUserId) {
            return c.json({ error: 'Not a task assistant session' }, 403)
        }
        const user = store.workspaceUsers.get(metadata.workspaceUserId, session.namespace)
        if (!user) return c.json({ error: 'Workspace user not found' }, 404)
        if (store.assistant.getSessionId(user.id, session.namespace) !== session.id) {
            return c.json({ error: 'Not a task assistant session' }, 403)
        }
        return { session, user }
    }

    const ownsTask = (user: StoredWorkspaceUser, task: StoredTask) =>
        isOwnedByWorkspaceUser([task.workdir, task.worktreePath], user.paths)

    /** The session is what one of the person's tasks is running now. */
    const isOwnTaskSession = (caller: AssistantCaller, sessionId: string) =>
        store.tasks.list(caller.session.namespace).some((task) =>
            task.currentSessionId === sessionId && task.archivedAt === null && ownsTask(caller.user, task))

    const requireOwnTask = (c: Context<CliEnv>, caller: AssistantCaller, taskId: string): StoredTask | Response => {
        const task = store.tasks.getByNamespace(taskId, caller.session.namespace)
        if (!task || !ownsTask(caller.user, task)) {
            return c.json({ error: 'Task not found among this person\'s tasks' }, 404)
        }
        return task
    }

    /** Where an entry lives: the person, a repo (normalised), or one of their tasks. */
    const resolveScopeRef = (
        c: Context<CliEnv>,
        caller: AssistantCaller,
        scope: AssistantMemoryScope,
        scopeRef: string | undefined
    ): string | Response => {
        if (scope === 'user') return caller.user.id
        if (!scopeRef) return c.json({ error: `scopeRef is required for ${scope} memories` }, 400)
        if (scope === 'repo') return assistantRepoKey(scopeRef)
        const task = requireOwnTask(c, caller, scopeRef)
        return task instanceof Response ? task : task.id
    }

    const memoryIndexLine = (memory: StoredAssistantMemory) => ({
        id: memory.id,
        scope: memory.scope,
        scopeRef: memory.scopeRef,
        name: memory.name,
        description: memory.description,
        type: memory.type,
        lastEditedBy: memory.lastEditedBy
    })

    const findMemories = (caller: AssistantCaller, ref: z.infer<typeof AssistantToolMemoryRefSchema>) =>
        store.assistant.listMemories(caller.session.namespace, caller.user.id).filter((memory) =>
            memory.name === ref.name
            && (ref.scope === undefined || memory.scope === ref.scope)
            && (ref.scopeRef === undefined || memory.scopeRef === (ref.scope === 'repo' ? assistantRepoKey(ref.scopeRef) : ref.scopeRef))
        )

    app.get('/assistant/tools/memories', (c) => {
        const caller = resolveCaller(c, c.req.query('sessionId'))
        if (caller instanceof Response) return caller
        const taskId = c.req.query('taskId')
        let memories = store.assistant.listMemories(caller.session.namespace, caller.user.id)
        if (taskId) {
            const task = store.tasks.getByNamespace(taskId, caller.session.namespace)
            const context = { taskId, repo: task && ownsTask(caller.user, task) ? assistantRepoKey(task.workdir) : null }
            memories = memories.filter((memory) => isAssistantMemoryInContext(memory, context))
        }
        return c.json({ memories: memories.slice(0, MEMORY_LIST_LIMIT).map(memoryIndexLine) })
    })

    app.post('/assistant/tools/memories/read', async (c) => {
        const body = await c.req.json().catch(() => null) as { sessionId?: string } | null
        const caller = resolveCaller(c, body?.sessionId)
        if (caller instanceof Response) return caller
        const parsed = AssistantToolMemoryRefSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
        return c.json({ memories: findMemories(caller, parsed.data) })
    })

    app.post('/assistant/tools/memories/write', async (c) => {
        const body = await c.req.json().catch(() => null) as { sessionId?: string } | null
        const caller = resolveCaller(c, body?.sessionId)
        if (caller instanceof Response) return caller
        const parsed = AssistantToolMemoryWriteSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)

        const scopeRef = resolveScopeRef(c, caller, parsed.data.scope, parsed.data.scopeRef)
        if (scopeRef instanceof Response) return scopeRef
        const namespace = caller.session.namespace
        const source = { sessionId: caller.session.id, messageSeq: null }
        const existing = store.assistant.getMemoryByName(namespace, caller.user.id, parsed.data.scope, scopeRef, parsed.data.name)
        try {
            const memory = existing
                ? store.assistant.updateMemory(existing.id, namespace, {
                    description: parsed.data.description,
                    type: parsed.data.type,
                    body: parsed.data.body
                }, 'ai', source)
                : store.assistant.createMemory({
                    namespace,
                    workspaceUserId: caller.user.id,
                    scope: parsed.data.scope,
                    scopeRef,
                    name: parsed.data.name,
                    description: parsed.data.description,
                    type: parsed.data.type,
                    body: parsed.data.body,
                    author: 'ai',
                    source
                })
            if (!memory) return c.json({ error: 'Memory not found' }, 404)
            publish({ type: 'assistant-memory-updated', namespace, workspaceUserId: caller.user.id, memoryId: memory.id })
            return c.json({ outcome: existing ? 'updated' : 'created', memory })
        } catch (error) {
            if (error instanceof AssistantMemoryNameTakenError) return c.json({ error: error.message }, 409)
            throw error
        }
    })

    app.post('/assistant/tools/memories/delete', async (c) => {
        const body = await c.req.json().catch(() => null) as { sessionId?: string } | null
        const caller = resolveCaller(c, body?.sessionId)
        if (caller instanceof Response) return caller
        const parsed = AssistantToolMemoryRefSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)

        const matches = findMemories(caller, parsed.data)
        if (matches.length === 0) return c.json({ error: 'No such memory' }, 404)
        if (matches.length > 1) {
            return c.json({ error: 'Several memories have that name; give scope and scopeRef', matches: matches.map(memoryIndexLine) }, 409)
        }
        const memory = matches[0]
        store.assistant.deleteMemory(memory.id, caller.session.namespace)
        publish({ type: 'assistant-memory-updated', namespace: caller.session.namespace, workspaceUserId: caller.user.id, memoryId: memory.id })
        // The whole entry comes back so the person can restore it from the chat.
        return c.json({ deleted: memory })
    })

    const questionsChanged = (caller: AssistantCaller) =>
        publish({ type: 'assistant-questions-updated', namespace: caller.session.namespace, workspaceUserId: caller.user.id })

    app.get('/assistant/tools/questions', (c) => {
        const caller = resolveCaller(c, c.req.query('sessionId'))
        if (caller instanceof Response) return caller
        const questions = store.assistant.listQuestions(caller.session.namespace, caller.user.id)
            .filter((question) => question.status === 'open')
            .map(({ id, taskId, question, options, chosen, createdAt }) => ({ id, taskId, question, options, chosen, createdAt }))
        return c.json({ questions })
    })

    app.post('/assistant/tools/questions/add', async (c) => {
        const body = await c.req.json().catch(() => null) as { sessionId?: string } | null
        const caller = resolveCaller(c, body?.sessionId)
        if (caller instanceof Response) return caller
        const parsed = AssistantToolQuestionAddSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
        if (parsed.data.taskId) {
            const task = requireOwnTask(c, caller, parsed.data.taskId)
            if (task instanceof Response) return task
        }
        const question = store.assistant.createQuestion({
            namespace: caller.session.namespace,
            workspaceUserId: caller.user.id,
            taskId: parsed.data.taskId ?? null,
            question: parsed.data.question,
            options: parsed.data.options,
            chosen: parsed.data.chosen,
            rationale: parsed.data.rationale,
            rollback: parsed.data.rollback,
            source: { sessionId: caller.session.id, messageSeq: null }
        })
        questionsChanged(caller)
        return c.json({ id: question.id, status: question.status })
    })

    const questionWithdrawSchema = z.object({ id: z.string().min(1) })

    app.post('/assistant/tools/questions/withdraw', async (c) => {
        const body = await c.req.json().catch(() => null) as { sessionId?: string } | null
        const caller = resolveCaller(c, body?.sessionId)
        if (caller instanceof Response) return caller
        const parsed = questionWithdrawSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'id is required' }, 400)
        const current = store.assistant.getQuestion(parsed.data.id, caller.session.namespace)
        if (!current || current.workspaceUserId !== caller.user.id) {
            return c.json({ error: 'No such question' }, 404)
        }
        const closed = store.assistant.closeQuestion(current.id, caller.session.namespace, 'withdrawn', null)
        if (!closed) return c.json({ error: `Already ${current.status}`, answer: current.answer }, 409)
        questionsChanged(caller)
        return c.json({ ok: true })
    })

    app.get('/assistant/tools/tasks', (c) => {
        const caller = resolveCaller(c, c.req.query('sessionId'))
        if (caller instanceof Response) return caller
        const column = c.req.query('column')
        const tasks = store.tasks.list(caller.session.namespace)
            .filter((task) => task.archivedAt === null && ownsTask(caller.user, task))
            .filter((task) => !column || task.column === column)
            .slice(0, TASK_LIST_LIMIT)
            .map((task) => ({
                id: task.id,
                title: task.title,
                column: task.column,
                sessionId: task.currentSessionId,
                lastRunStatus: task.lastRunStatus,
                updatedAt: task.updatedAt
            }))
        return c.json({ tasks })
    })

    app.get('/assistant/tools/tasks/:id', (c) => {
        const caller = resolveCaller(c, c.req.query('sessionId'))
        if (caller instanceof Response) return caller
        const task = requireOwnTask(c, caller, c.req.param('id') ?? '')
        if (task instanceof Response) return task
        return c.json({ task, runs: store.tasks.listRuns(task.id, RUN_LIMIT) })
    })

    app.post('/assistant/tools/tasks/:id/move', async (c) => {
        const body = await c.req.json().catch(() => null) as { sessionId?: string } | null
        const caller = resolveCaller(c, body?.sessionId)
        if (caller instanceof Response) return caller
        const task = requireOwnTask(c, caller, c.req.param('id') ?? '')
        if (task instanceof Response) return task
        const parsed = MoveTaskRequestSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'Invalid column' }, 400)
        const moved = store.tasks.move(task.id, caller.session.namespace, parsed.data.column)
        if (!moved) return c.json({ error: 'Task not found' }, 404)
        publish(toTaskUpdatedEvent(moved))
        return c.json({ task: moved })
    })

    app.post('/assistant/tools/tasks/:id/start', async (c) => {
        const body = await c.req.json().catch(() => null) as { sessionId?: string } | null
        const caller = resolveCaller(c, body?.sessionId)
        if (caller instanceof Response) return caller
        const task = requireOwnTask(c, caller, c.req.param('id') ?? '')
        if (task instanceof Response) return task
        const orchestrator = getTaskOrchestrator()
        if (!orchestrator) return c.json({ error: 'Not ready' }, 503)
        const result = await orchestrator.startTask(task.id, caller.session.namespace)
        if (result.outcome === 'started') {
            return c.json({ outcome: 'started', sessionId: result.sessionId })
        }
        return c.json({ error: 'message' in result ? result.message : result.outcome, outcome: result.outcome }, 409)
    })

    app.post('/assistant/tools/tasks/:id/cancel', async (c) => {
        const body = await c.req.json().catch(() => null) as { sessionId?: string } | null
        const caller = resolveCaller(c, body?.sessionId)
        if (caller instanceof Response) return caller
        const task = requireOwnTask(c, caller, c.req.param('id') ?? '')
        if (task instanceof Response) return task
        const orchestrator = getTaskOrchestrator()
        if (!orchestrator) return c.json({ error: 'Not ready' }, 503)
        const result = await orchestrator.cancelTask(task.id, caller.session.namespace)
        if (result.outcome === 'task-not-found') return c.json({ error: 'Task not found' }, 404)
        if (result.outcome === 'not-running') return c.json({ error: 'Task is not running' }, 409)
        return c.json({ outcome: 'canceled' })
    })

    app.post('/assistant/tools/peer-respond', async (c) => {
        const body = await c.req.json().catch(() => null) as { sessionId?: string } | null
        const caller = resolveCaller(c, body?.sessionId)
        if (caller instanceof Response) return caller
        const parsed = AssistantToolPeerRespondSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not ready' }, 503)

        // Only sessions the person's tasks are running, not the sessions they
        // drive by hand: those prompts are theirs to answer.
        const target = engine.getSessionByNamespace(parsed.data.targetSessionId, caller.session.namespace)
        if (!target || target.id === caller.session.id || !isOwnTaskSession(caller, target.id)) {
            return c.json({ error: 'Session not found among this person\'s tasks' }, 404)
        }
        if (!target.active) return c.json({ error: 'That session is not running' }, 409)
        const request = target.agentState?.requests?.[parsed.data.requestId]
        if (!request) return c.json({ error: 'No such pending request on that session' }, 404)

        try {
            if (parsed.data.decision === 'approve') {
                await engine.approvePermission(target.id, parsed.data.requestId, undefined, undefined, undefined, parsed.data.answers)
            } else {
                // A bare deny reads as abort to Codex; decline so its turn goes on.
                await engine.denyPermission(target.id, parsed.data.requestId, 'denied')
            }
        } catch (error) {
            if (error instanceof RpcTargetMissingError) {
                return c.json({ error: 'That session is not connected' }, 409)
            }
            throw error
        }
        return c.json({ ok: true, tool: request.tool })
    })

    app.get('/assistant/tools/grants', (c) => {
        const caller = resolveCaller(c, c.req.query('sessionId'))
        if (caller instanceof Response) return caller
        const tool = c.req.query('tool') ?? ''
        const id = tool.startsWith('mcp__') ? tool : toAssistantToolId(tool)
        return c.json({ granted: store.assistant.hasGrant(caller.user.id, id) })
    })

    return app
}
