import { readdirSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import type {
    ClaudeImportedMessage,
    ClaudeLocalSessionSummary,
    ClaudeLocalSessionWithMessages,
    ClaudeTranscriptCursor
} from '@hapi/protocol/apiTypes'
import { isClaudeChatVisibleMessage } from '@hapi/protocol/messages'
import { truncateOversizedMessageContent } from '@hapi/protocol/messageTruncation'
import type { RawJSONLines } from '@/claude/types'
import { encodeProjectDirName, getProjectPath } from '@/claude/utils/path'
import { parseSessionLogLine } from '@/claude/utils/sessionScanner'
import { extractRawUserTextContent, isExternalUserMessage } from '@/claude/utils/externalUserMessage'
import { detectWorktreeOrigin } from './worktreeOrigin'
import { readTranscriptEnds } from './transcriptEnds'
import { claudeSessionHolders } from './claudeSessionHolders'

/**
 * Discovery for Claude Code sessions that were started with the bare `claude`
 * CLI, so the board can adopt one that HAPI never spawned.
 *
 * The Codex and Pi equivalents each carry a few hundred lines of transcript
 * translation, because their on-disk formats are nothing like a HAPI message.
 * Claude needs none of that: `parseSessionLogLine` is the same filter the live
 * scanner uses, and the rows it returns are exactly what the CLI forwards over
 * the socket. So this file only has to *find* sessions and label them — the
 * conversion is two shapes copied from `sendClaudeSessionMessage`.
 */

/**
 * How many sessions an unscoped listing returns.
 *
 * Sorted newest-first, so this is also how much gets read: the scan stops as
 * soon as it has enough. Each one costs two small reads at the ends of its
 * transcript (see `summariseClaudeLocalSession`), so a hundred come back in
 * a few hundred milliseconds even on a machine with gigabytes of history —
 * enough for the picker's filter box to find last week's session.
 */
const DEFAULT_CLAUDE_SESSION_SCAN_LIMIT = 100

/** Session id → processes tied to it; null where that cannot be known. */
function sessionHolders() {
    return claudeSessionHolders({ claudeConfigDir: getClaudeConfigDir() })
}

/** `live` and `holders` for one session, or nothing when holders are unknown. */
function livenessOf(holders: ReturnType<typeof sessionHolders>, sessionId: string) {
    if (!holders) return {}
    const own = holders.get(sessionId)
    return own ? { live: own.some((holder) => holder.current), holders: own } : { live: false }
}

type ClaudeSessionFileCandidate = {
    file: string
    modifiedAt: number
    size: number
    discoveryIndex: number
}

function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function getClaudeConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
}

function getClaudeProjectsRoot(): string {
    return join(getClaudeConfigDir(), 'projects')
}

function jsonlFilesIn(directory: string): string[] {
    let entries: import('node:fs').Dirent[]
    try {
        entries = readdirSync(directory, { withFileTypes: true })
    } catch {
        return []
    }
    // Claude keeps one flat directory of `<session-id>.jsonl` per project;
    // there is no nesting to recurse into.
    return entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl'))
        .map((entry) => join(directory, entry.name))
}

/**
 * Whether a project directory could hold sessions under one of `roots`.
 *
 * Claude's directory name is the working directory with its punctuation
 * flattened, so a prefix match on the name answers this without opening
 * anything. Lossy by construction — the caller still has to check each
 * session's real `cwd` — but it is what keeps a scan from reading every
 * transcript on a shared machine to find the few it may show.
 */
function projectDirWithinRoots(dirName: string, encodedRoots: readonly string[]): boolean {
    if (encodedRoots.length === 0) return true
    return encodedRoots.some((root) => dirName === root || dirName.startsWith(`${root}-`))
}

/**
 * `cwd` narrows to a single project rather than filtering afterwards: Claude
 * derives its project directory name from the working directory itself
 * (`getProjectPath`), so asking about one directory never has to read another
 * one's transcripts.
 */
