import { useEffect, useMemo, useState } from 'react'
import type { PiLocalSessionSummary } from '@/types/api'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SelectControl } from '@/components/ui/select-control'
import { useTranslation } from '@/lib/use-translation'

const ALL_DIRECTORIES = '__all__'

export function PiSessionImportDialog(props: {
    isOpen: boolean
    onClose: () => void
    sessions: PiLocalSessionSummary[]
    currentSessionId: string | null
    currentWorkDirectory?: string | null
    onConfirm: (sessionIds: string[]) => Promise<void>
    isPending: boolean
    isLoading: boolean
}) {
    const { t } = useTranslation()
    const [selectedIds, setSelectedIds] = useState<string[]>([])
    const [directory, setDirectory] = useState(ALL_DIRECTORIES)
    const [query, setQuery] = useState('')

    const directories = useMemo(() => Array.from(new Set(props.sessions
        .map((session) => session.cwd?.trim())
        .filter((value): value is string => Boolean(value)))).sort(), [props.sessions])
    const filtered = useMemo(() => {
        const normalized = query.trim().toLowerCase()
        return props.sessions.filter((session) => {
            if (directory !== ALL_DIRECTORIES && session.cwd !== directory) return false
            if (!normalized) return true
            return [session.title, session.lastUserMessage, session.cwd, session.id, session.model]
                .filter((value): value is string => typeof value === 'string')
                .some((value) => value.toLowerCase().includes(normalized))
        })
    }, [directory, props.sessions, query])

    useEffect(() => {
        if (!props.isOpen) return
        setSelectedIds(props.currentSessionId ? [props.currentSessionId] : [])
        const cwd = props.currentWorkDirectory?.trim()
        setDirectory(cwd && directories.includes(cwd) ? cwd : ALL_DIRECTORIES)
        setQuery('')
    }, [directories, props.currentSessionId, props.currentWorkDirectory, props.isOpen])

    const toggle = (id: string) => {
        if (props.isPending || props.isLoading) return
        setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])
    }

    return (
        <Dialog open={props.isOpen} onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="max-w-xl">
                <DialogHeader className="text-left">
                    <DialogTitle>{t('piImport.dialog.title')}</DialogTitle>
                    <DialogDescription>{t('piImport.dialog.description')}</DialogDescription>
                </DialogHeader>
                <div className="mt-3 space-y-3">
                    <div role="note" className="text-[13px] text-[var(--app-badge-warning-text)]">
                        {t('piImport.dialog.concurrentWarning')}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        <span className="pw-eyebrow text-[var(--app-hint)]">{t('piImport.selectedCount', { n: selectedIds.length })}</span>
                        <div className="flex gap-2">
                            <Button type="button" variant="secondary" size="sm" disabled={selectedIds.length === 0 || props.isPending} onClick={() => setSelectedIds([])}>
                                {t('piImport.clearAll')}
                            </Button>
                            <Button type="button" variant="secondary" size="sm" disabled={filtered.length === 0 || props.isPending} onClick={() => setSelectedIds(filtered.map((session) => session.id))}>
                                {t('piImport.selectAll')}
                            </Button>
                        </div>
                    </div>
                    {props.sessions.length > 0 ? (
                        <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
                            <SelectControl chevronClassName="right-0" className="rounded-none border-0 border-b border-[var(--app-rule)] bg-transparent pb-[7px] pr-6 pt-1.5 text-[15px] leading-[1.3] text-[var(--app-fg)]" value={directory} disabled={props.isPending} onChange={(event) => setDirectory(event.target.value)}>
                                <option value={ALL_DIRECTORIES}>{t('piImport.allDirectories')}</option>
                                {directories.map((value) => <option key={value} value={value}>{value}</option>)}
                            </SelectControl>
                            <input
                                type="search"
                                className="w-full rounded-none border-0 border-b border-[var(--app-rule)] bg-transparent pb-[7px] pt-1.5 text-[15px] leading-[1.3] text-[var(--app-fg)] placeholder:text-[var(--app-hint)]"
                                value={query}
                                disabled={props.isPending}
                                placeholder={t('piImport.search')}
                                onChange={(event) => setQuery(event.target.value)}
                            />
                        </div>
                    ) : null}
                    <div className="max-h-[50vh] overflow-y-auto border border-[var(--app-border)]">
                        {props.isLoading ? (
                            <div className="px-4 py-8 text-center text-[13px] text-[var(--app-hint)]">{t('piImport.loading')}</div>
                        ) : filtered.length === 0 ? (
                            <div className="px-4 py-8 text-center text-[13px] text-[var(--app-hint)]">{t('piImport.empty')}</div>
                        ) : (
                            <div className="divide-y divide-[var(--app-border)]">
                                {filtered.map((session) => {
                                    const checked = selectedIds.includes(session.id)
                                    return (
                                        <label key={session.id} className="pw-row-fill flex cursor-pointer items-start gap-3 px-3 py-2.5">
                                            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--app-fg)]" checked={checked} onChange={() => toggle(session.id)} />
                                            <span className="min-w-0 flex-1">
                                                <span className="flex items-baseline gap-2 text-[15px] font-medium text-[var(--app-fg)]">
                                                    <span className="truncate">{session.title}</span>
                                                    {session.hapiSessionId ? <span className="pw-eyebrow shrink-0 text-[var(--app-hint)]">{t('piImport.imported')}</span> : null}
                                                    {session.importState === 'diverged' || session.importState === 'failed' ? <span className="pw-eyebrow shrink-0 text-[var(--app-accent)]">{t('piImport.needsAttention')}</span> : null}
                                                </span>
                                                <span className="mt-0.5 block truncate text-[13px] text-[var(--app-hint)]">{session.lastUserMessage ?? session.cwd ?? session.id}</span>
                                                <span className="mt-0.5 block text-xs text-[var(--app-hint)]">{new Date(session.modifiedAt).toLocaleString()} · {session.messageCount} {t('piImport.messages')}</span>
                                            </span>
                                        </label>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" onClick={props.onClose} disabled={props.isPending}>{t('button.cancel')}</Button>
                        <Button type="button" onClick={() => void props.onConfirm(selectedIds)} disabled={selectedIds.length === 0 || props.isPending || props.isLoading}>
                            {props.isPending ? t('piImport.importing') : t('piImport.confirm')}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
