import {
    AnswerAssistantQuestionRequestSchema,
    CreateAssistantMemoryRequestSchema,
    SendAssistantMessageRequestSchema,
    SetAssistantAgentRequestSchema,
    SetAssistantMachineRequestSchema,
    UndoAssistantMemoryRequestSchema,
    UpdateAssistantMemoryRequestSchema,
    assistantRepoKey,
    isAssistantMemoryInContext,
    type AssistantGrant,
    type AssistantGrantListResponse,
    type AssistantMemory,
    type AssistantMemoryListResponse,
    type AssistantMemoryResponse,
    type AssistantMemoryUndoResponse,
    type AssistantQuestion,
    type AnswerAssistantQuestionResponse,
    type AssistantQuestionListResponse,
    type AssistantSessionResponse,
    type SendAssistantMessageResponse
} from '@hapi/protocol'
import { Hono, type Context } from 'hono'
import {
    AssistantMemoryNameTakenError,
    type Store,
    type StoredAssistantGrant,
    type StoredAssistantMemory,
    type StoredAssistantQuestion
} from '../../store'
import type { SyncEvent } from '../../sync/syncEngine'
import { reworkPrompt, type AssistantService } from '../../sync/assistantService'
import type { WebAppEnv } from '../middleware/auth'

/**
 * The person's side of the task assistant: read and edit what it remembers,
 * see and revoke what it may do without asking.
 *
 * Everything here is written as the person (`human`). The assistant writes
 * through its own tool routes, which resolve the person from the calling
 * session instead of trusting a parameter.
 */

function toAssistantMemory(row: StoredAssistantMemory): AssistantMemory {
    return { ...row }
}

function toAssistantQuestion(row: StoredAssistantQuestion): AssistantQuestion {
    return { ...row }
}

function toAssistantGrant(row: StoredAssistantGrant): AssistantGrant {
    return { ...row }
}

