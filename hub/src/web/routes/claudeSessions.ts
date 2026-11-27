import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Hono } from 'hono'
import { z } from 'zod'
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol'
import type { ClaudeLocalSessionSummary, ClaudeLocalSessionWithMessages, ClaudeTranscriptCursor } from '@hapi/protocol/apiTypes'
import type { Metadata, PermissionMode } from '@hapi/protocol/types'
import type { Store, StoredMessage, StoredSession } from '../../store'
import { ImportedMessageConflictError } from '../../store/messages'
import { truncateOversizedMessageContent } from '../../store/contentCodec'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { resolveWorkspaceScope } from './workspaceScope'

/**
 * Adopting a Claude Code session that was started outside HAPI.
 *
 * The import writes the native transcript into a HAPI session row carrying
 * `metadata.claudeSessionId`. That single field is what makes the rest of the
 * feature free: `resolveAgentResumeId` already reads it, so the existing
 * reopen path can wake the adopted session with `claude --resume` without
 * knowing an import ever happened.
 *
 * Simpler than the Codex and Pi importers in one respect: a Claude transcript
 * is an append-only log with no branch tree, so reconciling a re-import is a
 * prefix check rather than a walk over an active path.
 */

const importLocks = new Map<string, Promise<unknown>>()

/** Most transcripts one import request may name. */
const MAX_IMPORT_SESSIONS = 100

const ImportClaudeSessionsBodySchema = z.object({
    sessionIds: z.array(z.string().trim().min(1).max(200)).min(1).max(MAX_IMPORT_SESSIONS),
    /** Checked against what claude accepts below; an unknown mode is dropped,
     *  not refused, the same as one claude cannot honour. */
    permissionMode: z.string().max(64).optional(),
    machineId: z.string().trim().max(200).optional(),
    cwd: z.string().trim().max(4096).optional(),
    /** The operator confirmed the session is closed. Overrules weak evidence
     *  only; a process writing the session still refuses the import. */
    force: z.boolean().optional()
})

/**
 * How recently a transcript must have been written to count as possibly still
 * in use. The process scan cannot see every writer, so a fresh write is
 * evidence too — but weak evidence, which an operator may overrule.
 */
const LIVE_TRANSCRIPT_WINDOW_MS = 60_000

/**
 * What a machine RPC failure most likely means here.
 *
 * A runner that predates this feature has no handler for the call, so it
 * simply never answers and the request dies on the timeout. Gating on an
 * advertised capability was the obvious guard, but it fails the wrong way:
 * a runner built after the feature and before the capability works fine yet
 * would be refused, and restarting a runner to re-advertise costs every
 * session it owns. Better to try, and to explain a silence when it happens.
 */
export function describeListFailure(cause: unknown): string {
    const message = cause instanceof Error ? cause.message : String(cause)
    return /timed out|timeout/i.test(message)
        ? 'The machine did not answer in time. Its runner may have lost its connection to the hub, or predate this feature — restarting the runner picks up a newer build.'
        : message
}

/**
 * Most pages one transcript may take. A page is about 8 MB of stored JSON, so
 * this is well past any transcript seen in practice; it exists so a machine
 * that keeps answering "more" cannot hold the request open forever.
 */
const MAX_TRANSCRIPT_PAGES = 200

type TranscriptFetch =
    | { transcript: ClaudeLocalSessionWithMessages }
    | { error: { code: string; message: string } }
    | null

/**
 * One transcript, pulled from the machine a page at a time.
 *
 * The whole transcript in one reply was the old shape, and a long session
 * broke it: 92 MB of JSONL came back as a 69 MB reply, past the hub's 48 MB
 * socket buffer, so the hub dropped the machine mid-reply and the import died
 * on a 30 s timeout with nothing to say why.
 *
 * A runner that predates paging ignores the cursor and returns everything in
 * one go with no `nextCursor`, which this reads as a single page.
 */
