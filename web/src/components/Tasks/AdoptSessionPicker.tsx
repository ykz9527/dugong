import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getFlavorLabel } from '@hapi/protocol'
import { readableError, type ApiClient } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'
import { SelectControl } from '@/components/ui/select-control'
import { formatFileSize } from '@/lib/file-metadata'
import type { ClaudeSessionHolder } from '@hapi/protocol/apiTypes'

const ALL_DIRECTORIES = '__all__'

/** Agents whose sessions the hub can import and a card can resume. */
export const ADOPTABLE_FLAVORS = ['claude', 'codex', 'agy'] as const
export type AdoptableFlavor = typeof ADOPTABLE_FLAVORS[number]

/** A native session as the picker lists it, whichever agent ran it. */
export type AdoptableSession = {
    id: string
    title: string
    cwd?: string | null
    lastUserMessage?: string | null
    modifiedAt: number
    /** Absent when the machine read only the ends of a long transcript. */
    messageCount?: number
    /** Claude and agy: transcript bytes, shown when there is no count. */
    size?: number
    /** Claude and agy: `running` when a process writes it now, `unsure` when
     *  something suggests it might (see the hub's `classifyLiveness`). */
    liveness?: 'running' | 'unsure'
    /** Claude and agy: the processes tied to it, shown as the reason. */
    holders?: ClaudeSessionHolder[]
    /** Claude and agy: the session already has a HAPI row. */
    hapiSessionId?: string
    /** Set when the operator picked an `unsure` session by confirming it is closed. */
    force?: boolean
}

/** The runner's list, or its refusal as an error (usually actionable: an
 *  out-of-date runner, no machine online). */
async function listAdoptableSessions(
    api: ApiClient,
    flavor: AdoptableFlavor,
    machineId: string,
    workspaceUserId: string | null
): Promise<AdoptableSession[]> {
    if (flavor === 'codex') {
        // Codex import re-syncs a session already in the hub instead of
        // refusing it, so nothing here is marked unselectable.
        const response = await api.getCodexSessions(null, machineId, workspaceUserId)
        if (!response.success) throw new Error(response.error)
        return response.sessions
    }
    if (flavor === 'agy') {
        const response = await api.getAgySessions(machineId, workspaceUserId)
        if (!response.success) throw new Error(response.error)
        return response.sessions
    }
    const response = await api.getClaudeSessions(null, machineId, workspaceUserId)
    if (!response.success) throw new Error(response.error)
    return response.sessions
}

/** " · 12 messages", or " · 104 MB" for a transcript too long to count. */
function sessionExtent(session: AdoptableSession, t: ReturnType<typeof useTranslation>['t']): string | null {
    if (session.messageCount !== undefined) return ` · ${t('board.adopt.messages', { n: session.messageCount })}`
    const size = formatFileSize(session.size)
    return size ? ` · ${size}` : null
}

const LIVE_WRITE_WINDOW_MS = 60_000

/**
 * Why a session looks in use, in a line: the processes tied to it, or a write
 * in the last minute. "Still running" alone reads as a bug to someone who
 * believes they closed it; the pid and what started it tell them where to look.
 */
function livenessReason(session: AdoptableSession, t: ReturnType<typeof useTranslation>['t']): string | null {
    if (!session.liveness) return null
    const holders = session.holders ?? []
    const relevant = session.liveness === 'running' ? holders.filter((holder) => holder.current) : holders
    const parts = relevant.map((holder) => {
        const by = holder.launcher === 'terminal' ? t('board.adopt.byTerminal') : holder.launcher ?? t('board.adopt.byUnknown')
        const fields = [`PID ${holder.pid}`, by, holder.status].filter(Boolean).join(' · ')
        return holder.current ? fields : t('board.adopt.heldButMovedOn', { process: fields })
    })
    if (Date.now() - session.modifiedAt < LIVE_WRITE_WINDOW_MS) parts.push(t('board.adopt.writtenRecently'))
    return parts.length > 0 ? parts.join('; ') : null
}

