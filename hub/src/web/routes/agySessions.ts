import { dirname } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol'
import type { AgyLocalSessionSummary, AgyLocalSessionWithMessages, AgyTranscriptCursor } from '@hapi/protocol/apiTypes'
import type { Metadata, PermissionMode } from '@hapi/protocol/types'
import type { Store, StoredSession } from '../../store'
import { ImportedMessageConflictError } from '../../store/messages'
import { truncateOversizedMessageContent } from '../../store/contentCodec'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { resolveWorkspaceScope } from './workspaceScope'
import {
    adoptRefusal,
    classifyImportDelta,
    classifyLiveness,
    describeListFailure,
    importWithLock,
    resolveClaudeMachine,
    updateMetadataWithRetry,
    type ClaudeLiveness
} from './claudeSessions'

/**
 * Adopting an Antigravity (agy) conversation that was started outside dugong.
 *
 * The Claude importer's twin: the import writes the conversation into a HAPI
 * session row carrying `metadata.agySessionId`, which `resolveAgentResumeId`
 * already hands to agy as the conversation to resume, whichever transport
 * (`agy -p --conversation` or ACP `session/load`) the CLI uses. History is
 * agy's step log translated on the machine (see the CLI's `agySessions.ts`);
 * a step only ever gets appended, so a re-import is the same prefix check.
 */

const MAX_IMPORT_SESSIONS = 100
const MAX_TRANSCRIPT_PAGES = 200
const AGENT = 'agy'

const ImportAgySessionsBodySchema = z.object({
    sessionIds: z.array(z.string().trim().min(1).max(200)).min(1).max(MAX_IMPORT_SESSIONS),
    permissionMode: z.string().max(64).optional(),
    machineId: z.string().trim().max(200).optional(),
    /** The operator confirmed the session is closed; overrules weak evidence only. */
    force: z.boolean().optional()
})

export type AgySessionListItem = AgyLocalSessionSummary & {
    hapiSessionId?: string
    liveness?: ClaudeLiveness
}

export type AgyImportResult = {
    agySessionId: string
    hapiSessionId?: string
    action?: 'created' | 'updated' | 'unchanged'
    appended?: number
    error?: { code: string; message: string }
}

function storedMetadata(session: StoredSession): Record<string, unknown> {
    const value = session.metadata
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function importedPrefix(conversationId: string): string {
    return `agy:${conversationId}:`
}

/** Where each agy conversation already lives in the hub — including ones
 *  dugong spawned itself, which must not be imported a second time. */
function importedAgySessionsById(store: Store, namespace: string, machineId: string): Map<string, StoredSession> {
    const byId = new Map<string, StoredSession>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = storedMetadata(session)
        const agySessionId = metadata.agySessionId
        if (metadata.flavor !== 'agy'
            || metadata.machineId !== machineId
            || typeof agySessionId !== 'string'
            || byId.has(agySessionId)) continue
        byId.set(agySessionId, session)
    }
    return byId
}

type TranscriptFetch =
    | { transcript: AgyLocalSessionWithMessages }
    | { error: { code: string; message: string } }
    | null

/** One conversation, a page at a time; see `fetchClaudeTranscript`. */
async function fetchAgyTranscript(engine: SyncEngine, machineId: string, sessionId: string, force: boolean): Promise<TranscriptFetch> {
    const readPage = async (cursor?: AgyTranscriptCursor) => {
        const result = await engine.listAgySessionsForMachine(machineId, [sessionId], cursor)
        if (!result.success) throw new Error(result.error)
        return result.sessions.find((session): session is AgyLocalSessionWithMessages =>
            'messages' in session && session.id === sessionId) ?? null
    }

    let first: AgyLocalSessionWithMessages | null
    try {
        first = await readPage()
    } catch (cause) {
        return { error: { code: 'machine_error', message: describeListFailure(cause) } }
    }
    if (!first) return null
    if (adoptRefusal(first, force, AGENT)) return { transcript: first }

    const { nextCursor, ...head } = first
    const messages = [...head.messages]
    let cursor = nextCursor
    for (let pages = 1; cursor; pages += 1) {
        const failed = (message: string) => ({
            error: { code: 'machine_error', message: `Reading the conversation stopped after ${messages.length} messages: ${message}` }
        })
        if (pages >= MAX_TRANSCRIPT_PAGES) return failed('it is longer than an import can take')
        let page: AgyLocalSessionWithMessages | null
        try {
            page = await readPage(cursor)
        } catch (cause) {
            return failed(describeListFailure(cause))
        }
        if (!page) return failed('the conversation is gone from the machine')
        if (page.nextCursor && page.nextCursor.stepIndex <= cursor.stepIndex) {
            return failed('the machine stopped making progress')
        }
        for (const message of page.messages) messages.push(message)
        cursor = page.nextCursor
    }
    return { transcript: { ...head, messages } }
}

