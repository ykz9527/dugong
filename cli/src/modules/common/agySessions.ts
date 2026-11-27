import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
    AgyImportedMessage,
    AgyLocalSessionSummary,
    AgyLocalSessionWithMessages,
    AgyTranscriptCursor,
    ClaudeSessionHolder
} from '@hapi/protocol/apiTypes'
import { truncateOversizedMessageContent } from '@hapi/protocol/messageTruncation'
import { normalizeNativeSessionTitle } from '@/agent/nativeSessionTitle'
import { agySessionHolders } from './agySessionHolders'
import { detectWorktreeOrigin } from './worktreeOrigin'

/**
 * Discovery and history for Antigravity (agy) conversations started outside
 * dugong, so the board can adopt one.
 *
 * Strictly read-only: agy's data directory is shared by everyone on the
 * account, and every SQLite file here is opened `readonly`.
 *
 * - The listing reads one table, `conversation_summaries` in
 *   `conversation_summaries.db`: id, title, first prompt (`preview`), step
 *   count, last write and workspace per conversation.
 * - History is in `conversations/<id>.db`, one protobuf row per step, with no
 *   published schema. The few fields used here were mapped against every
 *   conversation on a busy machine (see `decodeAgyStep`); anything that does
 *   not decode is skipped, never guessed at.
 */

const DEFAULT_AGY_SESSION_LIST_LIMIT = 100

/** agy's step types. Only these carry conversation; the rest (system
 *  messages, checkpoints, …) are bookkeeping. */
const STEP_USER_INPUT = 14
const STEP_PLANNER_RESPONSE = 15
/** A tool step whose run ended in an error; its message is in field 31. */
const STEP_STATUS_ERROR = 7
/** A tool step that never ran (denied, cancelled). */
const STEP_STATUS_CANCELLED = 6

/** Steps read per query while filling an import page. */
const STEP_BATCH = 200
/** Stored JSON one import page may carry; far under the hub's socket buffer. */
const IMPORT_PAGE_BUDGET_CHARS = 8 * 1024 * 1024

export function getAgyHome(): string {
    return join(homedir(), '.gemini', 'antigravity-cli')
}

export type AgySummaryRow = {
    conversation_id: string
    title: string
    preview: string
    step_count: number
    last_modified_time: string
    workspace_uris: string
    parent_conversation_id: string
    nesting_depth: number
}

export type AgyStepRow = {
    idx: number
    step_type: number
    status: number
    metadata: Uint8Array | null
    step_payload: Uint8Array | null
}

/** How the module reaches agy's SQLite files; replaced in tests. */
export type AgyStore = {
    summaries(): Promise<AgySummaryRow[]>
    /** Steps with `idx >= fromIdx`, in order, at most `limit`. */
    steps(conversationId: string, fromIdx: number, limit: number): Promise<AgyStepRow[]>
    lastUserStep(conversationId: string): Promise<AgyStepRow | null>
}

function conversationFile(agyHome: string, id: string): string {
    return join(agyHome, 'conversations', `${id}.db`)
}

async function withDatabase<T>(path: string, read: (db: import('bun:sqlite').Database) => T): Promise<T> {
    const { Database } = await import('bun:sqlite')
    const db = new Database(path, { readonly: true })
    try {
        return read(db)
    } finally {
        db.close()
    }
}

export function sqliteAgyStore(agyHome: string): AgyStore {
    return {
        summaries: () => withDatabase(join(agyHome, 'conversation_summaries.db'), (db) => db.query(`
            SELECT conversation_id, title, preview, step_count, last_modified_time,
                   workspace_uris, parent_conversation_id, nesting_depth
            FROM conversation_summaries
        `).all() as AgySummaryRow[]),
        steps: (id, fromIdx, limit) => withDatabase(conversationFile(agyHome, id), (db) => db.query(`
            SELECT idx, step_type, status, metadata, step_payload
            FROM steps WHERE idx >= ? ORDER BY idx LIMIT ?
        `).all(fromIdx, limit) as AgyStepRow[]),
        lastUserStep: (id) => withDatabase(conversationFile(agyHome, id), (db) => db.query(`
            SELECT idx, step_type, status, metadata, step_payload
            FROM steps WHERE step_type = ? ORDER BY idx DESC LIMIT 1
        `).get(STEP_USER_INPUT) as AgyStepRow | null)
    }
}

// ---------------------------------------------------------------------------
// Protobuf, just enough of it: length-delimited fields by number, nothing typed.

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } | null {
    let value = 0
    let multiplier = 1
    for (let offset = start; offset < bytes.length && offset < start + 10; offset++) {
        const byte = bytes[offset]!
        value += (byte & 0x7f) * multiplier
        if (!Number.isSafeInteger(value)) return null
        if ((byte & 0x80) === 0) return { value, next: offset + 1 }
        multiplier *= 128
    }
    return null
}

