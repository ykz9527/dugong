import axios from 'axios'
import { z } from 'zod'
import {
    AssistantMemoryScopeSchema,
    AssistantToolMemoryRefSchema,
    AssistantToolMemoryWriteSchema,
    AssistantToolPeerRespondSchema,
    AssistantToolQuestionAddSchema,
    MoveTaskRequestSchema,
    TaskColumnSchema,
    isAssistantGrantableTool
} from '@hapi/protocol'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'
import { logger } from '@/ui/logger'

/**
 * The task assistant's own tools.
 *
 * Each call goes to the hub's /cli/assistant/tools routes with this session's
 * id; the hub works out whose assistant that is. Nothing here names a person,
 * so nothing the model is talked into can point a write at someone else.
 */

export const ASSISTANT_TOOL_NAMES = [
    'memory_list',
    'memory_read',
    'memory_write',
    'memory_delete',
    'task_list',
    'task_get',
    'task_move',
    'task_start',
    'task_cancel',
    'peer_respond',
    'question_add',
    'question_list',
    'question_withdraw'
] as const

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError: boolean }

function ok(value: unknown): ToolResult {
    return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], isError: false }
}

function fail(error: unknown): ToolResult {
    const message = axios.isAxiosError(error)
        ? (error.response?.data as { error?: string } | undefined)?.error ?? error.message
        : error instanceof Error ? error.message : String(error)
    return { content: [{ type: 'text', text: `Failed: ${message}` }], isError: true }
}

function hubHeaders(): Record<string, string> {
    return buildHubRequestHeaders({
        Authorization: `Bearer ${getAuthToken()}`,
        'Content-Type': 'application/json'
    })
}

const toolsUrl = (path: string) => `${configuration.apiUrl}/cli/assistant/tools${path}`

/** Has the person granted this confirm-first tool for good? Errors count as no. */
export async function hasAssistantGrant(sessionId: string, toolId: string): Promise<boolean> {
    if (!isAssistantGrantableTool(toolId)) return false
    try {
        const response = await axios.get(toolsUrl('/grants'), {
            headers: hubHeaders(),
            params: { sessionId, tool: toolId },
            timeout: 5_000
        })
        return (response.data as { granted?: unknown }).granted === true
    } catch (error) {
        logger.debug('[assistantTools] grant check failed; asking instead', error)
        return false
    }
}

type ToolSchema = z.ZodObject

/**
 * The one McpServer method these tools need. Narrow on purpose: the Codex
 * bridge registers the same definitions with handlers that forward to the
 * HTTP server instead.
 */
export type AssistantToolRegistrar = {
    registerTool: (
        name: string,
        config: { title: string; description: string; inputSchema: ToolSchema },
        handler: (args: Record<string, unknown>) => Promise<ToolResult>
    ) => unknown
}

const taskIdSchema = z.object({ taskId: z.string().min(1) })

