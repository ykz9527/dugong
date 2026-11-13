import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getFlavorLabel } from '@hapi/protocol'
import { readableError, type ApiClient } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'
import { SelectControl } from '@/components/ui/select-control'

const ALL_DIRECTORIES = '__all__'

/** Agents whose sessions the hub can import and a card can resume. */
export const ADOPTABLE_FLAVORS = ['claude', 'codex'] as const
export type AdoptableFlavor = typeof ADOPTABLE_FLAVORS[number]

/** A native session as the picker lists it, whichever agent ran it. */
export type AdoptableSession = {
    id: string
    title: string
    cwd?: string | null
    lastUserMessage?: string | null
    modifiedAt: number
    messageCount?: number
    /** Claude only: the transcript is still being written. */
    live?: boolean
    /** Claude only: the session already has a HAPI row. */
    hapiSessionId?: string
}

/** The runner's list, or its refusal as an error (usually actionable: an
 *  out-of-date runner, no machine online). */
async function listAdoptableSessions(api: ApiClient, flavor: AdoptableFlavor, machineId: string): Promise<AdoptableSession[]> {
    if (flavor === 'codex') {
        // Codex import re-syncs a session already in the hub instead of
        // refusing it, so nothing here is marked unselectable.
        const response = await api.getCodexSessions(null, machineId)
        if (!response.success) throw new Error(response.error)
        return response.sessions
    }
    const response = await api.getClaudeSessions(null, machineId)
    if (!response.success) throw new Error(response.error)
    return response.sessions
}

/**
 * Pick a Claude Code or Codex session that was started outside dugong.
 *
 * Single-select on purpose: the result is one task, and a task is one
 * conversation. A Claude session that already has a HAPI row, or whose
 * transcript is still being written by a live `claude`, is listed but not
 * selectable — seeing why it cannot be adopted beats it silently missing.
 */
export function AdoptSessionPicker(props: {
    api: ApiClient | null
    flavor: AdoptableFlavor
    machineId: string
    selectedId: string | null
    onSelect: (session: AdoptableSession | null) => void
}) {
    const { t } = useTranslation()
    const agent = getFlavorLabel(props.flavor)
    const [query, setQuery] = useState('')
    const [directory, setDirectory] = useState(ALL_DIRECTORIES)

    const { api, flavor, machineId } = props
    const listing = useQuery({
        queryKey: ['adoptable-sessions', flavor, machineId],
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await listAdoptableSessions(api, flavor, machineId)
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
                ) : filtered.length === 0 ? (
                    <p className="px-3 py-6 text-center text-[13px] text-[var(--app-hint)]">{t('board.adopt.empty', { agent })}</p>
                ) : (
                    <div className="divide-y divide-[var(--app-border)]">
                        {filtered.map((session) => {
                            const blocked = Boolean(session.live) || Boolean(session.hapiSessionId)
                            const selected = props.selectedId === session.id
                            return (
                                <label
                                    key={session.id}
                                    className={`flex items-start gap-2.5 px-3 py-2.5 ${
                                        blocked
                                            ? 'cursor-not-allowed opacity-60'
                                            : 'pw-row-fill cursor-pointer'
                                    }`}
                                >
                                    <input
                                        type="radio"
                                        name="adopt-session"
                                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--app-fg)]"
                                        checked={selected}
                                        disabled={blocked}
                                        onChange={() => props.onSelect(session)}
                                    />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-baseline gap-2 text-[15px] text-[var(--app-fg)]">
                                            <span className="truncate">{session.title}</span>
                                            {session.live ? (
                                                <span className="pw-eyebrow shrink-0 text-[var(--app-badge-warning-text)]">
                                                    {t('board.adopt.live')}
                                                </span>
                                            ) : session.hapiSessionId ? (
                                                <span className="pw-eyebrow shrink-0 text-[var(--app-hint)]">
                                                    {t('board.adopt.alreadyImported')}
                                                </span>
                                            ) : null}
                                        </span>
                                        <span className="mt-0.5 block truncate font-mono text-xs text-[var(--app-hint)]">
                                            {session.cwd ?? session.id}
                                        </span>
                                        <span className="mt-0.5 block text-xs text-[var(--app-hint)]">
                                            {new Date(session.modifiedAt).toLocaleString()}
                                            {session.messageCount !== undefined ? ` · ${t('board.adopt.messages', { n: session.messageCount })}` : null}
                                        </span>
                                    </span>
                                </label>
                            )
                        })}
                    </div>
                )}
            </div>
            <p className="text-xs text-[var(--app-hint)]">{t('board.adopt.liveHint')}</p>
        </div>
    )
}
