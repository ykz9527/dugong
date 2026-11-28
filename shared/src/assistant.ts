import { z } from 'zod'
import { normalizeWorkspacePath } from './workspaceUser'
import { AttachmentMetadataSchema } from './schemas'
import { isObject } from './utils'

/**
 * The task assistant: one permanent agent session per workspace user, plus a
 * memory both the person and the agent can read and edit.
 *
 * Memory is entries, not a transcript. Each entry says one thing, carries a
 * one-line description that goes into the index the agent always sees, and a
 * body it reads only when the description says it is relevant. The person sees
 * the same entries the agent does, so "what does it remember about me" has a
 * literal answer. The rules for writing it are in the assistant's system prompt.
 */

/**
 * Who an entry is for. `user` follows the person into every task; `repo` is
 * shared by every task in one source repository; `task` lives and dies with a
 * single card. The middle one exists because "check the schema before a
 * release" is too narrow for the person and too wide for one task.
 */
export const ASSISTANT_MEMORY_SCOPES = ['user', 'repo', 'task'] as const
export const AssistantMemoryScopeSchema = z.enum(ASSISTANT_MEMORY_SCOPES)
export type AssistantMemoryScope = z.infer<typeof AssistantMemoryScopeSchema>

/** Same four kinds as Claude Code's own auto-memory. */
export const ASSISTANT_MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export const AssistantMemoryTypeSchema = z.enum(ASSISTANT_MEMORY_TYPES)
export type AssistantMemoryType = z.infer<typeof AssistantMemoryTypeSchema>

export const AssistantMemoryAuthorSchema = z.enum(['ai', 'human'])
export type AssistantMemoryAuthor = z.infer<typeof AssistantMemoryAuthorSchema>

export const ASSISTANT_MEMORY_NAME_MAX_LENGTH = 80
export const ASSISTANT_MEMORY_DESCRIPTION_MAX_LENGTH = 200
export const ASSISTANT_MEMORY_BODY_MAX_LENGTH = 8000

/** The fields an undo puts back. */
export const AssistantMemorySnapshotSchema = z.object({
    scope: AssistantMemoryScopeSchema,
    scopeRef: z.string(),
    name: z.string(),
    description: z.string(),
    type: AssistantMemoryTypeSchema,
    body: z.string(),
    lastEditedBy: AssistantMemoryAuthorSchema
})
export type AssistantMemorySnapshot = z.infer<typeof AssistantMemorySnapshotSchema>

export const AssistantMemorySchema = z.object({
    id: z.string(),
    namespace: z.string(),
    workspaceUserId: z.string(),
    scope: AssistantMemoryScopeSchema,
    /** user: the workspace user id; repo: the source repo path; task: the task id. */
    scopeRef: z.string(),
    name: z.string(),
    description: z.string(),
    type: AssistantMemoryTypeSchema,
    body: z.string(),
    createdBy: AssistantMemoryAuthorSchema,
    lastEditedBy: AssistantMemoryAuthorSchema,
    /** The message that wrote it, when the assistant did. The session is
     *  permanent, so the session id alone would point at everything. */
    source: z.object({
        sessionId: z.string(),
        messageSeq: z.number().nullable()
    }).nullable(),
    /**
     * The version before the assistant's latest edit, kept until the person
     * keeps or edits the entry. One slot, not a history: it exists so an
     * edit the person did not ask for is one click to take back.
     */
    previous: AssistantMemorySnapshotSchema.nullable(),
    createdAt: z.number(),
    updatedAt: z.number()
})
export type AssistantMemory = z.infer<typeof AssistantMemorySchema>

const nameField = z.string().trim().min(1).max(ASSISTANT_MEMORY_NAME_MAX_LENGTH)
    .refine((value) => !/[\r\n]/.test(value), 'Name must be a single line')
const descriptionField = z.string().trim().min(1).max(ASSISTANT_MEMORY_DESCRIPTION_MAX_LENGTH)
    .refine((value) => !/[\r\n]/.test(value), 'Description must be a single line')
const bodyField = z.string().max(ASSISTANT_MEMORY_BODY_MAX_LENGTH)
const scopeRefField = z.string().trim().min(1)

export const CreateAssistantMemoryRequestSchema = z.object({
    workspaceUserId: z.string().min(1),
    scope: AssistantMemoryScopeSchema,
    scopeRef: scopeRefField,
    name: nameField,
    description: descriptionField,
    type: AssistantMemoryTypeSchema,
    body: bodyField
})
export type CreateAssistantMemoryRequest = z.infer<typeof CreateAssistantMemoryRequestSchema>