/**
 * Pick a Claude Code, Codex or agy session that was started outside dugong.
 *
 * Single-select on purpose: the result is one task, and a task is one
 * conversation. A Claude session that already has a HAPI row, or that a live
 * `claude` is writing, is listed but not selectable — seeing why it cannot be
 * adopted beats it silently missing. One that only *might* be in use is
 * selectable through "I confirm it is closed", never by a plain click.
 */
export function AdoptSessionPicker(props: {
    api: ApiClient | null
    flavor: AdoptableFlavor
    machineId: string
    /** Whose directories to list; null lists every session on the machine. */
    activeUser: { id: string; name: string; paths: readonly string[] } | null
    selectedId: string | null
    onSelect: (session: AdoptableSession | null) => void
}) {
    const { t } = useTranslation()
    const agent = getFlavorLabel(props.flavor)
    const [query, setQuery] = useState('')
    const [directory, setDirectory] = useState(ALL_DIRECTORIES)

    const { api, flavor, machineId, activeUser } = props
    // Someone else's session is still adoptable (a colleague's terminal left
    // behind), so "all" is one click away rather than hidden.
    const [showAll, setShowAll] = useState(false)
    const scopedUser = activeUser && !showAll ? activeUser : null
    const ownsNothing = scopedUser !== null && scopedUser.paths.length === 0
    const listing = useQuery({
        queryKey: ['adoptable-sessions', flavor, machineId, scopedUser?.id ?? null],
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await listAdoptableSessions(api, flavor, machineId, scopedUser?.id ?? null)
        },
        enabled: Boolean(api && machineId),
        // Reading the agent's transcripts is slow, and a refusal is not
        // going to change on a second ask.
        retry: false
    })
    const sessions = useMemo(() => listing.data ?? [], [listing.data])
    const isLoading = listing.isLoading
    const error = listing.error ? readableError(listing.error) : null

    const directories = useMemo(() => Array.from(new Set(sessions
        .map((session) => session.cwd?.trim())
        .filter((value): value is string => Boolean(value)))).sort(), [sessions])

    const filtered = useMemo(() => {
        const normalized = query.trim().toLowerCase()
        return sessions.filter((session) => {
            if (directory !== ALL_DIRECTORIES && session.cwd !== directory) return false
            if (!normalized) return true
            return [session.title, session.lastUserMessage, session.cwd, session.id]
                .filter((value): value is string => typeof value === 'string')
                .some((value) => value.toLowerCase().includes(normalized))
        })
    }, [directory, query, sessions])

    // Same underline field as the rest of the new-task form.
    const fieldClass = 'w-full min-w-0 rounded-none border-0 border-b border-[var(--app-rule)] bg-transparent pb-[7px] pt-1.5 text-[15px] leading-[1.3] text-[var(--app-fg)] placeholder:text-[var(--app-hint)]'

    if (!props.machineId) {
        return (
            <p className="border-y border-[var(--app-border)] py-4 text-[13px] text-[var(--app-hint)]">
                {t('board.adopt.needsMachine', { agent })}
            </p>
        )
    }

    return (
        <div className="flex flex-col gap-3">
            {directories.length > 1 ? (
                <SelectControl
                    chevronClassName="right-0"
                    aria-label={t('board.adopt.directory')}
                    value={directory}
                    onChange={(event) => {
                        setDirectory(event.target.value)
                        // A selection that the new filter hides would otherwise
                        // stay armed invisibly, and Create would adopt a session
                        // no longer on screen.
                        props.onSelect(null)
                    }}
                    className="w-full min-w-0 rounded-none border-0 border-b border-[var(--app-rule)] bg-transparent pb-[7px] pr-6 pt-1.5 font-mono text-[13px] leading-[1.5] text-[var(--app-fg)]"
                >
                    <option value={ALL_DIRECTORIES}>{t('board.adopt.allDirectories')}</option>
                    {directories.map((value) => <option key={value} value={value}>{value}</option>)}
                </SelectControl>
            ) : null}
            <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('board.adopt.search')}
                className={fieldClass}
            />
            <div className="max-h-56 overflow-y-auto border border-[var(--app-border)]">
                {isLoading ? (
                    <p className="px-3 py-6 text-center text-[13px] text-[var(--app-hint)]">{t('board.adopt.loading', { agent })}</p>
                ) : error ? (
                    <p role="alert" className="px-3 py-6 text-center text-[13px] text-[var(--app-accent)]">{error}</p>
                ) : ownsNothing ? (
                    <p className="px-3 py-6 text-center text-[13px] text-[var(--app-badge-warning-text)]">
                        {t('board.adopt.userOwnsNothing', { name: scopedUser.name })}
                    </p>
                ) : filtered.length === 0 ? (
                    <p className="px-3 py-6 text-center text-[13px] text-[var(--app-hint)]">
                        {scopedUser
                            ? t('board.adopt.emptyForUser', { agent, name: scopedUser.name })
                            : t('board.adopt.empty', { agent })}
                    </p>
                ) : (
                    <div className="divide-y divide-[var(--app-border)]">
                        {filtered.map((session) => {
                            const confirmable = session.liveness === 'unsure' && !session.hapiSessionId
                            const blocked = Boolean(session.liveness) || Boolean(session.hapiSessionId)
                            const selected = props.selectedId === session.id
                            const reason = session.hapiSessionId ? null : livenessReason(session, t)
                            return (
                                <label
                                    key={session.id}
                                    className={`flex items-start gap-2.5 px-3 py-2.5 ${
                                        // An unsure row stays readable: its reason and the
                                        // confirmation are the point of showing it.
                                        confirmable
                                            ? ''
                                            : blocked
                                                ? 'cursor-not-allowed opacity-60'
                                                : 'pw-row-fill cursor-pointer'
                                    }`}
                                >
                                    <input
                                        type="radio"
                                        name="adopt-session"
                                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--app-fg)]"
                                        checked={selected}
                                        disabled={blocked && !(confirmable && selected)}
                                        onChange={() => props.onSelect(session)}
                                    />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-baseline gap-2 text-[15px] text-[var(--app-fg)]">
                                            <span className="truncate">{session.title}</span>
                                            {/* A task first: its own agent being alive is why it
                                                looks running, and the task is where to go. */}
                                            {session.hapiSessionId ? (
                                                <span className="pw-eyebrow shrink-0 text-[var(--app-hint)]">
                                                    {t('board.adopt.alreadyImported')}
                                                </span>
                                            ) : session.liveness ? (
                                                <span className="pw-eyebrow shrink-0 text-[var(--app-badge-warning-text)]">
                                                    {t(session.liveness === 'running' ? 'board.adopt.live' : 'board.adopt.maybeLive')}
                                                </span>
                                            ) : null}
                                        </span>
                                        <span className="mt-0.5 block truncate font-mono text-xs text-[var(--app-hint)]">
                                            {session.cwd ?? session.id}
                                        </span>
                                        <span className="mt-0.5 block text-xs text-[var(--app-hint)]">
                                            {new Date(session.modifiedAt).toLocaleString()}
                                            {sessionExtent(session, t)}
                                        </span>
                                        {reason ? (
                                            <span className="mt-0.5 block text-xs text-[var(--app-badge-warning-text)]">{reason}</span>
                                        ) : null}
                                        {confirmable && !selected ? (
                                            <button
                                                type="button"
                                                className="pw-underline mt-1 text-xs font-semibold text-[var(--app-fg)]"
                                                onClick={() => props.onSelect({ ...session, force: true })}
                                            >
                                                {t('board.adopt.confirmClosed')}
                                            </button>
                                        ) : null}
                                    </span>
                                </label>
                            )
                        })}
                    </div>
                )}
            </div>
            <div className="flex items-baseline justify-between gap-3 text-xs text-[var(--app-hint)]">
                <p>
                    {t('board.adopt.liveHint')}
                    {flavor === 'agy' ? ` ${t('board.adopt.agyHistoryHint')}` : null}
                </p>
                {activeUser ? (
                    <button
                        type="button"
                        className="pw-underline shrink-0 font-semibold text-[var(--app-fg)]"
                        onClick={() => {
                            setShowAll((value) => !value)
                            // The selection may not be in the other list.
                            props.onSelect(null)
                        }}
                    >
                        {showAll ? t('board.adopt.onlyUser', { name: activeUser.name }) : t('board.adopt.showAll')}
                    </button>
                ) : null}
            </div>
        </div>
    )
}
