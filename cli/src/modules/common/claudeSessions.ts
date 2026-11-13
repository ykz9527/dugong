import { readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import type {
    ClaudeImportedMessage,
    ClaudeLocalSessionSummary,
    ClaudeLocalSessionWithMessages
} from '@hapi/protocol/apiTypes'
import { isClaudeChatVisibleMessage } from '@hapi/protocol/messages'
import type { RawJSONLines } from '@/claude/types'
import { encodeProjectDirName, getProjectPath } from '@/claude/utils/path'
import { readSessionLog } from '@/claude/utils/sessionScanner'
import { extractRawUserTextContent, isExternalUserMessage } from '@/claude/utils/externalUserMessage'
import { detectWorktreeOrigin } from './worktreeOrigin'

/**
 * Discovery for Claude Code sessions that were started with the bare `claude`
 * CLI, so the board can adopt one that HAPI never spawned.
 *
 * The Codex and Pi equivalents each carry a few hundred lines of transcript
 * translation, because their on-disk formats are nothing like a HAPI message.
 * Claude needs none of that: `readSessionLog` is the same reader the live
 * scanner uses, and the rows it returns are exactly what the CLI forwards over
 * the socket. So this file only has to *find* sessions and label them — the
 * conversion is two shapes copied from `sendClaudeSessionMessage`.
 */

/**
 * How many sessions an unscoped listing returns.
 *
 * Sorted newest-first, so this is also how much gets read: the scan stops as
 * soon as it has enough. A picker nobody scrolls past the first screen of does
 * not earn the seconds that reading every transcript on a long-lived machine
 * costs, and anything older is reachable by narrowing to its directory.
 */
const DEFAULT_CLAUDE_SESSION_SCAN_LIMIT = 40

/**
 * Sessions a running `claude` is provably working on.
 *
 * Each session gets a scratch directory under `/tmp/claude-<uid>/<cwd>/<id>/`
 * and its process keeps a descriptor on it, so reading the process table
 * answers "is this one live" as a fact rather than from how recently the
 * transcript was written — which cannot tell a session still thinking from
 * one quit ten seconds ago.
 *
 * One-directional: a hit means live, a miss means *unknown*. Not every
 * running agent holds such a descriptor, including ones inside a served
 * workspace, so the caller must keep its own check for the misses rather than
 * reading absence as "safe to adopt".
 *
 * Returns null where the question cannot be asked at all (no /proc).
 */
const SCRATCH_DIR_SESSION = /^\/tmp\/claude-\d+\/[^/]+\/([0-9a-f-]{36})(?:\/|$)/

function transcriptsHeldOpen(): Set<string> | null {
    if (process.platform !== 'linux') return null
    let pids: string[]
    try {
        pids = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))
    } catch {
        return null
    }

    const held = new Set<string>()
    for (const pid of pids) {
        // Every read here races the process exiting; a vanished pid is not an
        // error, it is an answer.
        try {
            if (readFileSync(`/proc/${pid}/comm`, 'utf-8').trim() !== 'claude') continue
        } catch {
            continue
        }
        let fds: string[]
        try {
            fds = readdirSync(`/proc/${pid}/fd`)
        } catch {
            continue
        }
        for (const fd of fds) {
            try {
                const match = SCRATCH_DIR_SESSION.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))
                if (match) held.add(match[1])
            } catch {
                continue
            }
        }
    }
    return held
}

type ClaudeSessionFileCandidate = {
    file: string
    modifiedAt: number
    discoveryIndex: number
}

type ParsedClaudeSession = {
    summary: ClaudeLocalSessionSummary
    messages: ClaudeImportedMessage[]
}