export function registerAssistantTools(mcp: AssistantToolRegistrar, sessionId: string): void {
    const get = async (path: string, params: Record<string, string | undefined> = {}) =>
        (await axios.get(toolsUrl(path), { headers: hubHeaders(), params: { sessionId, ...params }, timeout: 15_000 })).data
    const post = async (path: string, body: Record<string, unknown> = {}) =>
        (await axios.post(toolsUrl(path), { sessionId, ...body }, { headers: hubHeaders(), timeout: 60_000 })).data

    /** The MCP server has already validated `args`; parsing again types them. */
    const register = <S extends ToolSchema>(
        name: string,
        title: string,
        description: string,
        inputSchema: S,
        run: (args: z.output<S>) => Promise<unknown>
    ) => {
        mcp.registerTool(name, { title, description, inputSchema }, async (args) => {
            logger.debug(`[assistantTools] ${name}`, args)
            try {
                return ok(await run(inputSchema.parse(args)))
            } catch (error) {
                return fail(error)
            }
        })
    }

    register(
        'memory_list',
        'List memories',
        'List the person\'s memory entries (name, one-line description, scope). With taskId, only those relevant to that task. The index you were given in <task-context> is usually enough; use this to see everything.',
        z.object({
            scope: AssistantMemoryScopeSchema.optional(),
            taskId: z.string().optional().describe('Only entries relevant to this task: the person\'s, its repo\'s, its own')
        }),
        async (args) => {
            const data = await get('/memories', { taskId: args.taskId }) as { memories: Array<{ scope: string }> }
            return args.scope ? { memories: data.memories.filter((m) => m.scope === args.scope) } : data
        }
    )

    register(
        'memory_read',
        'Read memory',
        'Read the full body of a memory entry by name. Give scope (and scopeRef) when the name is ambiguous.',
        AssistantToolMemoryRefSchema,
        async (args) => await post('/memories/read', args)
    )

    register(
        'memory_write',
        'Write memory',
        'Create a memory entry, or update the one with the same name in the same place. One fact per entry. Check the index first and update an existing entry rather than adding a near-duplicate. For feedback and project entries the body states **Why:** and **How to apply:**. The person can see, edit and undo every write.',
        AssistantToolMemoryWriteSchema,
        async (args) => await post('/memories/write', args)
    )

    register(
        'memory_delete',
        'Delete memory',
        'Delete a memory entry that turned out wrong or no longer holds. The person can restore it.',
        AssistantToolMemoryRefSchema,
        async (args) => await post('/memories/delete', args)
    )

    register(
        'task_list',
        'List tasks',
        'The person\'s tasks on the board (not archived): id, title, column, session id.',
        z.object({ column: TaskColumnSchema.optional() }),
        async (args) => await get('/tasks', { column: args.column })
    )

    register(
        'task_get',
        'Get task',
        'One task in full, with its recent runs. For what the agent actually did, inspect its session with inspect_peer.',
        taskIdSchema,
        async (args) => await get(`/tasks/${encodeURIComponent(args.taskId)}`)
    )

    register(
        'task_move',
        'Move task',
        'Move one of the person\'s cards to another column. Asks the person first unless they granted it.',
        MoveTaskRequestSchema.extend(taskIdSchema.shape),
        async (args) => await post(`/tasks/${encodeURIComponent(args.taskId)}/move`, { column: args.column })
    )

    register(
        'task_start',
        'Start task',
        'Start (or re-run) one of the person\'s tasks: spawns its agent and sends its prompt. Asks the person first unless they granted it.',
        taskIdSchema,
        async (args) => await post(`/tasks/${encodeURIComponent(args.taskId)}/start`)
    )

    register(
        'task_cancel',
        'Stop task',
        'Stop a running task\'s agent. Asks the person first unless they granted it.',
        taskIdSchema,
        async (args) => await post(`/tasks/${encodeURIComponent(args.taskId)}/cancel`)
    )

    register(
        'question_add',
        'File a question for later',
        'Record a decision you made without the person, so they can check it when they have time. Use it instead of asking in chat whenever the choice can be undone: you have already gone ahead with `chosen`. If they pick something else, the hub will tell you, and you undo as `rollback` says. Look at question_list first so you do not file the same question twice.',
        AssistantToolQuestionAddSchema,
        async (args) => await post('/questions/add', args)
    )

    register(
        'question_list',
        'List open questions',
        'The questions you filed that the person has not answered yet.',
        z.object({}),
        async () => await get('/questions')
    )

    register(
        'question_withdraw',
        'Withdraw a question',
        'Withdraw an open question that no longer stands, e.g. the person settled it in chat.',
        z.object({ id: z.string().min(1) }),
        async (args) => await post('/questions/withdraw', args)
    )

    register(
        'peer_respond',
        'Answer a task\'s prompt',
        'Approve or deny a permission request (or answer a question) that one of the person\'s task sessions is waiting on. Inspect the session first so you know what you are approving. Always asks the person to confirm, every time.',
        AssistantToolPeerRespondSchema,
        async (args) => await post('/peer-respond', args)
    )
}
