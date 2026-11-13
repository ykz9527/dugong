import { useMemo, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import { readableError, type ApiClient } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'
import { Button } from '@/components/ui/button'

/**
 * Pick a working directory on a machine.
 *
 * Typing a path by hand is not just clumsy here, it is usually wrong: the
 * runner refuses anything outside the workspace roots it was started with, so
 * a free-text field mostly produces paths the machine will reject at spawn
 * time. Browsing starts from those roots, which makes every reachable choice a
 * valid one.
 */

function FolderIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={props.className} aria-hidden="true"
        >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    )
}

function parentOf(path: string): string {
    const trimmed = path.replace(/\/+$/, '')
    const cut = trimmed.lastIndexOf('/')
    if (cut <= 0) return '/'
    return trimmed.slice(0, cut)
}

/** True when `path` sits inside (or is) one of the roots the runner allows. */
function isWithinRoots(path: string, roots: readonly string[]): boolean {
    if (roots.length === 0) return true
    return roots.some((root) => path === root || path.startsWith(`${root.replace(/\/+$/, '')}/`))
}

/**
 * Where a person browsing for their own work should be allowed to go.
 *
 * The runner's roots are a machine-wide fence, usually far wider than any one
 * person's work. Once a workspace user is selected, their directories are the
 * better starting point — and the only useful one, since a card made anywhere
 * else is filtered off the very board it was made from. Directories the runner
 * would refuse are dropped; if none survive, the machine's roots still stand.
 */
export function narrowRootsToUser(machineRoots: readonly string[], userPaths: readonly string[]): string[] {
    const reachable = userPaths.filter((path) => isWithinRoots(path, machineRoots))
    return reachable.length > 0 ? reachable : [...machineRoots]
}

/** Can we go up without leaving the allowed roots? */
export function canGoUp(path: string, roots: readonly string[]): boolean {
    if (path === '/' ) return false
    const parent = parentOf(path)
    return parent !== path && isWithinRoots(parent, roots)
}

export function DirectoryPicker(props: {
    api: ApiClient | null
    machineId: string
    roots: readonly string[]
    initialPath: string
    onPick: (path: string) => void
    onClose: () => void
}) {
    const { t } = useTranslation()
    const [path, setPath] = useState(() => props.initialPath || props.roots[0] || '/')

    const query = useQuery({
        queryKey: ['machine-directory', props.machineId, path],
        queryFn: async () => {
            if (!props.api) throw new Error('API unavailable')
            return await props.api.listMachineDirectory(props.machineId, path)
        },
        enabled: Boolean(props.api),
    })

    const directories = useMemo(
        () => (query.data?.entries ?? []).filter((entry) => entry.type === 'directory'),
        [query.data]
    )

    const upAllowed = canGoUp(path, props.roots)
    const error = query.data?.success === false
        ? query.data.error
        : query.error ? readableError(query.error) : null

    return (
        <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) props.onClose() }}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="pw-overlay fixed inset-0 z-[60] bg-black/40" />
                <DialogPrimitive.Content
                    aria-modal="true"
                    aria-describedby={undefined}
                    onPointerDownOutside={(event) => event.preventDefault()}
                    className="pw-pop fixed inset-x-0 bottom-0 z-[60] mx-auto flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden border-t border-[var(--app-rule)] bg-[var(--app-dialog-bg)] text-[var(--app-fg)] focus:outline-none sm:inset-0 sm:m-auto sm:h-fit sm:border"
                >
                    <header className="border-b border-[var(--app-rule)] px-5 py-4">
                        <DialogPrimitive.Title className="text-[17px] font-medium tracking-[-0.02em] text-[var(--app-fg)]">{t('board.picker.title')}</DialogPrimitive.Title>
                        <p className="mt-1.5 break-all font-mono text-[13px] text-[var(--app-fg)]">{path}</p>

                        {/* The runner refuses anything outside these, so an operator
                            wondering why the tree is so small deserves to see them.
                            With several roots they double as jump targets. */}
                        {props.roots.length > 0 ? (
                            <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                <span className="pw-eyebrow text-[var(--app-hint)]">{t('board.picker.scope')}</span>
                                {props.roots.map((root) => (
                                    <button
                                        key={root}
                                        type="button"
                                        disabled={props.roots.length === 1}
                                        onClick={() => setPath(root)}
                                        className={`break-all font-mono text-xs ${
                                            props.roots.length === 1
                                                ? 'text-[var(--app-hint)]'
                                                : 'pw-underline text-[var(--app-fg)]'
                                        }`}
                                    >
                                        {root}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </header>

                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {upAllowed ? (
                            <button
                                type="button"
                                onClick={() => setPath(parentOf(path))}
                                className="pw-row-fill flex w-full items-center gap-2 border-b border-[var(--app-border)] px-5 py-2.5 text-left text-[15px] text-[var(--app-hint)]"
                            >
                                {t('board.picker.up')}
                            </button>
                        ) : null}

                        {query.isLoading ? (
                            <p className="px-5 py-6 text-[13px] text-[var(--app-hint)]">{t('board.picker.loading')}</p>
                        ) : error ? (
                            <p role="alert" className="px-5 py-6 text-[13px] text-[var(--app-accent)]">{error}</p>
                        ) : directories.length === 0 ? (
                            <div className="px-5 py-6">
                                <p className="text-[15px] text-[var(--app-fg)]">{t('board.picker.empty')}</p>
                                <p className="mt-1 text-[13px] text-[var(--app-hint)]">{t('board.picker.emptyWhy')}</p>
                            </div>
                        ) : (
                            directories.map((entry) => (
                                <button
                                    key={entry.name}
                                    type="button"
                                    onClick={() => setPath(`${path.replace(/\/+$/, '')}/${entry.name}`)}
                                    className="pw-row-fill flex w-full items-center gap-2.5 border-b border-[var(--app-border)] px-5 py-2.5 text-left text-[15px] text-[var(--app-fg)]"
                                >
                                    <FolderIcon className="shrink-0 text-[var(--app-hint)]" />
                                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                                    {/* Worktree isolation needs a repo, so this is worth calling out. */}
                                    {entry.isGitRepo ? (
                                        <span className="shrink-0 font-mono text-xs text-[var(--app-hint)]">git</span>
                                    ) : null}
                                </button>
                            ))
                        )}
                    </div>

                    <footer className="flex items-center justify-end gap-2 border-t border-[var(--app-rule)] px-5 py-4">
                        <Button type="button" variant="outline" onClick={props.onClose}>
                            {t('board.picker.cancel')}
                        </Button>
                        <Button type="button" onClick={() => props.onPick(path)}>
                            {t('board.picker.use')}
                        </Button>
                    </footer>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    )
}