function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function getClaudeProjectsRoot(): string {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
    return join(claudeConfigDir, 'projects')
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
 * `cwd` narrows to a single project rather than filtering afterwards: Claude
 * derives its project directory name from the working directory itself
 * (`getProjectPath`), so asking about one directory never has to read another
 * one's transcripts. On a machine with a long history that is the difference
 * between opening one file and opening every file.
 */
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
            return [{ file, modifiedAt: statSync(file).mtimeMs, discoveryIndex }]
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
): ClaudeImportedMessage | null {
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
 * Rows Claude Code writes for its own bookkeeping, never conversation.
 * Mirrors the live scanner's list; kept here so the summary path can skip
 * them without paying for a full schema parse.
 */
const INTERNAL_ROW_TYPES = new Set(['file-history-snapshot', 'change', 'queue-operation'])

/**
 * A listing-only pass over one transcript.
 *
 * Same filters as the import path, minus the schema validation: a summary
 * needs a title, a directory, the last thing said and a count, and running
 * every row through `RawJSONLinesSchema` to get them costs more than reading
 * the file did. Measured over ~390MB of local transcripts: 1.6s to read,
 * 3.4s to JSON.parse, and another 3.5s to validate.
 *
 * The import path keeps the strict parse — those rows are persisted and
 * replayed to clients, so they have to be the shape everything downstream
 * expects. Here nothing survives past the summary.
 */
function summariseClaudeLocalSession(
    filePath: string,
    modifiedAt: number,
    heldOpen: Set<string> | null
): ClaudeLocalSessionSummary | null {
    let content: string
    try {
        content = readFileSync(filePath, 'utf-8')
    } catch {
        return null
    }

    let sessionId: string | null = null
    let cwd: string | null = null
    let nativeTitle: string | null = null
    let summaryTitle: string | null = null
    let firstUserMessage: string | null = null
    let lastUserMessage: string | null = null
    let messageCount = 0

    for (const line of content.split('\n')) {
        if (!line.trim()) continue
        let row: Record<string, unknown>
        try {
            row = JSON.parse(line) as Record<string, unknown>
        } catch {
            continue
        }
        const type = row.type
        if (typeof type !== 'string' || INTERNAL_ROW_TYPES.has(type)) continue

        sessionId ??= typeof row.sessionId === 'string' ? row.sessionId : null
        cwd ??= typeof row.cwd === 'string' ? row.cwd : null

        if (type === 'ai-title') {
            if (typeof row.aiTitle === 'string') nativeTitle = row.aiTitle
            continue
        }
        if (type === 'summary') {
            if (typeof row.summary === 'string') summaryTitle ??= row.summary
            continue
        }
        if (row.isMeta === true || row.isCompactSummary === true) continue
        if (!isClaudeChatVisibleMessage(row as { type: unknown; subtype?: unknown })) continue

        messageCount += 1
        if (isExternalUserMessage(row as unknown as RawJSONLines)) {
            const text = extractRawUserTextContent((row.message as { content?: unknown })?.content)?.trim()
            if (text) {
                firstUserMessage ??= text
                lastUserMessage = text
            }
        }
    }

    const resolvedId = sessionId ?? sessionIdFromFile(filePath)
    if (!resolvedId) return null

    return {
        id: resolvedId,
        title: nativeTitle
            ?? summaryTitle
            ?? (firstUserMessage ? truncateText(firstUserMessage, 80) : null)
            ?? (cwd ? basename(cwd) || cwd : null)
            ?? resolvedId.slice(0, 8),
        lastUserMessage: lastUserMessage ? truncateText(lastUserMessage, 140) : null,
        cwd,
        file: filePath,
        modifiedAt,
        messageCount,
        ...(heldOpen ? { live: heldOpen.has(resolvedId) } : {})
    }
}

async function parseClaudeLocalSession(
    filePath: string,
    knownModifiedAt?: number
): Promise<ParsedClaudeSession | null> {
    let modifiedAt: number
    try {
        modifiedAt = knownModifiedAt ?? statSync(filePath).mtimeMs
    } catch {
        return null
    }

    const { events } = await readSessionLog(filePath, 0)
    if (events.length === 0) return null

    let sessionId: string | null = null
    let cwd: string | null = null
    let nativeTitle: string | null = null
    let summaryTitle: string | null = null
    let firstUserMessage: string | null = null
    let lastUserMessage: string | null = null
    const messages: ClaudeImportedMessage[] = []

    for (const [index, { event }] of events.entries()) {
        sessionId ??= event.sessionId ?? null
        cwd ??= event.cwd ?? null

        // Claude Code's own title events. Metadata, never chat rows — the live
        // launcher routes these to the session title for the same reason.
        if (event.type === 'ai-title') {
            nativeTitle = event.aiTitle
            continue
        }
        if (event.type === 'summary') {
            summaryTitle ??= event.summary
            continue
        }
        if (event.isMeta || event.isCompactSummary) continue
        if (!isClaudeChatVisibleMessage(event)) continue

        const message = toImportedMessage(event, sessionId ?? sessionIdFromFile(filePath), index, modifiedAt)
        if (!message) continue
        if (message.content.role === 'user') {
            const text = message.content.content.text
            if (text) {
                firstUserMessage ??= text
                lastUserMessage = text
            }
        }
        messages.push(message)
    }

    const resolvedId = sessionId ?? sessionIdFromFile(filePath)
    if (!resolvedId) return null

    const title = nativeTitle
        ?? summaryTitle
        ?? (firstUserMessage ? truncateText(firstUserMessage, 80) : null)
        ?? (cwd ? basename(cwd) || cwd : null)
        ?? resolvedId.slice(0, 8)

    return {
        summary: {
            id: resolvedId,
            title,
            lastUserMessage: lastUserMessage ? truncateText(lastUserMessage, 140) : null,
            cwd,
            file: filePath,
            modifiedAt,
            messageCount: messages.length
        },
        messages
    }
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
    const heldOpen = transcriptsHeldOpen()
    for (const candidate of collectSortedClaudeSessionFiles(cwd, roots)) {
        const summary = summariseClaudeLocalSession(candidate.file, candidate.modifiedAt, heldOpen)
        if (!summary || seenIds.has(summary.id)) continue
        // A transcript with nothing visible in it is a stub Claude left behind
        // (a session that never got a turn); adopting one gives an empty card.
        if (summary.messageCount === 0) continue
        seenIds.add(summary.id)
        if (accept && !(await accept(summary))) continue
        summaries.push(summary)
        if (summaries.length >= limit) break
    }
    return summaries
}

export async function listLocalClaudeSessionsWithMessagesByIds(
    ids: Set<string>,
    cwd?: string | null
): Promise<ClaudeLocalSessionWithMessages[]> {
    if (ids.size === 0) return []
    const unresolved = new Set(ids)
    const sessions: ClaudeLocalSessionWithMessages[] = []
    const heldOpen = transcriptsHeldOpen()
    for (const candidate of collectSortedClaudeSessionFiles(cwd)) {
        // The filename is the session id in every transcript Claude writes, so
        // this skips parsing whole files nobody asked for.
        if (!unresolved.has(sessionIdFromFile(candidate.file))) continue
        const parsed = await parseClaudeLocalSession(candidate.file, candidate.modifiedAt)
        if (!parsed || !unresolved.has(parsed.summary.id)) continue
        unresolved.delete(parsed.summary.id)
        // Only on the import path: the hub needs it to decide who owns the
        // adopted session, and nothing in the listing does.
        const worktree = parsed.summary.cwd ? detectWorktreeOrigin(parsed.summary.cwd) : null
        sessions.push({
            ...parsed.summary,
            ...(heldOpen ? { live: heldOpen.has(parsed.summary.id) } : {}),
            ...(worktree ? { worktree } : {}),
            messages: parsed.messages
        })
        if (unresolved.size === 0) break
    }
    return sessions
}