async function fetchClaudeTranscript(
    engine: SyncEngine,
    machineId: string,
    cwd: string | null,
    sessionId: string,
    force: boolean
): Promise<TranscriptFetch> {
    const readPage = async (cursor?: ClaudeTranscriptCursor) => {
        const result = await engine.listClaudeSessionsForMachine(machineId, cwd, [sessionId], cursor)
        if (!result.success) throw new Error(result.error)
        return result.sessions.find((session): session is ClaudeLocalSessionWithMessages =>
            'messages' in session && session.id === sessionId) ?? null
    }

    let first: ClaudeLocalSessionWithMessages | null
    try {
        first = await readPage()
    } catch (cause) {
        return { error: { code: 'machine_error', message: describeListFailure(cause) } }
    }
    if (!first) return null
    // A refused transcript needs no more pages.
    if (adoptRefusal(first, force)) return { transcript: first }

    const { nextCursor, ...head } = first
    const messages = [...head.messages]
    let cursor = nextCursor
    for (let pages = 1; cursor; pages += 1) {
        const failed = (message: string) => ({
            error: {
                code: 'machine_error',
                message: `Reading the transcript stopped after ${messages.length} messages: ${message}`
            }
        })
        if (pages >= MAX_TRANSCRIPT_PAGES) return failed('it is longer than an import can take')
        let page: ClaudeLocalSessionWithMessages | null
        try {
            page = await readPage(cursor)
        } catch (cause) {
            return failed(describeListFailure(cause))
        }
        if (!page) return failed('the transcript is gone from the machine')
        if (page.nextCursor && page.nextCursor.byteOffset <= cursor.byteOffset) {
            return failed('the machine stopped making progress')
        }
        for (const message of page.messages) messages.push(message)
        cursor = page.nextCursor
    }
    return { transcript: { ...head, messages, lastUserMessage: lastUserText(messages) ?? head.lastUserMessage } }
}

/**
 * The last prompt, from the full history. The machine's summary reads only
 * the ends of a long transcript and can miss it; with every message in hand
 * there is no need to guess.
 */
function lastUserText(messages: ClaudeLocalSessionWithMessages['messages']): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const content = messages[index]!.content
        if (content.role !== 'user') continue
        const text = content.content.text.trim()
        if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text
    }
    return null
}

export type ClaudeSessionListItem = ClaudeLocalSessionSummary & {
    hapiSessionId?: string
    /** Absent when nothing suggests the session is in use; see `classifyLiveness`. */
    liveness?: ClaudeLiveness
}