function buildAgyMetadata(
    transcript: AgyLocalSessionWithMessages,
    machine: Machine,
    existing: Record<string, unknown>,
    permissionMode?: PermissionMode | null
): Metadata {
    const summaryText = transcript.lastUserMessage ?? transcript.title
    return {
        ...existing,
        // Only ever fills a gap; see `buildClaudeMetadata`.
        ...(permissionMode && typeof existing.preferredPermissionMode !== 'string'
            ? { preferredPermissionMode: permissionMode }
            : {}),
        path: transcript.cwd ?? (typeof existing.path === 'string' ? existing.path : dirname(transcript.file)),
        host: typeof existing.host === 'string' ? existing.host : (machine.metadata?.host ?? machine.id),
        os: typeof existing.os === 'string' ? existing.os : (machine.metadata?.platform ?? process.platform),
        name: typeof existing.name === 'string' ? existing.name : transcript.title,
        summary: summaryText ? { text: summaryText, updatedAt: Date.now() } : undefined,
        machineId: machine.id,
        flavor: 'agy',
        ...(transcript.worktree ? { worktree: transcript.worktree } : {}),
        // What `resolveAgentResumeId` resumes when the card is started.
        agySessionId: transcript.id,
        lifecycleState: typeof existing.lifecycleState === 'string' ? existing.lifecycleState : 'archived',
        lifecycleStateSince: typeof existing.lifecycleStateSince === 'number' ? existing.lifecycleStateSince : Date.now(),
        archivedBy: typeof existing.archivedBy === 'string' ? existing.archivedBy : 'agy-import',
        archiveReason: typeof existing.archiveReason === 'string' ? existing.archiveReason : 'Adopted from a local Antigravity session'
    } as Metadata
}

export function importAgySession(options: {
    store: Store
    engine: SyncEngine
    namespace: string
    machine: Machine
    transcript: AgyLocalSessionWithMessages
    existingSession?: StoredSession | null
    permissionMode?: PermissionMode | null
    force?: boolean
}): AgyImportResult {
    const { store, engine, namespace, machine, transcript, existingSession, permissionMode } = options

    // A conversation a running agy is on would be resumed into twice.
    const refusal = adoptRefusal(transcript, options.force ?? false, AGENT)
    if (refusal) return { agySessionId: transcript.id, error: refusal }

    let stored = existingSession === undefined
        ? importedAgySessionsById(store, namespace, machine.id).get(transcript.id) ?? null
        : existingSession
    const created = !stored
    if (!stored) {
        stored = store.sessions.getOrCreateSession(
            `agy-import:${machine.id}:${transcript.id}`,
            buildAgyMetadata(transcript, machine, {}, permissionMode),
            {},
            namespace
        )
    } else {
        updateMetadataWithRetry(store, stored.id, namespace, (metadata) => buildAgyMetadata(transcript, machine, metadata, permissionMode))
    }

    const delta = classifyImportDelta(store.messages.getAllMessages(stored.id), transcript, importedPrefix(transcript.id), AGENT)
    if (delta.error) {
        return { agySessionId: transcript.id, hapiSessionId: stored.id, error: { code: 'transcript_diverged', message: delta.error } }
    }
    if (stored.active && delta.messages.length > 0) {
        return {
            agySessionId: transcript.id,
            hapiSessionId: stored.id,
            error: { code: 'session_active', message: 'The HAPI session for this conversation is active; stop it before importing new history' }
        }
    }

    // One transaction, every row already invoked: see `importClaudeSession`.
    let appendedCount = 0
    const importedAt = Date.now()
    try {
        appendedCount = store.messages.copyMessagesToSession(
            stored.id,
            delta.messages.map((source) => {
                const stampedAt = Number.isFinite(source.createdAt) ? Math.min(source.createdAt, importedAt) : importedAt
                return {
                    content: truncateOversizedMessageContent(source.content),
                    createdAt: stampedAt,
                    localId: source.localId,
                    invokedAt: stampedAt,
                    scheduledAt: null
                }
            })
        )
    } catch (error) {
        return {
            agySessionId: transcript.id,
            hapiSessionId: stored.id,
            error: {
                code: error instanceof ImportedMessageConflictError ? 'transcript_diverged' : 'import_failed',
                message: error instanceof Error ? error.message : 'Failed to persist the imported agy history'
            }
        }
    }

    engine.recordSessionActivity(stored.id, delta.messages.at(-1)?.createdAt ?? transcript.modifiedAt)
    engine.handleRealtimeEvent({ type: 'session-updated', sessionId: stored.id })
    return {
        agySessionId: transcript.id,
        hapiSessionId: stored.id,
        action: created ? 'created' : appendedCount > 0 ? 'updated' : 'unchanged',
        appended: appendedCount
    }
}