type Fields = { bytes: Map<number, Uint8Array[]>; ints: Map<number, number> }

function parseFields(bytes: Uint8Array): Fields | null {
    const fields: Fields = { bytes: new Map(), ints: new Map() }
    let offset = 0
    while (offset < bytes.length) {
        const tag = readVarint(bytes, offset)
        if (!tag || tag.value === 0) return null
        offset = tag.next
        const field = Math.floor(tag.value / 8)
        const wire = tag.value & 7
        if (wire === 2) {
            const length = readVarint(bytes, offset)
            if (!length) return null
            const end = length.next + length.value
            if (end > bytes.length) return null
            const list = fields.bytes.get(field) ?? []
            list.push(bytes.subarray(length.next, end))
            fields.bytes.set(field, list)
            offset = end
        } else if (wire === 0) {
            const value = readVarint(bytes, offset)
            if (!value) return null
            if (!fields.ints.has(field)) fields.ints.set(field, value.value)
            offset = value.next
        } else if (wire === 1) {
            offset += 8
        } else if (wire === 5) {
            offset += 4
        } else {
            return null
        }
    }
    return fields
}

/** The first occurrence of a nested message at `path`. */
function at(bytes: Uint8Array | null | undefined, ...path: number[]): Uint8Array | null {
    let current: Uint8Array | null = bytes ? new Uint8Array(bytes) : null
    for (const field of path) {
        if (!current) return null
        current = parseFields(current)?.bytes.get(field)?.[0] ?? null
    }
    return current
}

function text(bytes: Uint8Array | null | undefined): string | null {
    if (!bytes || bytes.length === 0) return null
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
        return null
    }
}

function parseJson(value: string | null): unknown {
    if (!value) return {}
    try {
        return JSON.parse(value)
    } catch {
        return value
    }
}

/** A step's creation time: `metadata.1` is a protobuf Timestamp. */
function stepCreatedAt(step: AgyStepRow): number | null {
    const timestamp = at(step.metadata, 1)
    const fields = timestamp ? parseFields(timestamp) : null
    const seconds = fields?.ints.get(1)
    if (!seconds) return null
    return seconds * 1000 + Math.floor((fields?.ints.get(2) ?? 0) / 1e6)
}

/** agy prefixes tool output with when it ran; the card has that already. */
function stripRunHeader(output: string): string {
    return output.replace(/^(?:Created At|Completed At):.*(?:\r?\n)?/gm, '').trim()
}

function agentMessage(localId: string, createdAt: number, data: Record<string, unknown>): AgyImportedMessage {
    // The id is the localId, not a fresh uuid: a re-import compares stored
    // content with what the machine sends, and has to see the same bytes.
    return {
        localId,
        createdAt,
        content: { role: 'agent', content: { type: 'codex', data: { ...data, id: localId } }, meta: { sentFrom: 'cli' } }
    }
}

/**
 * The chat messages one agy step stands for.
 *
 * - user input (type 14): the prompt is `payload.19.2`.
 * - planner response (type 15): prose at `payload.20.1`; each tool call is a
 *   `payload.20.7` entry with id (1), tool name (2) and JSON arguments (3).
 * - any other step naming a call at `payload.5.4` (id 1, name 2) is that
 *   call's result: output at `payload.140.2.1`, or an error message at
 *   `payload.31.2` when the step failed.
 *
 * Mapped on one machine's 87 conversations: every prompt and call decoded,
 * and all but three replies; results without output text are the failed and
 * cancelled ones, which is what the two fallbacks cover.
 */
