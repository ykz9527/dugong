import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import {
    ASSISTANT_AGENTS,
    AssistantMemorySnapshotSchema,
    DEFAULT_ASSISTANT_AGENT,
    isAssistantGrantableTool,
    type AssistantAgent,
    type AssistantMemoryAuthor,
    type AssistantMemoryScope,
    type AssistantMemorySnapshot,
    type AssistantMemoryType,
    type AssistantQuestionStatus
} from '@hapi/protocol'
import { safeJsonParse } from './json'
import type { StoredAssistantGrant, StoredAssistantMemory, StoredAssistantQuestion } from './types'

/**
 * Task assistant storage (schema v30, v31): memory entries, standing tool
 * grants, questions for later, and which session is a workspace user's
 * assistant.
 *
 * Memories and questions are scoped by namespace *and* workspace user; the
 * assistant's tools never name the user — the hub resolves it from the
 * calling session — so these functions are the line that keeps one person's
 * assistant out of another person's memory. Grants are keyed by workspace
 * user only (ids are unique across namespaces): callers must have resolved
 * the user within their own namespace first.
 */

type DbMemoryRow = {
    id: string
    namespace: string
    workspace_user_id: string
    scope: string
    scope_ref: string
    name: string
    description: string
    type: string
    body: string
    created_by: string
    last_edited_by: string
    source_session_id: string | null
    source_message_seq: number | null
    previous_json: string | null
    created_at: number
    updated_at: number
}

type DbGrantRow = {
    id: string
    workspace_user_id: string
    tool: string
    created_at: number
}

/** `UNIQUE (workspace_user_id, scope, scope_ref, name)` tripped. */
export class AssistantMemoryNameTakenError extends Error {
    constructor(name: string) {
        super(`A memory named "${name}" already exists here`)
        this.name = 'AssistantMemoryNameTakenError'
    }
}

function parsePrevious(json: string | null): AssistantMemorySnapshot | null {
    if (!json) return null
    const parsed = AssistantMemorySnapshotSchema.safeParse(safeJsonParse(json))
    return parsed.success ? parsed.data : null
}