function collectSortedClaudeSessionFiles(
    cwd?: string | null,
    roots?: readonly string[] | null
): ClaudeSessionFileCandidate[] {
    const files: string[] = []
    if (cwd?.trim()) {
        files.push(...jsonlFilesIn(getProjectPath(cwd.trim())))
    } else {
        const root = getClaudeProjectsRoot()
        let projectDirs: import('node:fs').Dirent[]
        try {
            projectDirs = readdirSync(root, { withFileTypes: true })
        } catch {
            return []
        }
        const encodedRoots = (roots ?? []).map(encodeProjectDirName)
        for (const projectDir of projectDirs) {
            if (!projectDir.isDirectory()) continue
            if (!projectDirWithinRoots(projectDir.name, encodedRoots)) continue
            files.push(...jsonlFilesIn(join(root, projectDir.name)))
        }
    }

    return files.flatMap((file, discoveryIndex) => {
        try {
            const stats = statSync(file)
            return [{ file, modifiedAt: stats.mtimeMs, size: stats.size, discoveryIndex }]
        } catch {
            return []
        }
    }).sort((a, b) => b.modifiedAt - a.modifiedAt || a.discoveryIndex - b.discoveryIndex)
}

function sessionIdFromFile(filePath: string): string {
    return basename(filePath).slice(0, -'.jsonl'.length)
}