export function createAgySessionRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/agy/sessions', async (c) => {
        const namespace = c.get('namespace')
        const scope = resolveWorkspaceScope(c, options.store, c.req.query('workspaceUser'))
        if (scope instanceof Response) return scope
        const engine = options.getSyncEngine()
        const machine = resolveClaudeMachine(engine, namespace, c.req.query('machineId')?.trim() || null)
        if (!engine || !machine) return c.json({ success: false, error: 'No online machine available for agy session adoption', sessions: [] }, 503)
        if (scope && scope.roots.length === 0) return c.json({ success: true, sessions: [], machineId: machine.id })
        let result: Awaited<ReturnType<SyncEngine['listAgySessionsForMachine']>>
        try {
            result = await engine.listAgySessionsForMachine(machine.id, undefined, undefined, scope ? [...scope.roots] : undefined)
        } catch (cause) {
            return c.json({ success: false, error: describeListFailure(cause), sessions: [], machineId: machine.id }, 503)
        }
        if (!result.success) return c.json({ success: false, error: result.error, sessions: [], machineId: machine.id }, 503)
        const imported = importedAgySessionsById(options.store, namespace, machine.id)
        const sessions: AgySessionListItem[] = result.sessions.map((summary) => {
            const row = imported.get(summary.id)
            const liveness = classifyLiveness(summary)
            return {
                ...summary,
                ...(row ? { hapiSessionId: row.id } : {}),
                ...(liveness ? { liveness } : {})
            }
        })
        return c.json({ success: true, sessions, machineId: machine.id })
    })

    app.post('/agy/import-sessions', async (c) => {
        const parsed = ImportAgySessionsBodySchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) {
            const noneSelected = parsed.error.issues.some((issue) => issue.path[0] === 'sessionIds')
            return c.json({
                success: false,
                error: noneSelected ? 'No agy sessions selected' : 'Invalid body',
                issues: parsed.error.flatten(),
                results: []
            }, 400)
        }
        const body = parsed.data
        const permissionMode = body.permissionMode !== undefined
            && isPermissionModeAllowedForFlavor(body.permissionMode as PermissionMode, 'agy')
            ? body.permissionMode as PermissionMode
            : null
        const namespace = c.get('namespace')
        const engine = options.getSyncEngine()
        const machine = resolveClaudeMachine(engine, namespace, body.machineId || null)
        if (!engine || !machine) return c.json({ success: false, error: 'No online machine available for agy session adoption', results: [] }, 503)
        const results: AgyImportResult[] = []
        for (const sessionId of [...new Set(body.sessionIds)]) {
            const fetched = await fetchAgyTranscript(engine, machine.id, sessionId, body.force ?? false)
            if (!fetched) {
                results.push({ agySessionId: sessionId, error: { code: 'not_found', message: 'agy conversation not found' } })
                continue
            }
            if ('error' in fetched) {
                results.push({ agySessionId: sessionId, error: fetched.error })
                continue
            }
            const existingSession = importedAgySessionsById(options.store, namespace, machine.id).get(sessionId) ?? null
            results.push(await importWithLock(`agy:${namespace}:${machine.id}:${sessionId}`, () => importAgySession({
                store: options.store,
                engine,
                namespace,
                machine,
                transcript: fetched.transcript,
                existingSession,
                permissionMode,
                force: body.force ?? false
            })))
        }
        const machineFailure = results.length > 0 && results.every((result) => result.error?.code === 'machine_error')
        if (machineFailure) {
            return c.json({ success: false, error: results[0]!.error!.message, results, machineId: machine.id }, 503)
        }
        return c.json({ success: results.every((result) => !result.error), results, machineId: machine.id })
    })

    return app
}