export function decodeAgyStep(step: AgyStepRow, conversationId: string, fallbackAt: number): AgyImportedMessage[] {
    const payload = step.step_payload ? new Uint8Array(step.step_payload) : null
    if (!payload) return []
    const createdAt = stepCreatedAt(step) ?? fallbackAt
    const base = `agy:${conversationId}:${step.idx}`

    if (step.step_type === STEP_USER_INPUT) {
        const prompt = text(at(payload, 19, 2))?.trim()
        return prompt
            ? [{ localId: base, createdAt, content: { role: 'user', content: { type: 'text', text: prompt }, meta: { sentFrom: 'cli' } } }]
            : []
    }

    if (step.step_type === STEP_PLANNER_RESPONSE) {
        const response = at(payload, 20)
        const fields = response ? parseFields(response) : null
        if (!fields) return []
        const messages: AgyImportedMessage[] = []
        const prose = text(fields.bytes.get(1)?.[0])?.trim()
        if (prose) messages.push(agentMessage(base, createdAt, { type: 'message', message: prose }))
        for (const call of fields.bytes.get(7) ?? []) {
            const callFields = parseFields(call)
            const callId = text(callFields?.bytes.get(1)?.[0])
            const name = text(callFields?.bytes.get(2)?.[0])
            if (!callId || !name) continue
            messages.push(agentMessage(`${base}:call:${callId}`, createdAt, {
                type: 'tool-call',
                name,
                callId,
                input: parseJson(text(callFields?.bytes.get(3)?.[0]))
            }))
        }
        return messages
    }

    const call = at(payload, 5, 4)
    const callFields = call ? parseFields(call) : null
    const callId = text(callFields?.bytes.get(1)?.[0])
    if (!callId) return []
    const output = text(at(payload, 140, 2, 1))
    const error = text(at(payload, 31, 2))
    const failed = !output && (step.status === STEP_STATUS_ERROR || step.status === STEP_STATUS_CANCELLED || Boolean(error))
    return [agentMessage(`${base}:result`, createdAt, {
        type: 'tool-call-result',
        callId,
        output: output
            ? stripRunHeader(output)
            : error ?? (step.status === STEP_STATUS_CANCELLED ? 'Not run' : ''),
        ...(failed ? { is_error: true } : {})
    })]
}

// ---------------------------------------------------------------------------
// Listing

function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

/** `2026-11-27 08:57:30.549037033+00:00` → epoch ms; agy's zero time → null. */
function parseAgyTime(value: string): number | null {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2}:\d{2}|Z)?$/.exec(value.trim())
    if (!match || match[1]!.startsWith('0001')) return null
    const fraction = match[3] ? match[3].slice(0, 4) : ''
    const parsed = Date.parse(`${match[1]}T${match[2]}${fraction}${match[4] ?? 'Z'}`)
    return Number.isFinite(parsed) ? parsed : null
}

function firstWorkspace(workspaceUris: string): string | null {
    let uris: unknown
    try {
        uris = JSON.parse(workspaceUris)
    } catch {
        return null
    }
    const first = Array.isArray(uris) ? uris.find((uri) => typeof uri === 'string' && uri.startsWith('file://')) : null
    if (typeof first !== 'string') return null
    try {
        return fileURLToPath(first)
    } catch {
        return null
    }
}

function fileStats(path: string): { size: number; modifiedAt: number } | null {
    try {
        const stats = statSync(path)
        let modifiedAt = stats.mtimeMs
        // An open conversation writes its WAL first; the main file can lag.
        try { modifiedAt = Math.max(modifiedAt, statSync(`${path}-wal`).mtimeMs) } catch {}
        return { size: stats.size, modifiedAt }
    } catch {
        return null
    }
}

/**
 * A listing row from a summary row, or null for what is not a conversation
 * anyone would adopt:
 *  - no steps: a terminal opened and closed, or only slash commands typed;
 *  - a child of another conversation (agy's own subagents);
 *  - a summary whose conversation file is gone.
 */
export function summariseAgyRow(
    row: AgySummaryRow,
    file: string,
    stats: { size: number; modifiedAt: number } | null
): AgyLocalSessionSummary | null {
    if (!row.conversation_id || !(row.step_count > 0)) return null
    if (row.parent_conversation_id || row.nesting_depth > 0) return null
    if (!stats) return null
    const cwd = firstWorkspace(row.workspace_uris)
    const preview = row.preview?.trim() || null
    const title = normalizeNativeSessionTitle(row.title)
        ?? (preview ? truncateText(preview.replace(/\s+/g, ' '), 80) : null)
        ?? (cwd ? basename(cwd) || cwd : null)
        ?? row.conversation_id.slice(0, 8)
    const summaryAt = parseAgyTime(row.last_modified_time)
    return {
        id: row.conversation_id,
        title,
        lastUserMessage: preview ? truncateText(preview, 140) : null,
        cwd,
        file,
        modifiedAt: Math.max(summaryAt ?? 0, stats.modifiedAt),
        size: stats.size
    }
}

function livenessOf(holders: Map<string, ClaudeSessionHolder[]> | null, id: string): Pick<AgyLocalSessionSummary, 'live' | 'holders'> {
    if (!holders) return {}
    const own = holders.get(id)
    return own ? { live: true, holders: own } : { live: false }
}

export type AgySessionSourceOptions = {
    agyHome?: string
    store?: AgyStore
    /** Replaced in tests; defaults to the `/proc` scan. */
    holders?: () => Map<string, ClaudeSessionHolder[]> | null
}

function resolveSource(options: AgySessionSourceOptions) {
    const agyHome = options.agyHome ?? getAgyHome()
    return {
        agyHome,
        store: options.store ?? sqliteAgyStore(agyHome),
        holders: options.holders ?? (() => agySessionHolders({ agyHome }))
    }
}