export const UpdateAssistantMemoryRequestSchema = z.object({
    scope: AssistantMemoryScopeSchema.optional(),
    scopeRef: scopeRefField.optional(),
    name: nameField.optional(),
    description: descriptionField.optional(),
    type: AssistantMemoryTypeSchema.optional(),
    body: bodyField.optional(),
    /** "Keep" on an edit the assistant made: drops `previous` without
     *  changing anything else. */
    acceptPrevious: z.literal(true).optional()
}).refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Nothing to update'
).refine(
    (value) => (value.scope === undefined) === (value.scopeRef === undefined),
    'scope and scopeRef change together'
)
export type UpdateAssistantMemoryRequest = z.infer<typeof UpdateAssistantMemoryRequestSchema>

/** Undo; `ifUpdatedAt` undoes one particular write, and only while it is still the latest change. */
export const UndoAssistantMemoryRequestSchema = z.object({
    ifUpdatedAt: z.number().optional()
})
export type UndoAssistantMemoryRequest = z.infer<typeof UndoAssistantMemoryRequestSchema>

export type AssistantMemoryListResponse = { memories: AssistantMemory[] }
export type AssistantMemoryResponse = { memory: AssistantMemory }
export type AssistantMemoryUndoResponse =
    | { outcome: 'restored'; memory: AssistantMemory }
    | { outcome: 'deleted'; memoryId: string }

/**
 * A standing "yes" for one tool. The assistant session never ends, so "allow
 * for this session" would silently mean "allow forever"; grants make that
 * explicit, visible, and revocable.
 */
export const AssistantGrantSchema = z.object({
    id: z.string(),
    workspaceUserId: z.string(),
    tool: z.string(),
    createdAt: z.number()
})
export type AssistantGrant = z.infer<typeof AssistantGrantSchema>
export type AssistantGrantListResponse = { grants: AssistantGrant[] }

/**
 * A decision the assistant made on its own and wants checked when the person
 * has time. It does not wait for the answer: it goes on with `chosen`, and only an answer that differs sends it
 * back to undo and redo.
 */
export const ASSISTANT_QUESTION_STATUSES = ['open', 'confirmed', 'overridden', 'withdrawn'] as const
export const AssistantQuestionStatusSchema = z.enum(ASSISTANT_QUESTION_STATUSES)
export type AssistantQuestionStatus = z.infer<typeof AssistantQuestionStatusSchema>

export const ASSISTANT_QUESTION_TEXT_MAX_LENGTH = 2000
export const ASSISTANT_QUESTION_MAX_OPTIONS = 6

export const AssistantQuestionSchema = z.object({
    id: z.string(),
    namespace: z.string(),
    workspaceUserId: z.string(),
    /** The card it is about, if any. */
    taskId: z.string().nullable(),
    question: z.string(),
    options: z.array(z.string()),
    /** What the assistant went ahead with; one of `options`. */
    chosen: z.string(),
    rationale: z.string(),
    /** How to take it back if the person picks something else. */
    rollback: z.string(),
    status: AssistantQuestionStatusSchema,
    /** The person's pick, or their own words. */
    answer: z.string().nullable(),
    source: z.object({
        sessionId: z.string(),
        messageSeq: z.number().nullable()
    }).nullable(),
    createdAt: z.number(),
    answeredAt: z.number().nullable()
})
export type AssistantQuestion = z.infer<typeof AssistantQuestionSchema>
export type AssistantQuestionListResponse = { questions: AssistantQuestion[] }
export type AssistantQuestionResponse = { question: AssistantQuestion }

const questionTextField = z.string().trim().min(1).max(ASSISTANT_QUESTION_TEXT_MAX_LENGTH)

export const AnswerAssistantQuestionRequestSchema = z.object({
    answer: questionTextField
})
export type AnswerAssistantQuestionRequest = z.infer<typeof AnswerAssistantQuestionRequestSchema>
/** `reworkError`: the answer differed but the assistant could not be told. */
export type AnswerAssistantQuestionResponse = { question: AssistantQuestion; reworkError: string | null }

/** `question_add` from the assistant. */
export const AssistantToolQuestionAddSchema = z.object({
    question: questionTextField.describe('The decision, as a question the person can answer without reading the chat'),
    options: z.array(questionTextField).min(2).max(ASSISTANT_QUESTION_MAX_OPTIONS).describe('The reasonable choices, short labels'),
    chosen: questionTextField.describe('The option you went ahead with; must be one of options'),
    rationale: questionTextField.describe('Why you chose it, one or two sentences'),
    rollback: questionTextField.describe('How to undo it if the person picks another option: commits, files, steps'),
    taskId: z.string().trim().min(1).optional().describe('The task this is about, if any')
}).refine((value) => value.options.includes(value.chosen), 'chosen must be one of options')
export type AssistantToolQuestionAdd = z.infer<typeof AssistantToolQuestionAddSchema>