function toStoredMemory(row: DbMemoryRow): StoredAssistantMemory {
    return {
        id: row.id,
        namespace: row.namespace,
        workspaceUserId: row.workspace_user_id,
        scope: row.scope as AssistantMemoryScope,
        scopeRef: row.scope_ref,
        name: row.name,
        description: row.description,
        type: row.type as AssistantMemoryType,
        body: row.body,
        createdBy: row.created_by as AssistantMemoryAuthor,
        lastEditedBy: row.last_edited_by as AssistantMemoryAuthor,
        source: row.source_session_id
            ? { sessionId: row.source_session_id, messageSeq: row.source_message_seq }
            : null,
        previous: parsePrevious(row.previous_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

function snapshotOf(memory: StoredAssistantMemory): AssistantMemorySnapshot {
    return {
        scope: memory.scope,
        scopeRef: memory.scopeRef,
        name: memory.name,
        description: memory.description,
        type: memory.type,
        body: memory.body,
        lastEditedBy: memory.lastEditedBy
    }
}

function isUniqueViolation(error: unknown): boolean {
    return error instanceof Error && /UNIQUE constraint failed: assistant_memories/.test(error.message)
}

export function listAssistantMemories(db: Database, namespace: string, workspaceUserId: string): StoredAssistantMemory[] {
    const rows = db.prepare(
        `SELECT * FROM assistant_memories
         WHERE namespace = ? AND workspace_user_id = ?
         ORDER BY updated_at DESC`
    ).all(namespace, workspaceUserId) as DbMemoryRow[]
    return rows.map(toStoredMemory)
}

export function getAssistantMemory(db: Database, id: string, namespace: string): StoredAssistantMemory | null {
    const row = db.prepare('SELECT * FROM assistant_memories WHERE id = ? AND namespace = ?')
        .get(id, namespace) as DbMemoryRow | null
    return row ? toStoredMemory(row) : null
}

export function getAssistantMemoryByName(
    db: Database,
    namespace: string,
    workspaceUserId: string,
    scope: AssistantMemoryScope,
    scopeRef: string,
    name: string
): StoredAssistantMemory | null {
    const row = db.prepare(
        `SELECT * FROM assistant_memories
         WHERE namespace = ? AND workspace_user_id = ? AND scope = ? AND scope_ref = ? AND name = ?`
    ).get(namespace, workspaceUserId, scope, scopeRef, name) as DbMemoryRow | null
    return row ? toStoredMemory(row) : null
}

export type CreateAssistantMemoryInput = {
    namespace: string
    workspaceUserId: string
    scope: AssistantMemoryScope
    scopeRef: string
    name: string
    description: string
    type: AssistantMemoryType
    body: string
    author: AssistantMemoryAuthor
    source?: { sessionId: string; messageSeq: number | null } | null
}

export function createAssistantMemory(db: Database, input: CreateAssistantMemoryInput): StoredAssistantMemory {
    const id = randomUUID()
    const now = Date.now()
    try {
        db.prepare(
            `INSERT INTO assistant_memories (
                id, namespace, workspace_user_id, scope, scope_ref, name, description, type, body,
                created_by, last_edited_by, source_session_id, source_message_seq, previous_json,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        ).run(
            id, input.namespace, input.workspaceUserId, input.scope, input.scopeRef, input.name,
            input.description, input.type, input.body, input.author, input.author,
            input.source?.sessionId ?? null, input.source?.messageSeq ?? null, now, now
        )
    } catch (error) {
        if (isUniqueViolation(error)) throw new AssistantMemoryNameTakenError(input.name)
        throw error
    }
    return getAssistantMemory(db, id, input.namespace) as StoredAssistantMemory
}

export type AssistantMemoryPatch = {
    scope?: AssistantMemoryScope
    scopeRef?: string
    name?: string
    description?: string
    type?: AssistantMemoryType
    body?: string
}

/**
 * Edit an entry.
 *
 * An edit by the assistant keeps the version it replaced in `previous`, so the
 * person can take it back. If an earlier assistant edit is still unreviewed,
 * that older version stays: undo returns to what the person last saw as
 * settled, not to the assistant's own intermediate draft. An edit by the
 * person settles the entry and clears `previous`.
 */
export function updateAssistantMemory(
    db: Database,
    id: string,
    namespace: string,
    patch: AssistantMemoryPatch,
    author: AssistantMemoryAuthor,
    source?: { sessionId: string; messageSeq: number | null } | null
): StoredAssistantMemory | null {
    const current = getAssistantMemory(db, id, namespace)
    if (!current) return null

    const previous = author === 'ai'
        ? current.previous ?? snapshotOf(current)
        : null
    const next = {
        scope: patch.scope ?? current.scope,
        scopeRef: patch.scopeRef ?? current.scopeRef,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        type: patch.type ?? current.type,
        body: patch.body ?? current.body
    }
    try {
        db.prepare(
            `UPDATE assistant_memories SET
                scope = ?, scope_ref = ?, name = ?, description = ?, type = ?, body = ?,
                last_edited_by = ?, previous_json = ?,
                source_session_id = COALESCE(?, source_session_id),
                source_message_seq = CASE WHEN ? IS NULL THEN source_message_seq ELSE ? END,
                updated_at = ?
             WHERE id = ? AND namespace = ?`
        ).run(
            next.scope, next.scopeRef, next.name, next.description, next.type, next.body,
            author, previous ? JSON.stringify(previous) : null,
            source?.sessionId ?? null,
            source?.sessionId ?? null, source?.messageSeq ?? null,
            Date.now(), id, namespace
        )
    } catch (error) {
        if (isUniqueViolation(error)) throw new AssistantMemoryNameTakenError(next.name)
        throw error
    }
    return getAssistantMemory(db, id, namespace)
}

/**
 * "Keep" on an assistant edit: the entry stays as it is, the undo slot goes,
 * and the person now owns this version — so an undo from the chat card that
 * wrote it has nothing left to take back.
 */
export function acceptAssistantMemory(db: Database, id: string, namespace: string): StoredAssistantMemory | null {
    db.prepare(
        `UPDATE assistant_memories SET previous_json = NULL, last_edited_by = 'human', updated_at = ?
         WHERE id = ? AND namespace = ?`
    ).run(Date.now(), id, namespace)
    return getAssistantMemory(db, id, namespace)
}

export function deleteAssistantMemory(db: Database, id: string, namespace: string): boolean {
    const result = db.prepare('DELETE FROM assistant_memories WHERE id = ? AND namespace = ?').run(id, namespace)
    return result.changes > 0
}

export type AssistantMemoryUndoResult =
    | { outcome: 'restored'; memory: StoredAssistantMemory }
    | { outcome: 'deleted' }
    | { outcome: 'nothing-to-undo' }
    | { outcome: 'changed' }
    | { outcome: 'not-found' }

/**
 * Take back the assistant's last change: restore `previous` if there is one;
 * otherwise, if the assistant wrote the entry from scratch, remove it. A
 * settled entry has nothing to undo. `ifUpdatedAt` is for undoing one
 * particular write: if the entry changed since, that write is not the last
 * change any more and nothing happens.
 */
export function undoAssistantMemory(
    db: Database,
    id: string,
    namespace: string,
    ifUpdatedAt?: number
): AssistantMemoryUndoResult {
    const current = getAssistantMemory(db, id, namespace)
    if (!current) return { outcome: 'not-found' }
    if (ifUpdatedAt !== undefined && current.updatedAt !== ifUpdatedAt) return { outcome: 'changed' }

    if (current.previous) {
        const previous = current.previous
        try {
            db.prepare(
                `UPDATE assistant_memories SET
                    scope = ?, scope_ref = ?, name = ?, description = ?, type = ?, body = ?,
                    last_edited_by = ?, previous_json = NULL, updated_at = ?
                 WHERE id = ? AND namespace = ?`
            ).run(
                previous.scope, previous.scopeRef, previous.name, previous.description, previous.type,
                previous.body, previous.lastEditedBy, Date.now(), id, namespace
            )
        } catch (error) {
            if (isUniqueViolation(error)) throw new AssistantMemoryNameTakenError(previous.name)
            throw error
        }
        return { outcome: 'restored', memory: getAssistantMemory(db, id, namespace) as StoredAssistantMemory }
    }

    if (current.createdBy === 'ai' && current.lastEditedBy === 'ai') {
        deleteAssistantMemory(db, id, namespace)
        return { outcome: 'deleted' }
    }
    return { outcome: 'nothing-to-undo' }
}

// --- Grants -----------------------------------------------------------------

function toStoredGrant(row: DbGrantRow): StoredAssistantGrant {
    return {
        id: row.id,
        workspaceUserId: row.workspace_user_id,
        tool: row.tool,
        createdAt: row.created_at
    }
}

/**
 * The person's standing grants. Rows for tools that are not (or no longer)
 * grantable are dropped here rather than filtered, so a tool moved to
 * always-ask cannot linger as a grant anywhere.
 */
export function listAssistantGrants(db: Database, workspaceUserId: string): StoredAssistantGrant[] {
    const rows = db.prepare(
        'SELECT * FROM assistant_grants WHERE workspace_user_id = ? ORDER BY created_at ASC'
    ).all(workspaceUserId) as DbGrantRow[]
    const stale = rows.filter((row) => !isAssistantGrantableTool(row.tool))
    for (const row of stale) {
        db.prepare('DELETE FROM assistant_grants WHERE id = ?').run(row.id)
    }
    return rows.filter((row) => isAssistantGrantableTool(row.tool)).map(toStoredGrant)
}

/** Idempotent: granting a tool twice returns the first grant. Throws for a tool that is not grantable. */
export function addAssistantGrant(db: Database, workspaceUserId: string, tool: string): StoredAssistantGrant {
    if (!isAssistantGrantableTool(tool)) {
        throw new Error(`${tool} cannot be granted for good`)
    }
    db.prepare(
        `INSERT INTO assistant_grants (id, workspace_user_id, tool, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_user_id, tool) DO NOTHING`
    ).run(randomUUID(), workspaceUserId, tool, Date.now())
    const row = db.prepare('SELECT * FROM assistant_grants WHERE workspace_user_id = ? AND tool = ?')
        .get(workspaceUserId, tool) as DbGrantRow
    return toStoredGrant(row)
}

/** Only grantable tools count: an old row for an always-ask tool grants nothing. */
export function hasAssistantGrant(db: Database, workspaceUserId: string, tool: string): boolean {
    if (!isAssistantGrantableTool(tool)) return false
    return db.prepare('SELECT 1 FROM assistant_grants WHERE workspace_user_id = ? AND tool = ?')
        .get(workspaceUserId, tool) !== null
}

export function deleteAssistantGrant(db: Database, id: string, workspaceUserId: string): boolean {
    const result = db.prepare('DELETE FROM assistant_grants WHERE id = ? AND workspace_user_id = ?')
        .run(id, workspaceUserId)
    return result.changes > 0
}

// --- The assistant session ---------------------------------------------------

export function getAssistantSessionId(db: Database, workspaceUserId: string, namespace: string): string | null {
    const row = db.prepare('SELECT assistant_session_id FROM workspace_users WHERE id = ? AND namespace = ?')
        .get(workspaceUserId, namespace) as { assistant_session_id: string | null } | null
    return row?.assistant_session_id ?? null
}

export function setAssistantSessionId(
    db: Database,
    workspaceUserId: string,
    namespace: string,
    sessionId: string | null
): boolean {
    const result = db.prepare('UPDATE workspace_users SET assistant_session_id = ? WHERE id = ? AND namespace = ?')
        .run(sessionId, workspaceUserId, namespace)
    return result.changes > 0
}

export function getAssistantAgent(db: Database, workspaceUserId: string, namespace: string): AssistantAgent {
    const row = db.prepare('SELECT assistant_agent FROM workspace_users WHERE id = ? AND namespace = ?')
        .get(workspaceUserId, namespace) as { assistant_agent: string | null } | null
    const agent = row?.assistant_agent
    return (ASSISTANT_AGENTS as readonly string[]).includes(agent ?? '') ? agent as AssistantAgent : DEFAULT_ASSISTANT_AGENT
}

export function setAssistantAgent(db: Database, workspaceUserId: string, namespace: string, agent: AssistantAgent): boolean {
    const result = db.prepare('UPDATE workspace_users SET assistant_agent = ? WHERE id = ? AND namespace = ?')
        .run(agent, workspaceUserId, namespace)
    return result.changes > 0
}

// --- Questions for later (schema v31) -----------------------------------------

type DbQuestionRow = {
    id: string
    namespace: string
    workspace_user_id: string
    task_id: string | null
    question: string
    options_json: string
    chosen: string
    rationale: string
    rollback: string
    status: string
    answer: string | null
    source_session_id: string | null
    source_message_seq: number | null
    created_at: number
    answered_at: number | null
}

function toStoredQuestion(row: DbQuestionRow): StoredAssistantQuestion {
    const options = safeJsonParse(row.options_json)
    return {
        id: row.id,
        namespace: row.namespace,
        workspaceUserId: row.workspace_user_id,
        taskId: row.task_id,
        question: row.question,
        options: Array.isArray(options) ? options.filter((option): option is string => typeof option === 'string') : [],
        chosen: row.chosen,
        rationale: row.rationale,
        rollback: row.rollback,
        status: row.status as AssistantQuestionStatus,
        answer: row.answer,
        source: row.source_session_id
            ? { sessionId: row.source_session_id, messageSeq: row.source_message_seq }
            : null,
        createdAt: row.created_at,
        answeredAt: row.answered_at
    }
}

/** Open questions first (oldest first: they have waited longest), then the rest, newest first. */
export function listAssistantQuestions(db: Database, namespace: string, workspaceUserId: string): StoredAssistantQuestion[] {
    const rows = db.prepare(
        `SELECT * FROM assistant_questions
         WHERE namespace = ? AND workspace_user_id = ?
         ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
                  CASE status WHEN 'open' THEN created_at ELSE -COALESCE(answered_at, created_at) END`
    ).all(namespace, workspaceUserId) as DbQuestionRow[]
    return rows.map(toStoredQuestion)
}

export function getAssistantQuestion(db: Database, id: string, namespace: string): StoredAssistantQuestion | null {
    const row = db.prepare('SELECT * FROM assistant_questions WHERE id = ? AND namespace = ?')
        .get(id, namespace) as DbQuestionRow | null
    return row ? toStoredQuestion(row) : null
}

export type CreateAssistantQuestionInput = {
    namespace: string
    workspaceUserId: string
    taskId: string | null
    question: string
    options: string[]
    chosen: string
    rationale: string
    rollback: string
    source?: { sessionId: string; messageSeq: number | null } | null
}

export function createAssistantQuestion(db: Database, input: CreateAssistantQuestionInput): StoredAssistantQuestion {
    const id = randomUUID()
    db.prepare(
        `INSERT INTO assistant_questions (
            id, namespace, workspace_user_id, task_id, question, options_json, chosen, rationale, rollback,
            status, answer, source_session_id, source_message_seq, created_at, answered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?, NULL)`
    ).run(
        id, input.namespace, input.workspaceUserId, input.taskId, input.question, JSON.stringify(input.options),
        input.chosen, input.rationale, input.rollback,
        input.source?.sessionId ?? null, input.source?.messageSeq ?? null, Date.now()
    )
    return getAssistantQuestion(db, id, input.namespace) as StoredAssistantQuestion
}

/**
 * Close an open question. Only an open one: two answers racing (phone and
 * desktop) must not send the assistant back to redo twice. Null when it was
 * not open any more.
 */
export function closeAssistantQuestion(
    db: Database,
    id: string,
    namespace: string,
    status: Exclude<AssistantQuestionStatus, 'open'>,
    answer: string | null
): StoredAssistantQuestion | null {
    const result = db.prepare(
        `UPDATE assistant_questions SET status = ?, answer = ?, answered_at = ?
         WHERE id = ? AND namespace = ? AND status = 'open'`
    ).run(status, answer, Date.now(), id, namespace)
    return result.changes > 0 ? getAssistantQuestion(db, id, namespace) : null
}