async function lastPrompt(store: AgyStore, id: string): Promise<string | null> {
    try {
        const step = await store.lastUserStep(id)
        const prompt = step ? decodeAgyStep(step, id, 0)[0] : undefined
        return prompt?.content.role === 'user' ? truncateText(prompt.content.content.text, 140) : null
    } catch {
        return null
    }
}

async function collectSummaries(
    agyHome: string,
    store: AgyStore,
    ids?: ReadonlySet<string>
): Promise<AgyLocalSessionSummary[]> {
    let rows: AgySummaryRow[]
    try {
        rows = await store.summaries()
    } catch {
        // No agy here, or a store it is still creating.
        return []
    }
    return rows
        .filter((row) => !ids || ids.has(row.conversation_id))
        .flatMap((row) => {
            const file = conversationFile(agyHome, row.conversation_id)
            const summary = summariseAgyRow(row, file, existsSync(file) ? fileStats(file) : null)
            return summary ? [summary] : []
        })
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export async function listLocalAgySessionSummaries(options: AgySessionSourceOptions & {
    limit?: number
    /** Whether a session may be shown at all; applied before `limit` counts it. */
    accept?: (session: AgyLocalSessionSummary) => boolean | Promise<boolean>
} = {}): Promise<AgyLocalSessionSummary[]> {
    const limit = options.limit ?? DEFAULT_AGY_SESSION_LIST_LIMIT
    if (limit <= 0) return []
    const { agyHome, store, holders: readHolders } = resolveSource(options)
    const holders = readHolders()
    const sessions: AgyLocalSessionSummary[] = []
    for (const summary of await collectSummaries(agyHome, store)) {
        if (options.accept && !(await options.accept(summary))) continue
        const last = await lastPrompt(store, summary.id)
        sessions.push({ ...summary, ...(last ? { lastUserMessage: last } : {}), ...livenessOf(holders, summary.id) })
        if (sessions.length >= limit) break
    }
    return sessions
}

export const AGY_IMPORT_NOTICE = 'History imported from Antigravity: prompts, replies and tool calls. Some tool output may be missing.'

/** Heads the imported history, so a missing tool output reads as expected. */
function importNotice(conversationId: string, firstAt: number): AgyImportedMessage {
    return {
        localId: `agy:${conversationId}:notice`,
        createdAt: firstAt - 1,
        content: { role: 'agent', content: { type: 'event', data: { type: 'message', message: AGY_IMPORT_NOTICE } }, meta: { sentFrom: 'cli' } }
    }
}

/**
 * One page of each named conversation's history, starting at `cursor`.
 *
 * Without `cursor` this is the first page, and carries what the hub needs to
 * decide on the import (liveness, worktree); with it, `ids` must name one
 * conversation.
 */
export async function listLocalAgySessionsWithMessagesByIds(
    ids: ReadonlySet<string>,
    cursor?: AgyTranscriptCursor,
    options: AgySessionSourceOptions = {}
): Promise<AgyLocalSessionWithMessages[]> {
    if (ids.size === 0) return []
    if (cursor && ids.size !== 1) throw new Error('A transcript cursor applies to exactly one session')
    const { agyHome, store, holders: readHolders } = resolveSource(options)
    const holders = cursor ? null : readHolders()
    const sessions: AgyLocalSessionWithMessages[] = []
    for (const summary of await collectSummaries(agyHome, store, ids)) {
        const messages: AgyImportedMessage[] = []
        let pageChars = 0
        let next = cursor?.stepIndex ?? 0
        let more = true
        while (more && pageChars < IMPORT_PAGE_BUDGET_CHARS) {
            const steps = await store.steps(summary.id, next, STEP_BATCH)
            more = steps.length === STEP_BATCH
            for (const step of steps) {
                next = step.idx + 1
                for (const message of decodeAgyStep(step, summary.id, summary.modifiedAt)) {
                    const stored = { ...message, content: truncateOversizedMessageContent(message.content) as AgyImportedMessage['content'] }
                    messages.push(stored)
                    pageChars += JSON.stringify(stored).length
                }
                if (pageChars >= IMPORT_PAGE_BUDGET_CHARS) {
                    more = true
                    break
                }
            }
        }
        if (!cursor) messages.unshift(importNotice(summary.id, messages[0]?.createdAt ?? summary.modifiedAt))
        const worktree = !cursor && summary.cwd ? detectWorktreeOrigin(summary.cwd) : null
        sessions.push({
            ...summary,
            ...(cursor ? {} : livenessOf(holders, summary.id)),
            ...(worktree ? { worktree } : {}),
            messages,
            ...(more ? { nextCursor: { stepIndex: next } } : {})
        })
    }
    return sessions
}