/**
 * Talk to the person's assistant. The hub finds (or reopens, or starts) their
 * one session and tells it what is in view when that changed.
 */
export const SendAssistantMessageRequestSchema = z.object({
    workspaceUserId: z.string().min(1),
    text: z.string(),
    localId: z.string().min(1).optional(),
    attachments: z.array(AttachmentMetadataSchema).optional(),
    /** The task selected in the sidebar; absent or null for the task list. */
    contextTaskId: z.string().min(1).nullable().optional()
}).refine((value) => value.text.trim().length > 0 || (value.attachments?.length ?? 0) > 0, 'Message requires text or attachments')
export type SendAssistantMessageRequest = z.infer<typeof SendAssistantMessageRequestSchema>
export type SendAssistantMessageResponse = { sessionId: string; contextSent: boolean }

/**
 * Find, reopen or start the person's assistant without sending anything, so
 * a file can be uploaded to the machine it runs on before the message goes.
 */
export const OpenAssistantSessionRequestSchema = z.object({
    workspaceUserId: z.string().min(1),
    contextTaskId: z.string().min(1).nullable().optional()
})
export type OpenAssistantSessionRequest = z.infer<typeof OpenAssistantSessionRequestSchema>
export type OpenAssistantSessionResponse = { sessionId: string }
export type AssistantSessionResponse = {
    sessionId: string | null
    agent: AssistantAgent
    /** The machine the person pinned the assistant to; null picks one automatically. */
    machineId: string | null
    /** Where the conversation that `sessionId` names lives, if known. */
    sessionMachineId: string | null
}

/** The coding agents that can back the assistant; each person picks one. */
export const ASSISTANT_AGENTS = ['claude', 'codex', 'agy'] as const
export type AssistantAgent = typeof ASSISTANT_AGENTS[number]
export const DEFAULT_ASSISTANT_AGENT: AssistantAgent = 'claude'

/**
 * Switch the agent behind the person's assistant. Each agent keeps its own
 * conversation; memory, questions and grants are shared across them.
 */
export const SetAssistantAgentRequestSchema = z.object({
    workspaceUserId: z.string().min(1),
    agent: z.enum(ASSISTANT_AGENTS)
})
export type SetAssistantAgentRequest = z.infer<typeof SetAssistantAgentRequestSchema>

/**
 * Pin the person's assistant to a machine, or `null` for automatic. Each
 * machine keeps its own conversation; memory, questions and grants are shared.
 */
export const SetAssistantMachineRequestSchema = z.object({
    workspaceUserId: z.string().min(1),
    machineId: z.string().min(1).nullable()
})
export type SetAssistantMachineRequest = z.infer<typeof SetAssistantMachineRequestSchema>

/**
 * The assistant's tools that act on other work: each asks the person first.
 * Bare names; Claude sees them as `mcp__hapi__<name>`.
 */
export const ASSISTANT_CONFIRM_TOOLS = ['ping_peer', 'task_start', 'task_cancel', 'task_move', 'peer_respond'] as const
export type AssistantConfirmTool = typeof ASSISTANT_CONFIRM_TOOLS[number]

/**
 * Confirm-first tools the person is asked about every single time: never
 * granted for good, never allowed "for this session" (the assistant's session
 * never ends). Answering another session's permission prompt is the person's
 * own call each time.
 */
export const ASSISTANT_ALWAYS_ASK_TOOLS = ['peer_respond'] as const satisfies readonly AssistantConfirmTool[]

export function toAssistantToolId(name: string): string {
    return `mcp__hapi__${name}`
}

function isAlwaysAskName(name: string): boolean {
    return (ASSISTANT_ALWAYS_ASK_TOOLS as readonly string[]).includes(name)
}

/** A confirm-first tool the person may say yes to for good. */
export function isAssistantGrantableTool(toolId: string): boolean {
    return ASSISTANT_CONFIRM_TOOLS.some((name) => !isAlwaysAskName(name) && toAssistantToolId(name) === toolId)
}

export function isAssistantAlwaysAskTool(toolId: string): boolean {
    return ASSISTANT_ALWAYS_ASK_TOOLS.some((name) => toAssistantToolId(name) === toolId)
}

/**
 * The `mcp__hapi__<name>` id of the hub tool a permission request is for, or
 * null when it is not one. Claude names the tool that way already; Codex
 * names it bare and carries the server in the request input.
 */
export function assistantRequestToolId(tool: string, input: unknown): string | null {
    if (tool.startsWith('mcp__hapi__')) return tool
    if (isObject(input) && input.serverName === 'hapi') return toAssistantToolId(tool)
    return null
}