export type ClaudeImportResult = {
    claudeSessionId: string
    hapiSessionId?: string
    action?: 'created' | 'updated' | 'unchanged'
    appended?: number
    error?: { code: string; message: string }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function storedMetadata(session: StoredSession): Record<string, unknown> {
    return asRecord(session.metadata) ?? {}
}

/**
 * Whether adopting this session would race a running agent.
 *
 * - `running`: a process is writing it now. Never adoptable; the operator has
 *   to close that process. A runner too old to name holders sends a bare
 *   `live: true`, which means the same.
 * - `unsure`: nothing provably writes it, but something suggests it might — a
 *   process still holds the scratch directory of a session it has since left,
 *   or the transcript was written within the last minute. The process scan
 *   cannot see every writer, so this is not "safe": the operator is asked, and
 *   only their confirmation (`force`) lets it through.
 *
 * Reading a miss as "safe" would be the dangerous direction of wrong — it
 * hands an operator a session another agent is actively writing.
 */
export type ClaudeLiveness = 'running' | 'unsure'

export function classifyLiveness(
    session: Pick<ClaudeLocalSessionSummary, 'live' | 'holders' | 'modifiedAt'>,
    now = Date.now()
): ClaudeLiveness | null {
    if (session.live === true) return 'running'
    if ((session.holders?.length ?? 0) > 0) return 'unsure'
    if (now - session.modifiedAt < LIVE_TRANSCRIPT_WINDOW_MS) return 'unsure'
    return null
}

/** The evidence, in words, for an error an operator will read. */
function describeHolders(session: Pick<ClaudeLocalSessionSummary, 'holders' | 'modifiedAt'>, now = Date.now()): string {
    const holders = session.holders ?? []
    const parts = holders.map((holder) => {
        const by = holder.launcher === 'terminal' ? 'a terminal' : holder.launcher ?? 'an unknown parent'
        return holder.current
            ? `process ${holder.pid} (started by ${by}) is writing it`
            : `process ${holder.pid} (started by ${by}) still holds it but is writing another session`
    })
    if (now - session.modifiedAt < LIVE_TRANSCRIPT_WINDOW_MS) parts.push('it was written within the last minute')
    return parts.join('; ')
}

export function adoptRefusal(
    session: Pick<ClaudeLocalSessionSummary, 'live' | 'holders' | 'modifiedAt'>,
    force: boolean,
    agent = 'Claude'
): { code: string; message: string } | null {
    const liveness = classifyLiveness(session)
    if (liveness === 'running') {
        const evidence = describeHolders(session)
        return {
            code: 'session_live',
            message: `This ${agent} session is still running${evidence ? ` (${evidence})` : ''}. Exit it, then adopt it.`
        }
    }
    if (liveness === 'unsure' && !force) {
        return {
            code: 'session_maybe_live',
            message: `This ${agent} session may still be in use (${describeHolders(session)}). Confirm it is closed to adopt it.`
        }
    }
    return null
}

export function resolveClaudeMachine(
    engine: SyncEngine | null,
    namespace: string,
    requestedMachineId?: string | null
): Machine | null {
    if (!engine) return null
    const online = engine.getOnlineMachinesByNamespace(namespace)
    if (requestedMachineId) return online.find((machine) => machine.id === requestedMachineId) ?? null
    return online[0] ?? null
}

/**
 * Where each native session already lives in the hub, if anywhere. Note this
 * also matches sessions HAPI itself spawned — which is the point: a native id
 * the hub already tracks must not be imported a second time under a new row.
 */
function importedClaudeSessionsById(
    store: Store,
    namespace: string,
    machineId: string
): Map<string, StoredSession> {
    const byClaudeId = new Map<string, StoredSession>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = storedMetadata(session)
        const claudeSessionId = metadata.claudeSessionId
        if (metadata.flavor !== 'claude'
            || metadata.machineId !== machineId
            || typeof claudeSessionId !== 'string'
            || byClaudeId.has(claudeSessionId)) continue
        byClaudeId.set(claudeSessionId, session)
    }
    return byClaudeId
}

function buildClaudeMetadata(
    transcript: ClaudeLocalSessionWithMessages,
    machine: Machine,
    existing: Record<string, unknown>,
    permissionMode?: PermissionMode | null
): Metadata {
    const summaryText = transcript.lastUserMessage ?? transcript.title
    return {
        ...existing,
        // An adopted session is spawned by the ordinary reopen path, which
        // reads `preferredPermissionMode` and passes it to `--permission-mode`.
        // Without this, every adopted Claude session starts on `default` and
        // the operator has to switch mode from inside a turn — where `auto`
        // and `plan` cannot take hold until the next process starts.
        //
        // Only ever fills a gap: a re-import is a history sync, and must not
        // overwrite a mode the operator has since chosen in the composer.
        ...(permissionMode && typeof existing.preferredPermissionMode !== 'string'
            ? { preferredPermissionMode: permissionMode }
            : {}),
        path: transcript.cwd ?? (typeof existing.path === 'string' ? existing.path : dirname(transcript.file)),
        host: typeof existing.host === 'string' ? existing.host : (machine.metadata?.host ?? machine.id),
        os: typeof existing.os === 'string' ? existing.os : (machine.metadata?.platform ?? process.platform),
        name: typeof existing.name === 'string' ? existing.name : transcript.title,
        summary: summaryText ? { text: summaryText, updatedAt: Date.now() } : undefined,
        machineId: machine.id,
        flavor: 'claude',
        // Carried through so the adopted session answers "whose is this?" the
        // same way a spawned one does. Workspace ownership matches on the repo
        // as well as the checkout, and a worktree lives beside its repo — with
        // only `path` set, an adopted worktree session belongs to nobody.
        ...(transcript.worktree ? { worktree: transcript.worktree } : {}),
        // The whole point of the import: this is what `resolveAgentResumeId`
        // hands to `claude --resume` when the card is started.
        claudeSessionId: transcript.id,
        lifecycleState: typeof existing.lifecycleState === 'string' ? existing.lifecycleState : 'archived',
        lifecycleStateSince: typeof existing.lifecycleStateSince === 'number' ? existing.lifecycleStateSince : Date.now(),
        archivedBy: typeof existing.archivedBy === 'string' ? existing.archivedBy : 'claude-import',
        archiveReason: typeof existing.archiveReason === 'string' ? existing.archiveReason : 'Adopted from a local Claude Code session'
    } as Metadata
}