function rowTimestamp(row: RawJSONLines, fallback: number): number {
    if (!row.timestamp) return fallback
    const parsed = Date.parse(row.timestamp)
    return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Same two shapes `sendClaudeSessionMessage` emits live, so an imported row
 * and a forwarded one are indistinguishable to the hub and the web pipeline.
 */
function toImportedMessage(
    row: RawJSONLines,
    sessionId: string,
    index: number,
    fallbackCreatedAt: number
): ClaudeImportedMessage {
    const uuid = 'uuid' in row && typeof row.uuid === 'string' ? row.uuid : null
    const localId = `claude:${sessionId}:${uuid ?? `row-${index}`}`
    const createdAt = rowTimestamp(row, fallbackCreatedAt)

    if (isExternalUserMessage(row)) {
        return {
            localId,
            createdAt,
            content: {
                role: 'user',
                content: { type: 'text', text: extractRawUserTextContent(row.message.content) ?? '' },
                meta: { sentFrom: 'cli' }
            }
        }
    }

    return {
        localId,
        createdAt,
        content: {
            role: 'agent',
            content: { type: 'output', data: row },
            meta: { sentFrom: 'cli' }
        }
    }
}

/**
 * Whether a transcript row is a conversation row: one the import turns into
 * a chat message.
 *
 * A whitelist on purpose. Claude Code keeps adding bookkeeping rows (`mode`,
 * `permission-mode`, `session-owner`, `cost-state`, `attachment`,
 * `api-request`, …) and each new one used to pass for a message, so a session
 * that never had a turn listed as "9 messages" and imported as none. The
 * listing and the import both ask this, so their counts agree by
 * construction.
 */
function isConversationRow(row: Record<string, unknown>): boolean {
    const type = row.type
    if (type !== 'user' && type !== 'assistant' && type !== 'system') return false
    if (typeof row.uuid !== 'string') return false
    if (type === 'user' && (typeof row.message !== 'object' || row.message === null)) return false
    if (row.isMeta === true || row.isCompactSummary === true) return false
    return isClaudeChatVisibleMessage(row as { type: unknown; subtype?: unknown })
}

type SummaryFold = {
    sessionId: string | null
    cwd: string | null
    nativeTitle: string | null
    summaryTitle: string | null
    firstUserMessage: string | null
    lastUserMessage: string | null
    messageCount: number
    /** Claude answered at least once. */
    replied: boolean
    /** Someone typed a prompt at a terminal (not a program driving the SDK). */
    promptedByPerson: boolean
}

/**
 * Fold transcript lines, in file order, into what a summary shows.
 *
 * No schema validation: a summary needs a title, a directory and the last
 * thing said, and validating every row to get them used to cost more than
 * reading the file. The import path keeps the strict parse — those rows are
 * persisted and replayed to clients.
 */
function foldSummaryLines(fold: SummaryFold, lines: readonly string[]): void {
    for (const line of lines) {
        let row: Record<string, unknown>
        try {
            row = JSON.parse(line) as Record<string, unknown>
        } catch {
            continue
        }
        const type = row?.type
        if (typeof type !== 'string') continue

        fold.sessionId ??= typeof row.sessionId === 'string' ? row.sessionId : null
        fold.cwd ??= typeof row.cwd === 'string' ? row.cwd : null

        if (type === 'ai-title') {
            // Claude re-titles as the conversation moves; the latest wins.
            if (typeof row.aiTitle === 'string') fold.nativeTitle = row.aiTitle
            continue
        }
        if (type === 'summary') {
            if (typeof row.summary === 'string') fold.summaryTitle ??= row.summary
            continue
        }
        if (!isConversationRow(row)) continue

        fold.messageCount += 1
        if (type === 'assistant') fold.replied = true
        if (isExternalUserMessage(row as unknown as RawJSONLines)) {
            const text = extractRawUserTextContent((row.message as { content?: unknown })?.content)?.trim()
            if (text) {
                fold.firstUserMessage ??= text
                fold.lastUserMessage = text
                if (row.entrypoint !== 'sdk-ts') fold.promptedByPerson = true
            }
        }
    }
}

type CachedSummary = {
    size: number
    modifiedAt: number
    summary: ClaudeLocalSessionSummary | null
}

/**
 * Summaries by transcript path, valid while size and mtime are unchanged.
 *
 * The runner lives for days and most transcripts stop changing once their
 * session ends, so a repeat listing reads only the files written since.
 */
const summaryCache = new Map<string, CachedSummary>()
const SUMMARY_CACHE_LIMIT = 5000

/**
 * A listing-only look at one transcript: its head and tail, never the middle.
 *
 * Everything on a picker row lives at the ends: the session id and directory
 * in the first rows, Claude's latest `ai-title` and the last prompt near the
 * end (Claude rewrites the title throughout a session, so the newest one is
 * always close to the tail). The one thing the ends cannot give is an exact
 * message count, so a long transcript reports its size instead.
 */
async function summariseClaudeLocalSession(
    candidate: Pick<ClaudeSessionFileCandidate, 'file' | 'modifiedAt' | 'size'>
): Promise<ClaudeLocalSessionSummary | null> {
    const cached = summaryCache.get(candidate.file)
    if (cached && cached.size === candidate.size && cached.modifiedAt === candidate.modifiedAt) {
        return cached.summary
    }

    const ends = await readTranscriptEnds(candidate.file)
    if (!ends) return null

    const fold: SummaryFold = {
        sessionId: null,
        cwd: null,
        nativeTitle: null,
        summaryTitle: null,
        firstUserMessage: null,
        lastUserMessage: null,
        messageCount: 0,
        replied: false,
        promptedByPerson: false
    }
    foldSummaryLines(fold, ends.head)
    // "Last prompt" means last in the file. A long agent turn can push it out
    // of the tail window, and the head's last prompt would then pass for it —
    // usually the very first thing said. Better none than a wrong one.
    if (!ends.whole) fold.lastUserMessage = null
    foldSummaryLines(fold, ends.tail)

    const resolvedId = fold.sessionId ?? sessionIdFromFile(candidate.file)
    // Only a real conversation is worth adopting: Claude answered, or a
    // person typed a prompt. Everything else is a shell — a terminal opened
    // and closed, or a program's SDK call that never got a reply (dugong's
    // own startup probe used to leave one per session, prompt "hello"). A
    // partial read proves nothing either way, so a long transcript is kept.
    const conversation = fold.replied || fold.promptedByPerson
    const summary: ClaudeLocalSessionSummary | null = !resolvedId || (ends.whole && !conversation)
        ? null
        : {
            id: resolvedId,
            title: fold.nativeTitle
                ?? fold.summaryTitle
                ?? (fold.firstUserMessage ? truncateText(fold.firstUserMessage, 80) : null)
                ?? (fold.cwd ? basename(fold.cwd) || fold.cwd : null)
                ?? resolvedId.slice(0, 8),
            lastUserMessage: fold.lastUserMessage ? truncateText(fold.lastUserMessage, 140) : null,
            cwd: fold.cwd,
            file: candidate.file,
            modifiedAt: candidate.modifiedAt,
            size: ends.size,
            ...(ends.whole ? { messageCount: fold.messageCount } : {})
        }

    if (summaryCache.size >= SUMMARY_CACHE_LIMIT) summaryCache.clear()
    // Keyed on what was statted before the read: a file that grew in between
    // is simply re-read next time.
    summaryCache.set(candidate.file, { size: candidate.size, modifiedAt: candidate.modifiedAt, summary })
    return summary
}

export async function listLocalClaudeSessionSummaries(
    limit = DEFAULT_CLAUDE_SESSION_SCAN_LIMIT,
    cwd?: string | null,
    /**
     * Whether a session may be shown at all — the caller's workspace-root
     * check.
     *
     * It has to run here rather than over the result, because `limit` is a
     * budget and anything rejected afterwards has already spent from it. On a
     * shared machine that is not a detail: of the 40 most recent transcripts
     * here, 32 belonged to directories outside the runner's roots, so a
     * post-filtered list showed three sessions and looked broken.
     */
    accept?: (session: { cwd?: string | null }) => boolean | Promise<boolean>,
    /** Workspace roots, used to skip whole projects before reading them. */
    roots?: readonly string[] | null
): Promise<ClaudeLocalSessionSummary[]> {
    if (limit <= 0) return []
    const seenIds = new Set<string>()
    const summaries: ClaudeLocalSessionSummary[] = []
    const holders = sessionHolders()
    for (const candidate of collectSortedClaudeSessionFiles(cwd, roots)) {
        const summary = await summariseClaudeLocalSession(candidate)
        if (!summary || seenIds.has(summary.id)) continue
        seenIds.add(summary.id)
        if (accept && !(await accept(summary))) continue
        summaries.push({ ...summary, ...livenessOf(holders, summary.id) })
        if (summaries.length >= limit) break
    }
    return summaries
}

/**
 * How much of a transcript one import page carries, measured as the JSON the
 * hub will receive. Far under the hub's socket buffer (48 MB), which a single
 * long transcript used to blow through: the hub dropped the machine's
 * connection mid-reply and the import died on a 30 s timeout.
 */
const IMPORT_PAGE_BUDGET_CHARS = 8 * 1024 * 1024
/** File bytes read per step while filling a page. */
const IMPORT_READ_WINDOW_BYTES = 16 * 1024 * 1024

type TranscriptPage = {
    messages: ClaudeImportedMessage[]
    nextCursor?: ClaudeTranscriptCursor
}

/**
 * One page of a transcript's conversation, starting at `cursor`.
 *
 * Rows are numbered exactly as `readSessionLog` numbers them, so the fallback
 * id of a row without a uuid does not depend on where a page broke. Agent
 * content is truncated here, as the hub would on ingest, so the
 * page budget counts the bytes that will actually be stored.
 */
async function readClaudeTranscriptPage(
    filePath: string,
    sessionId: string,
    modifiedAt: number,
    cursor: ClaudeTranscriptCursor
): Promise<TranscriptPage | { error: string }> {
    const handle = await open(filePath, 'r')
    try {
        const { size } = await handle.stat()
        if (cursor.byteOffset > size) {
            return { error: 'The transcript shrank while it was being imported' }
        }

        const messages: ClaudeImportedMessage[] = []
        let offset = cursor.byteOffset
        let eventIndex = cursor.eventIndex
        let pageChars = 0
        let windowBytes = IMPORT_READ_WINDOW_BYTES

        while (offset < size && pageChars < IMPORT_PAGE_BUDGET_CHARS) {
            const length = Math.min(windowBytes, size - offset)
            const buffer = Buffer.allocUnsafe(length)
            let filled = 0
            while (filled < length) {
                const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled)
                if (bytesRead === 0) break
                filled += bytesRead
            }
            if (filled === 0) {
                return { error: 'The transcript changed while it was being imported' }
            }
            const chunk = buffer.subarray(0, filled)
            const atEnd = offset + filled >= size
            let usable = chunk.lastIndexOf(0x0a) + 1
            if (usable === 0 && !atEnd) {
                // One line longer than the window: widen and read again.
                windowBytes *= 2
                continue
            }
            // A last line with no newline is read if it is whole JSON (the
            // scanner does the same); a torn write simply fails to parse.
            if (atEnd) usable = chunk.length

            let position = 0
            while (position < usable) {
                const newline = chunk.indexOf(0x0a, position)
                const lineEnd = newline === -1 || newline >= usable ? usable : newline
                const event = parseSessionLogLine(chunk.toString('utf-8', position, lineEnd))
                position = lineEnd + 1
                if (!event) continue
                const index = eventIndex
                eventIndex += 1

                // Title events are metadata (the live launcher routes them to
                // the session title); the listing counts exactly these rows.
                if (!isConversationRow(event as unknown as Record<string, unknown>)) continue

                const message = toImportedMessage(event, sessionId, index, modifiedAt)
                const stored = { ...message, content: truncateOversizedMessageContent(message.content) as ClaudeImportedMessage['content'] }
                messages.push(stored)
                pageChars += JSON.stringify(stored).length
                if (pageChars >= IMPORT_PAGE_BUDGET_CHARS) break
            }
            offset += Math.min(position, usable)
        }

        return offset < size
            ? { messages, nextCursor: { byteOffset: offset, eventIndex } }
            : { messages }
    } finally {
        await handle.close().catch(() => undefined)
    }
}