/** kebab-case, so entries can point at each other as [[name]]. */
export const ASSISTANT_MEMORY_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** `memory_write` from the assistant: create, or update the entry with the same name in the same place. */
/** repo: the source repo path; task: the task id; user: ignored. */
const toolScopeRefField = z.string().trim().min(1).optional().describe(
    'Where the entry lives: the source repo path for scope "repo", the task id for scope "task". Omit for "user".'
)

/**
 * The assistant's tool inputs. Shared by the hub, which validates them, and
 * the CLI, which registers them with the model — so their descriptions are
 * written for the model.
 */
export const AssistantToolMemoryWriteSchema = z.object({
    scope: AssistantMemoryScopeSchema,
    scopeRef: toolScopeRefField,
    name: z.string().trim().regex(ASSISTANT_MEMORY_NAME_PATTERN, 'name must be kebab-case').max(ASSISTANT_MEMORY_NAME_MAX_LENGTH)
        .describe('kebab-case identifier, unique in its scope'),
    description: descriptionField.describe('One line, specific enough to decide relevance from'),
    type: AssistantMemoryTypeSchema,
    body: bodyField.describe('The entry itself')
})
export type AssistantToolMemoryWrite = z.infer<typeof AssistantToolMemoryWriteSchema>

/** Which entry: name plus where it lives. */
export const AssistantToolMemoryRefSchema = z.object({
    scope: AssistantMemoryScopeSchema.optional(),
    scopeRef: toolScopeRefField,
    name: z.string().trim().min(1)
})
export type AssistantToolMemoryRef = z.infer<typeof AssistantToolMemoryRefSchema>

/** `peer_respond`: answer a permission request one of the person's task sessions is waiting on. */
export const AssistantToolPeerRespondSchema = z.object({
    targetSessionId: z.string().min(1).describe('The task\'s session id'),
    requestId: z.string().min(1).describe('The pending request\'s id (tool call id), from inspect_peer'),
    decision: z.enum(['approve', 'deny']),
    answers: z.record(z.string(), z.array(z.string())).optional().describe('For a question: answers keyed by question')
})
export type AssistantToolPeerRespond = z.infer<typeof AssistantToolPeerRespondSchema>

/**
 * Messages the hub sends into an assistant session on its own (curate memory,
 * then compact). Clients show them as a system notice, not as the person's
 * words, and no push goes out for the turns they start.
 */
export const ASSISTANT_CURATE_MARKER = '[dugong:curate-memory]'
/** The person answered a question differently from what the assistant chose. */
export const ASSISTANT_ANSWER_MARKER = '[dugong:answer-changed]'
export const ASSISTANT_COMPACT_COMMAND = '/compact'

export function assistantSystemNoticeKind(text: string): 'curate' | 'compact' | 'answer' | null {
    const trimmed = text.trim()
    if (trimmed.startsWith(ASSISTANT_CURATE_MARKER)) return 'curate'
    if (trimmed.startsWith(ASSISTANT_ANSWER_MARKER)) return 'answer'
    if (trimmed === ASSISTANT_COMPACT_COMMAND) return 'compact'
    return null
}

/** The line a chat shows for an answer notice: "question → answer". */
export function assistantAnswerSummary(text: string): string {
    return text.trim().split('\n')[0].slice(ASSISTANT_ANSWER_MARKER.length).trim()
}

/**
 * What the hub tells the assistant about the task in view goes in a
 * `<task-context>` fence in front of the person's words. Task titles, prompts,
 * errors and memory descriptions are written by people and agents; a
 * `</task-context>` inside them would end the fence early and pass the rest
 * off as the person's own words. This defuses any such tag (it stays
 * readable, it just is not a tag any more).
 */
export function neutraliseTaskContextTags(text: string): string {
    return text.replace(/<(\s*\/?\s*task-context\b[^>]*)>/gi, '‹$1›')
}

/** A task's repo, as `repo` memories key it: the source repository it runs from. */
export function assistantRepoKey(workdir: string): string {
    return normalizeWorkspacePath(workdir)
}

/**
 * Is `memory` relevant while the assistant looks at this task? Every user
 * entry is; repo entries for the task's repo; task entries for the task. With
 * no task in view only the user's own entries are.
 */
export function isAssistantMemoryInContext(
    memory: Pick<AssistantMemory, 'scope' | 'scopeRef'>,
    context: { taskId: string | null; repo: string | null }
): boolean {
    switch (memory.scope) {
        case 'user':
            return true
        case 'repo':
            return context.repo !== null && memory.scopeRef === context.repo
        case 'task':
            return context.taskId !== null && memory.scopeRef === context.taskId
    }
}