export function updateMetadataWithRetry(
    store: Store,
    sessionId: string,
    namespace: string,
    transform: (metadata: Record<string, unknown>) => Metadata
): Metadata {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = store.sessions.getSessionByNamespace(sessionId, namespace)
        if (!current) throw new Error('Adopted HAPI session disappeared')
        const next = transform(storedMetadata(current))
        const result = store.sessions.updateSessionMetadata(
            sessionId,
            next,
            current.metadataVersion,
            namespace,
            { touchUpdatedAt: false }
        )
        if (result.result === 'success') return next
        if (result.result === 'error') throw new Error('Failed to persist import metadata')
    }
    throw new Error('Import metadata changed concurrently')
}

function importedPrefix(sessionId: string): string {
    return `claude:${sessionId}:`
}

/**
 * What of the transcript is not in the hub yet. A Claude JSONL only ever grows,
 * so anything else — reordering, or a row whose content changed under an id we
 * already stored — means the file is not the one we imported from, and
 * appending to it would interleave two histories.
 */
export function classifyImportDelta<M extends { localId: string; content: unknown }>(
    existing: StoredMessage[],
    transcript: { id: string; messages: M[] },
    prefix = importedPrefix(transcript.id),
    agent = 'Claude'
): { messages: M[]; error?: string } {
    const sourceIndexByLocalId = new Map(transcript.messages.map((message, index) => [message.localId, index]))
    const storedImported = existing
        .filter((message) => message.localId?.startsWith(prefix))

    let priorSourceIndex = -1
    for (const message of storedImported) {
        const sourceIndex = sourceIndexByLocalId.get(message.localId!)
        if (sourceIndex === undefined || sourceIndex <= priorSourceIndex) {
            return { messages: [], error: `The local ${agent} transcript no longer extends the history already imported` }
        }
        priorSourceIndex = sourceIndex
    }

    const sourceByLocalId = new Map(transcript.messages.map((message) => [
        message.localId,
        truncateOversizedMessageContent(message.content)
    ]))
    const changed = storedImported.find((message) => !isDeepStrictEqual(sourceByLocalId.get(message.localId!), message.content))
    if (changed?.localId) {
        return { messages: [], error: `The local ${agent} transcript changed an already-imported entry (${changed.localId})` }
    }

    const imported = new Set(storedImported.map((message) => message.localId!))
    return { messages: transcript.messages.filter((message) => !imported.has(message.localId)) }
}