/**
 * The transcripts `ids` name, each with one page of its conversation.
 *
 * Without `cursor` this is the first page and carries everything the hub
 * needs to decide on the import (title, liveness, worktree); with it, `ids`
 * must name exactly one session and only that session's next page is read.
 */
export async function listLocalClaudeSessionsWithMessagesByIds(
    ids: Set<string>,
    cwd?: string | null,
    cursor?: ClaudeTranscriptCursor
): Promise<ClaudeLocalSessionWithMessages[]> {
    if (ids.size === 0) return []
    if (cursor && ids.size !== 1) throw new Error('A transcript cursor applies to exactly one session')
    const unresolved = new Set(ids)
    const sessions: ClaudeLocalSessionWithMessages[] = []
    const holders = cursor ? null : sessionHolders()
    for (const candidate of collectSortedClaudeSessionFiles(cwd)) {
        // The filename is the session id in every transcript Claude writes, so
        // this skips files nobody asked for without opening them.
        if (!unresolved.has(sessionIdFromFile(candidate.file))) continue
        const summary = await summariseClaudeLocalSession(candidate)
        if (!summary || !unresolved.has(summary.id)) continue
        unresolved.delete(summary.id)
        const page = await readClaudeTranscriptPage(candidate.file, summary.id, candidate.modifiedAt, cursor ?? { byteOffset: 0, eventIndex: 0 })
        if ('error' in page) throw new Error(page.error)
        // Only on the first page: the hub needs it to decide who owns the
        // adopted session, and nothing in the listing does.
        const worktree = !cursor && summary.cwd ? detectWorktreeOrigin(summary.cwd) : null
        sessions.push({
            ...summary,
            ...livenessOf(holders, summary.id),
            ...(worktree ? { worktree } : {}),
            messages: page.messages,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
        })
        if (unresolved.size === 0) break
    }
    return sessions
}