export function createAssistantRoutes(options: {
    store: Store
    publish: (event: SyncEvent) => void
    getAssistantService: () => AssistantService | null
}): Hono<WebAppEnv> {
    const { store, publish, getAssistantService } = options
    const app = new Hono<WebAppEnv>()

    const memoryChanged = (namespace: string, workspaceUserId: string, memoryId: string) => {
        publish({ type: 'assistant-memory-updated', namespace, workspaceUserId, memoryId })
    }

    /** The workspace user named by `id`, if it exists in the caller's namespace. */
    const requireWorkspaceUser = (c: Context<WebAppEnv>, id: string | undefined) => {
        if (!id) return null
        return store.workspaceUsers.get(id, c.get('namespace'))
    }

    const nameTaken = (c: Context<WebAppEnv>, error: unknown) => {
        if (error instanceof AssistantMemoryNameTakenError) {
            return c.json({ error: error.message }, 409)
        }
        throw error
    }

    app.get('/assistant/memories', (c) => {
        const namespace = c.get('namespace')
        const user = requireWorkspaceUser(c, c.req.query('workspaceUser'))
        if (!user) {
            return c.json({ error: 'Workspace user not found' }, 404)
        }

        let rows = store.assistant.listMemories(namespace, user.id)
        const taskId = c.req.query('taskId')
        if (taskId) {
            const task = store.tasks.getByNamespace(taskId, namespace)
            const context = { taskId, repo: task ? assistantRepoKey(task.workdir) : null }
            rows = rows.filter((row) => isAssistantMemoryInContext(row, context))
        }
        const response: AssistantMemoryListResponse = { memories: rows.map(toAssistantMemory) }
        return c.json(response)
    })

    app.post('/assistant/memories', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = CreateAssistantMemoryRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
        }
        const namespace = c.get('namespace')
        const user = requireWorkspaceUser(c, parsed.data.workspaceUserId)
        if (!user) {
            return c.json({ error: 'Workspace user not found' }, 404)
        }

        try {
            const row = store.assistant.createMemory({
                namespace,
                workspaceUserId: user.id,
                scope: parsed.data.scope,
                scopeRef: parsed.data.scope === 'user' ? user.id : parsed.data.scopeRef,
                name: parsed.data.name,
                description: parsed.data.description,
                type: parsed.data.type,
                body: parsed.data.body,
                author: 'human'
            })
            memoryChanged(namespace, user.id, row.id)
            const response: AssistantMemoryResponse = { memory: toAssistantMemory(row) }
            return c.json(response, 201)
        } catch (error) {
            return nameTaken(c, error)
        }
    })

    app.patch('/assistant/memories/:id', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = UpdateAssistantMemoryRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
        }
        const namespace = c.get('namespace')
        const id = c.req.param('id') ?? ''
        const current = store.assistant.getMemory(id, namespace)
        if (!current) {
            return c.json({ error: 'Memory not found' }, 404)
        }

        const { acceptPrevious, ...patch } = parsed.data
        try {
            let row: StoredAssistantMemory | null = current
            if (Object.values(patch).some((field) => field !== undefined)) {
                row = store.assistant.updateMemory(id, namespace, {
                    ...patch,
                    scopeRef: patch.scope === 'user' ? current.workspaceUserId : patch.scopeRef
                }, 'human')
            } else if (acceptPrevious) {
                row = store.assistant.acceptMemory(id, namespace)
            }
            if (!row) {
                return c.json({ error: 'Memory not found' }, 404)
            }
            memoryChanged(namespace, row.workspaceUserId, row.id)
            const response: AssistantMemoryResponse = { memory: toAssistantMemory(row) }
            return c.json(response)
        } catch (error) {
            return nameTaken(c, error)
        }
    })

    app.delete('/assistant/memories/:id', (c) => {
        const namespace = c.get('namespace')
        const id = c.req.param('id') ?? ''
        const current = store.assistant.getMemory(id, namespace)
        if (!current || !store.assistant.deleteMemory(id, namespace)) {
            return c.json({ error: 'Memory not found' }, 404)
        }
        memoryChanged(namespace, current.workspaceUserId, id)
        return c.json({ ok: true })
    })

    app.post('/assistant/memories/:id/undo', async (c) => {
        const namespace = c.get('namespace')
        const id = c.req.param('id') ?? ''
        const parsed = UndoAssistantMemoryRequestSchema.safeParse(await c.req.json().catch(() => ({})))
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }
        const current = store.assistant.getMemory(id, namespace)
        if (!current) {
            return c.json({ error: 'Memory not found' }, 404)
        }

        try {
            const result = store.assistant.undoMemory(id, namespace, parsed.data.ifUpdatedAt)
            switch (result.outcome) {
                case 'not-found':
                    return c.json({ error: 'Memory not found' }, 404)
                case 'nothing-to-undo':
                    return c.json({ error: 'Nothing to undo' }, 409)
                case 'changed':
                    return c.json({ error: 'The memory changed since; edit it in the memory tab' }, 409)
                case 'deleted': {
                    memoryChanged(namespace, current.workspaceUserId, id)
                    const response: AssistantMemoryUndoResponse = { outcome: 'deleted', memoryId: id }
                    return c.json(response)
                }
                case 'restored': {
                    memoryChanged(namespace, current.workspaceUserId, id)
                    const response: AssistantMemoryUndoResponse = {
                        outcome: 'restored',
                        memory: toAssistantMemory(result.memory)
                    }
                    return c.json(response)
                }
            }
        } catch (error) {
            return nameTaken(c, error)
        }
    })

    app.get('/assistant/session', (c) => {
        const user = requireWorkspaceUser(c, c.req.query('workspaceUser'))
        if (!user) {
            return c.json({ error: 'Workspace user not found' }, 404)
        }
        const namespace = c.get('namespace')
        const service = getAssistantService()
        const response: AssistantSessionResponse = service?.describe(namespace, user.id) ?? {
            sessionId: null,
            agent: store.assistant.getAgent(user.id, namespace),
            machineId: store.assistant.getMachineId(user.id, namespace),
            sessionMachineId: null
        }
        return c.json(response)
    })

    app.put('/assistant/agent', async (c) => {
        const service = getAssistantService()
        if (!service) {
            return c.json({ error: 'Hub is still starting up' }, 503)
        }
        const body = await c.req.json().catch(() => null)
        const parsed = SetAssistantAgentRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
        }
        const namespace = c.get('namespace')
        if (!await service.setAgent(namespace, parsed.data.workspaceUserId, parsed.data.agent)) {
            return c.json({ error: 'Workspace user not found' }, 404)
        }
        const response: AssistantSessionResponse = service.describe(namespace, parsed.data.workspaceUserId)
        return c.json(response)
    })

    app.put('/assistant/machine', async (c) => {
        const service = getAssistantService()
        if (!service) {
            return c.json({ error: 'Hub is still starting up' }, 503)
        }
        const body = await c.req.json().catch(() => null)
        const parsed = SetAssistantMachineRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
        }
        const namespace = c.get('namespace')
        const outcome = await service.setMachine(namespace, parsed.data.workspaceUserId, parsed.data.machineId)
        if (outcome === 'user-not-found') {
            return c.json({ error: 'Workspace user not found' }, 404)
        }
        if (outcome === 'machine-offline') {
            return c.json({ error: 'That machine is offline' }, 409)
        }
        const response: AssistantSessionResponse = service.describe(namespace, parsed.data.workspaceUserId)
        return c.json(response)
    })

    app.post('/assistant/messages', async (c) => {
        const service = getAssistantService()
        if (!service) {
            return c.json({ error: 'Hub is still starting up' }, 503)
        }
        const body = await c.req.json().catch(() => null)
        const parsed = SendAssistantMessageRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
        }
        const result = await service.send({
            namespace: c.get('namespace'),
            workspaceUserId: parsed.data.workspaceUserId,
            text: parsed.data.text,
            localId: parsed.data.localId,
            attachments: parsed.data.attachments,
            contextTaskId: parsed.data.contextTaskId
        })
        if (result.type === 'error') {
            return c.json({ error: result.message }, result.status)
        }
        const response: SendAssistantMessageResponse = { sessionId: result.sessionId, contextSent: result.contextSent }
        return c.json(response)
    })

    app.get('/assistant/questions', (c) => {
        const user = requireWorkspaceUser(c, c.req.query('workspaceUser'))
        if (!user) {
            return c.json({ error: 'Workspace user not found' }, 404)
        }
        const response: AssistantQuestionListResponse = {
            questions: store.assistant.listQuestions(c.get('namespace'), user.id).map(toAssistantQuestion)
        }
        return c.json(response)
    })

    /** Answers whose rework message is on its way; a double tap must not send it twice. */
    const reworking = new Set<string>()

    /**
     * The person answers a question the assistant already acted on. The same
     * answer it chose just closes it; anything else sends the assistant back
     * to undo and redo. The question closes only once the assistant has been
     * told, so a failed send leaves it open to answer again.
     */
    app.post('/assistant/questions/:id/answer', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = AnswerAssistantQuestionRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
        }
        const namespace = c.get('namespace')
        const id = c.req.param('id') ?? ''
        const current = store.assistant.getQuestion(id, namespace)
        if (!current) {
            return c.json({ error: 'Question not found' }, 404)
        }
        if (current.status !== 'open' || reworking.has(id)) {
            return c.json({ error: 'Question already answered' }, 409)
        }

        const answer = parsed.data.answer
        const overridden = answer !== current.chosen
        if (overridden) {
            const service = getAssistantService()
            if (!service) {
                const response: AnswerAssistantQuestionResponse = {
                    question: toAssistantQuestion(current),
                    reworkError: 'Hub is still starting up'
                }
                return c.json(response)
            }
            reworking.add(id)
            try {
                const task = current.taskId ? store.tasks.getByNamespace(current.taskId, namespace) : null
                const sent = await service.send({
                    namespace,
                    workspaceUserId: current.workspaceUserId,
                    text: reworkPrompt({ ...current, answer }),
                    contextTaskId: task?.id ?? null
                })
                if (sent.type === 'error') {
                    const response: AnswerAssistantQuestionResponse = {
                        question: toAssistantQuestion(current),
                        reworkError: sent.message
                    }
                    return c.json(response)
                }
            } finally {
                reworking.delete(id)
            }
        }

        const closed = store.assistant.closeQuestion(id, namespace, overridden ? 'overridden' : 'confirmed', answer)
        if (!closed) {
            return c.json({ error: 'Question already answered' }, 409)
        }
        publish({ type: 'assistant-questions-updated', namespace, workspaceUserId: closed.workspaceUserId })
        const response: AnswerAssistantQuestionResponse = { question: toAssistantQuestion(closed), reworkError: null }
        return c.json(response)
    })

    app.get('/assistant/grants', (c) => {
        const user = requireWorkspaceUser(c, c.req.query('workspaceUser'))
        if (!user) {
            return c.json({ error: 'Workspace user not found' }, 404)
        }
        const response: AssistantGrantListResponse = {
            grants: store.assistant.listGrants(user.id).map(toAssistantGrant)
        }
        return c.json(response)
    })

    app.delete('/assistant/grants/:id', (c) => {
        const user = requireWorkspaceUser(c, c.req.query('workspaceUser'))
        if (!user) {
            return c.json({ error: 'Workspace user not found' }, 404)
        }
        if (!store.assistant.deleteGrant(c.req.param('id') ?? '', user.id)) {
            return c.json({ error: 'Grant not found' }, 404)
        }
        publish({ type: 'assistant-grants-updated', namespace: c.get('namespace'), workspaceUserId: user.id })
        return c.json({ ok: true })
    })

    return app
}
