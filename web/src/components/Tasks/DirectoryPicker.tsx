import { useMemo, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
 *
 * A new project usually sits *beside* the ones a person already has, so the
 * picker can make a folder where it stands — the runner creates it under the
 * same fence — and the person's own directories are one tap away.
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

function joinPath(dir: string, name: string): string {
    return `${dir.replace(/\/+$/, '')}/${name}`
}

/** True when `path` sits inside (or is) one of the roots the runner allows. */
function isWithinRoots(path: string, roots: readonly string[]): boolean {
    if (roots.length === 0) return true
    return roots.some((root) => path === root || path.startsWith(`${root.replace(/\/+$/, '')}/`))
}

/** Can we go up without leaving the allowed roots? */
export function canGoUp(path: string, roots: readonly string[]): boolean {
    if (path === '/' ) return false
    const parent = parentOf(path)
    return parent !== path && isWithinRoots(parent, roots)
}

/**
 * Why a folder name cannot be used, or null when it can. One segment only:
 * nesting is the runner's `create-directory` contract, not something to
 * reinterpret here.
 */
export function folderNameProblem(name: string): 'empty' | 'separator' | 'reserved' | null {
    const trimmed = name.trim()
    if (!trimmed) return 'empty'
    if (/[\\/]/.test(trimmed)) return 'separator'
    if (trimmed === '.' || trimmed === '..') return 'reserved'
    return null
}

export function DirectoryPicker(props: {
    api: ApiClient | null
    machineId: string
    roots: readonly string[]
    initialPath: string
    /** The selected user's own directories; one tap each. */
    shortcuts?: readonly string[]
    allowCreate?: boolean
    onPick: (path: string) => void
    onClose: () => void
}) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [path, setPath] = useState(() => props.initialPath || props.roots[0] || '/')
    // null = not creating; a string is the name being typed.
    const [newFolder, setNewFolder] = useState<string | null>(null)
    const [createError, setCreateError] = useState<string | null>(null)
    const [isCreating, setIsCreating] = useState(false)

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
    // Only directories the runner would let us reach are worth offering.
    const shortcuts = useMemo(
        () => (props.shortcuts ?? []).filter((entry) => isWithinRoots(entry, props.roots)),
        [props.shortcuts, props.roots]
    )

    const upAllowed = canGoUp(path, props.roots)
    const error = query.data?.success === false
        ? query.data.error
        : query.error ? readableError(query.error) : null

    const createFolder = async () => {
        if (!props.api || newFolder === null) return
        const name = newFolder.trim()
        const problem = folderNameProblem(name)
        if (problem === 'empty') return
        if (problem) {
            setCreateError(t(`board.picker.badName.${problem}`))
            return
        }
        setIsCreating(true)
        setCreateError(null)
        try {
            const result = await props.api.createMachineDirectory(props.machineId, joinPath(path, name))
            if (!result.success) {
                setCreateError(result.error ?? t('board.picker.createFailed'))
                return
            }
            // The listing we came from is stale now; the new folder is the
            // natural place to be, since the point was to work there.
            await queryClient.invalidateQueries({ queryKey: ['machine-directory', props.machineId, path] })
            setNewFolder(null)
            setPath(result.path ?? joinPath(path, name))
        } catch (err) {
            setCreateError(readableError(err))
        } finally {
            setIsCreating(false)
        }
    }

    const rowClass = 'pw-row-fill flex w-full items-center gap-2.5 border-b border-[var(--app-border)] px-5 py-2.5 text-left text-[15px]'

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

                        {/* Where this person's work already is. Shown by folder
                            name: inside one fence the paths share their prefix,
                            and the name is what tells them apart. */}
                        {shortcuts.length > 0 ? (
                            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                <span className="pw-eyebrow text-[var(--app-hint)]">{t('board.picker.mine')}</span>
                                {shortcuts.map((entry) => (
                                    <button
                                        key={entry}
                                        type="button"
                                        onClick={() => setPath(entry)}
                                        title={entry}
                                        className="pw-underline font-mono text-xs text-[var(--app-fg)]"
                                    >
                                        {entry.split('/').filter(Boolean).pop() ?? entry}
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
                                className={`${rowClass} text-[var(--app-hint)]`}
                            >
                                {t('board.picker.up')}
                            </button>
                        ) : null}

                        {newFolder !== null ? (
                            <form
                                onSubmit={(event) => {
                                    event.preventDefault()
                                    void createFolder()
                                }}
                                className="border-b border-[var(--app-border)] px-5 py-2.5"
                            >
                                <div className="flex items-center gap-2.5">
                                    <FolderIcon className="shrink-0 text-[var(--app-hint)]" />
                                    <input
                                        autoFocus
                                        value={newFolder}
                                        onChange={(event) => {
                                            setNewFolder(event.target.value)
                                            setCreateError(null)
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Escape') {
                                                event.stopPropagation()
                                                setNewFolder(null)
                                            }
                                        }}
                                        placeholder={t('board.picker.newFolderPlaceholder')}
                                        aria-label={t('board.picker.newFolder')}
                                        disabled={isCreating}
                                        className="w-full min-w-0 rounded-none border-0 border-b border-[var(--app-rule)] bg-transparent pb-[3px] pt-0.5 font-mono text-[13px] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus-visible:outline-none"
                                    />
                                    <Button type="submit" size="sm" disabled={isCreating || folderNameProblem(newFolder) === 'empty'}>
                                        {t('board.picker.create')}
                                    </Button>
                                    <button
                                        type="button"
                                        onClick={() => setNewFolder(null)}
                                        disabled={isCreating}
                                        className="shrink-0 text-xs font-semibold text-[var(--app-hint)] transition-colors duration-300 hover:text-[var(--app-fg)]"
                                    >
                                        {t('board.picker.cancel')}
                                    </button>
                                </div>
                                {createError ? (
                                    <p role="alert" className="mt-1.5 text-[13px] text-[var(--app-accent)]">{createError}</p>
                                ) : null}
                            </form>
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
                                    onClick={() => setPath(joinPath(path, entry.name))}
                                    className={`${rowClass} text-[var(--app-fg)]`}
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

                    <footer className="flex items-center gap-2 border-t border-[var(--app-rule)] px-5 py-4">
                        {props.allowCreate ? (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={newFolder !== null || query.isLoading || Boolean(error)}
                                onClick={() => {
                                    setNewFolder('')
                                    setCreateError(null)
                                }}
                            >
                                {t('board.picker.newFolder')}
                            </Button>
                        ) : null}
                        <div className="ml-auto flex items-center gap-2">
                            <Button type="button" variant="outline" onClick={props.onClose}>
                                {t('board.picker.cancel')}
                            </Button>
                            <Button type="button" onClick={() => props.onPick(path)}>
                                {t('board.picker.use')}
                            </Button>
                        </div>
                    </footer>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    )
}