export function importClaudeSession(options: {
    store: Store
    engine: SyncEngine
    namespace: string
    machine: Machine
    transcript: ClaudeLocalSessionWithMessages
    existingSession?: StoredSession | null
    permissionMode?: PermissionMode | null
    /** The operator confirmed the session is closed; see `adoptRefusal`. */
    force?: boolean
}): ClaudeImportResult {
    const { store, engine, namespace, machine, transcript, existingSession, permissionMode } = options

    // Adopting a transcript a live `claude` still owns would race that process
    // for the tail of the file, and starting the card afterwards would resume a
    // session that is already running. Make the operator close it first.
    const refusal = adoptRefusal(transcript, options.force ?? false)
    if (refusal) return { claudeSessionId: transcript.id, error: refusal }

    let stored = existingSession === undefined
        ? importedClaudeSessionsById(store, namespace, machine.id).get(transcript.id) ?? null
        : existingSession
    const created = !stored
    if (!stored) {
        stored = store.sessions.getOrCreateSession(
            `claude-import:${machine.id}:${transcript.id}`,
            buildClaudeMetadata(transcript, machine, {}, permissionMode),
            {},
            namespace
        )
    } else {
        updateMetadataWithRetry(store, stored.id, namespace, (metadata) => buildClaudeMetadata(transcript, machine, metadata, permissionMode))
    }

    const delta = classifyImportDelta(store.messages.getAllMessages(stored.id), transcript)
    if (delta.error) {
        return {
            claudeSessionId: transcript.id,
            hapiSessionId: stored.id,
            error: { code: 'transcript_diverged', message: delta.error }
        }
    }
    if (stored.active && delta.messages.length > 0) {
        return {
            claudeSessionId: transcript.id,
            hapiSessionId: stored.id,
            error: {
                code: 'session_active',
                message: 'The HAPI session for this transcript is active; stop it before importing new history'
            }
        }
    }

    // One transaction for the whole transcript, not one per row.
    //
    // `addImportedMessage` opens a transaction and re-scans MAX(seq) for every
    // message it writes, which is fine for the handful an incremental sync
    // appends and quadratic for a first import. The hub is single-threaded, so
    // that cost is not paid by this request alone — it is paid by everyone.
    // Observed before this: a 200 response after 88 seconds, during which the
    // whole board was frozen.
    let appendedCount = 0
    const importedAt = Date.now()
    try {
        appendedCount = store.messages.copyMessagesToSession(
            stored.id,
            delta.messages.map((source) => {
                // An imported turn is history: it was said, and it was answered,
                // long before the hub ever saw the file. It has to land already
                // invoked. A null `invokedAt` is how this schema spells "a prompt
                // still waiting to go out", so leaving it null files the entire
                // conversation as pending: the composer's queue bar fills with
                // every line the human ever typed, and the next CLI attach
                // replays all of them at the agent. `addImportedMessage`, which
                // this call replaced, stamped `invoked_at` for exactly that
                // reason.
                const stampedAt = Number.isFinite(source.createdAt)
                    ? Math.min(source.createdAt, importedAt)
                    : importedAt
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
        const message = error instanceof Error ? error.message : 'Failed to persist the imported Claude history'
        return {
            claudeSessionId: transcript.id,
            hapiSessionId: stored.id,
            error: {
                code: error instanceof ImportedMessageConflictError ? 'transcript_diverged' : 'import_failed',
                message
            }
        }
    }

    const activityAt = delta.messages.at(-1)?.createdAt ?? transcript.modifiedAt
    engine.recordSessionActivity(stored.id, activityAt)
    // Deliberately no per-message broadcast: an import is history, not live
    // conversation, and fanning thousands of `message-received` events at
    // every connected client is the same mistake in a different place. One
    // session-updated tells them to re-read if they care.
    engine.handleRealtimeEvent({ type: 'session-updated', sessionId: stored.id })
    return {
        claudeSessionId: transcript.id,
        hapiSessionId: stored.id,
        action: created ? 'created' : appendedCount > 0 ? 'updated' : 'unchanged',
        appended: appendedCount
    }
}

export async function importWithLock<T>(key: string, work: () => T): Promise<T> {
    const prior = importLocks.get(key) as Promise<T> | undefined
    if (prior) return prior
    const current = Promise.resolve().then(work)
    importLocks.set(key, current)
    try {
        return await current
    } finally {
        if (importLocks.get(key) === current) importLocks.delete(key)
    }
}

export function createClaudeSessionRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/claude/sessions', async (c) => {
        const namespace = c.get('namespace')
        // Whose sessions: the adopting user's directories, or everyone's when
        // no user is picked. See `ListClaudeSessionsRpcRequestSchema.userRoots`.
        const scope = resolveWorkspaceScope(c, options.store, c.req.query('workspaceUser'))
        if (scope instanceof Response) return scope
        const engine = options.getSyncEngine()
        const machine = resolveClaudeMachine(engine, namespace, c.req.query('machineId')?.trim() || null)
        if (!engine || !machine) return c.json({ success: false, error: 'No online machine available for Claude session adoption', sessions: [] }, 503)
        // Owns nothing yet: nothing to list, and no reason to ask the machine.
        if (scope && scope.roots.length === 0) return c.json({ success: true, sessions: [], machineId: machine.id })
        let result: Awaited<ReturnType<SyncEngine['listClaudeSessionsForMachine']>>
        try {
            result = await engine.listClaudeSessionsForMachine(machine.id, c.req.query('cwd')?.trim() || null, undefined, undefined, scope ? [...scope.roots] : undefined)
        } catch (cause) {
            return c.json({ success: false, error: describeListFailure(cause), sessions: [], machineId: machine.id }, 503)
        }
        if (!result.success) return c.json({ success: false, error: result.error, sessions: [], machineId: machine.id }, 503)
        const importedByClaudeId = importedClaudeSessionsById(options.store, namespace, machine.id)
        const sessions: ClaudeSessionListItem[] = result.sessions.map((summary) => {
            const imported = importedByClaudeId.get(summary.id)
            const liveness = classifyLiveness(summary)
            return {
                ...summary,
                ...(imported ? { hapiSessionId: imported.id } : {}),
                ...(liveness ? { liveness } : {})
            }
        })
        return c.json({ success: true, sessions, machineId: machine.id })
    })

    app.post('/claude/import-sessions', async (c) => {
        const parsed = ImportClaudeSessionsBodySchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) {
            const noneSelected = parsed.error.issues.some((issue) => issue.path[0] === 'sessionIds')
            return c.json({
                success: false,
                error: noneSelected ? 'No Claude sessions selected' : 'Invalid body',
                issues: parsed.error.flatten(),
                results: []
            }, 400)
        }
        const body = parsed.data
        // A mode the adopted session cannot honour is worse than none: it would
        // be persisted, handed to `--permission-mode`, and rejected by claude.
        const requestedPermissionMode = body.permissionMode !== undefined
            && isPermissionModeAllowedForFlavor(body.permissionMode as PermissionMode, 'claude')
            ? body.permissionMode as PermissionMode
            : null
        const uniqueSessionIds = [...new Set(body.sessionIds)]
        const namespace = c.get('namespace')
        const engine = options.getSyncEngine()
        const machine = resolveClaudeMachine(engine, namespace, body.machineId || null)
        if (!engine || !machine) return c.json({ success: false, error: 'No online machine available for Claude session adoption', results: [] }, 503)
        const results: ClaudeImportResult[] = []
        for (const sessionId of uniqueSessionIds) {
            const fetched = await fetchClaudeTranscript(engine, machine.id, body.cwd || null, sessionId, body.force ?? false)
            if (!fetched) {
                results.push({ claudeSessionId: sessionId, error: { code: 'not_found', message: 'Claude session transcript not found' } })
                continue
            }
            if ('error' in fetched) {
                results.push({ claudeSessionId: sessionId, error: fetched.error })
                continue
            }
            // Read after the fetch, which can take seconds: an import of the
            // same transcript that finished meanwhile must be seen.
            const existingSession = importedClaudeSessionsById(options.store, namespace, machine.id).get(sessionId) ?? null
            results.push(await importWithLock(`${namespace}:${machine.id}:${sessionId}`, () => importClaudeSession({
                store: options.store,
                engine,
                namespace,
                machine,
                transcript: fetched.transcript,
                existingSession,
                permissionMode: requestedPermissionMode,
                force: body.force ?? false
            })))
        }
        // Every transcript failed on the machine side: answer as the machine
        // failure it is, so the client shows the reason rather than a generic
        // import error.
        const machineFailure = results.length > 0 && results.every((result) => result.error?.code === 'machine_error')
        if (machineFailure) {
            return c.json({ success: false, error: results[0]!.error!.message, results, machineId: machine.id }, 503)
        }
        return c.json({ success: results.every((result) => !result.error), results, machineId: machine.id })
    })

    return app
}
