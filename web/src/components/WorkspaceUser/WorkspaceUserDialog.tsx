import { useMemo, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { Machine, WorkspaceUser } from '@hapi/protocol'
import { WORKSPACE_USER_MAX_PATHS, normalizeWorkspacePath } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'
import { useWorkspaceUsers } from '@/hooks/queries/useWorkspaceUsers'
import { useWorkspaceUserActions } from '@/hooks/mutations/useWorkspaceUserActions'
import { DirectoryPicker } from '@/components/Tasks/DirectoryPicker'
import { Button } from '@/components/ui/button'
import { SelectControl } from '@/components/ui/select-control'

/**
 * Manage who works where.
 *
 * The whole feature reduces to this list, so the dialog is deliberately flat:
 * every user is a name and a set of directories, edited in place, with no
 * detail screen to navigate into. Paths are browsed rather than typed —
 * the same reasoning as the task composer's workdir field, and more so here,
 * because a path with a typo in it does not fail loudly, it just quietly
 * stops matching and the person sees an empty task list.
 */

function TrashIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" />
        </svg>
    )
}

function WorkspaceUserRow(props: {
    api: ApiClient | null
    user: WorkspaceUser
    machines: Machine[]
    isBusy: boolean
    onSave: (patch: { name?: string; paths?: string[] }) => void
    onDelete: () => void
}) {
    const { t } = useTranslation()
    const [name, setName] = useState(props.user.name)
    const [pickerOpen, setPickerOpen] = useState(false)
    // Two presses, like deleting a task: the user's directories go with it.
    const [confirmingDelete, setConfirmingDelete] = useState(false)
    const [machineId, setMachineId] = useState(props.machines[0]?.id ?? '')

    const machine = useMemo(
        () => props.machines.find((entry) => entry.id === machineId) ?? null,
        [props.machines, machineId]
    )
    const roots = machine?.metadata?.workspaceRoots ?? []

    const addPath = (path: string) => {
        const normalized = normalizeWorkspacePath(path)
        setPickerOpen(false)
        if (!normalized || props.user.paths.includes(normalized)) return
        props.onSave({ paths: [...props.user.paths, normalized] })
    }

    const removePath = (path: string) => {
        props.onSave({ paths: props.user.paths.filter((entry) => entry !== path) })
    }

    const commitName = () => {
        const trimmed = name.trim()
        if (!trimmed || trimmed === props.user.name) {
            setName(props.user.name)
            return
        }
        props.onSave({ name: trimmed })
    }

    return (
        <li className="border-b border-[var(--app-border)] px-5 py-4 last:border-b-0">
            <div className="flex items-end gap-3">
                <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    onBlur={commitName}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                    aria-label={t('workspaceUser.nameLabel')}
                    className="min-w-0 flex-1 rounded-none border-0 border-b border-[var(--app-rule)] bg-transparent pb-[7px] pt-1.5 text-[15px] leading-[1.3] text-[var(--app-fg)] placeholder:text-[var(--app-hint)]"
                />
                {confirmingDelete ? (
                    <>
                        <button
                            type="button"
                            onClick={() => {
                                setConfirmingDelete(false)
                                props.onDelete()
                            }}
                            disabled={props.isBusy}
                            className="inline-flex h-8 shrink-0 items-center rounded-full border border-[var(--app-accent)] px-3.5 text-[13px] font-semibold text-[var(--app-accent)] transition-colors duration-300 hover:bg-[var(--app-accent)] hover:text-[var(--app-bg)] disabled:opacity-50"
                        >
                            {t('workspaceUser.deleteConfirm')}
                        </button>
                        <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingDelete(false)}>
                            {t('workspaceUser.deleteCancel')}
                        </Button>
                    </>
                ) : (
                    <button
                        type="button"
                        onClick={() => setConfirmingDelete(true)}
                        disabled={props.isBusy}
                        title={t('workspaceUser.delete')}
                        aria-label={t('workspaceUser.delete')}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--app-border)] text-[var(--app-hint)] transition-colors duration-300 hover:border-[var(--app-accent)] hover:text-[var(--app-accent)] disabled:opacity-50"
                    >
                        <TrashIcon />
                    </button>
                )}
            </div>

            <ul className="mt-3 space-y-1.5">
                {props.user.paths.length === 0 ? (
                    <li className="text-[13px] text-[var(--app-accent)]">{t('workspaceUser.noPaths')}</li>
                ) : (
                    props.user.paths.map((path) => (
                        <li key={path} className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 break-all font-mono text-[13px] text-[var(--app-fg)]">{path}</span>
                            <button
                                type="button"
                                onClick={() => removePath(path)}
                                disabled={props.isBusy}
                                className="shrink-0 text-xs font-semibold text-[var(--app-hint)] transition-colors duration-300 hover:text-[var(--app-accent)] disabled:opacity-50"
                            >
                                {t('workspaceUser.removePath')}
                            </button>
                        </li>
                    ))
                )}
            </ul>

            <div className="mt-3 flex flex-wrap items-end gap-3">
                {props.machines.length > 1 ? (
                    <SelectControl
                        chevronClassName="right-0"
                        value={machineId}
                        onChange={(event) => setMachineId(event.target.value)}
                        aria-label={t('workspaceUser.browseMachine')}
                        className="rounded-none border-0 border-b border-[var(--app-rule)] bg-transparent pb-1 pr-6 pt-1 text-[13px] text-[var(--app-fg)]"
                    >
                        {props.machines.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                                {entry.metadata?.displayName || entry.metadata?.host || entry.id}
                            </option>
                        ))}
                    </SelectControl>
                ) : null}
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPickerOpen(true)}
                    disabled={props.isBusy || !machineId || props.user.paths.length >= WORKSPACE_USER_MAX_PATHS}
                >
                    {t('workspaceUser.addPath')}
                </Button>
            </div>

            {pickerOpen ? (
                <DirectoryPicker
                    api={props.api}
                    machineId={machineId}
                    roots={roots}
                    initialPath={roots[0] || machine?.metadata?.homeDir || '/'}
                    onPick={addPath}
                    onClose={() => setPickerOpen(false)}
                />
            ) : null}
        </li>
    )
}

export function WorkspaceUserDialog(props: {
    api: ApiClient | null
    machines: Machine[]
    onClose: () => void
}) {
    const { t } = useTranslation()
    const { workspaceUsers, isLoading } = useWorkspaceUsers(props.api)
    const actions = useWorkspaceUserActions(props.api)
    const [newName, setNewName] = useState('')

    const handleCreate = () => {
        const trimmed = newName.trim()
        if (!trimmed) return
        void actions.createWorkspaceUser({ name: trimmed, paths: [] })
            .then(() => setNewName(''))
            .catch(() => {})
    }

    return (
        <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) props.onClose() }}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="pw-overlay fixed inset-0 z-50 bg-black/40" />
                <DialogPrimitive.Content
                    aria-modal="true"
                    onPointerDownOutside={(event) => event.preventDefault()}
                    className="pw-pop fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden border-t border-[var(--app-rule)] bg-[var(--app-dialog-bg)] text-[var(--app-fg)] focus:outline-none sm:inset-0 sm:m-auto sm:h-fit sm:border"
                >
                    <header className="border-b border-[var(--app-rule)] px-5 py-4">
                        <DialogPrimitive.Title className="text-[17px] font-medium tracking-[-0.02em] text-[var(--app-fg)]">{t('workspaceUser.manageTitle')}</DialogPrimitive.Title>
                        <DialogPrimitive.Description className="mt-1 text-[13px] text-[var(--app-hint)]">{t('workspaceUser.manageHint')}</DialogPrimitive.Description>
                    </header>

                    {actions.error ? (
                        <p role="alert" className="px-5 pt-3 text-[13px] text-[var(--app-accent)]">
                            {actions.error}
                        </p>
                    ) : null}

                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {isLoading ? (
                            <p className="px-5 py-6 text-[13px] text-[var(--app-hint)]">{t('workspaceUser.loading')}</p>
                        ) : workspaceUsers.length === 0 ? (
                            <p className="px-5 py-6 text-[13px] text-[var(--app-hint)]">{t('workspaceUser.empty')}</p>
                        ) : (
                            <ul>
                                {workspaceUsers.map((user) => (
                                    <WorkspaceUserRow
                                        key={user.id}
                                        api={props.api}
                                        user={user}
                                        machines={props.machines}
                                        isBusy={actions.isPending}
                                        onSave={(patch) => {
                                            void actions.updateWorkspaceUser({ id: user.id, patch }).catch(() => {})
                                        }}
                                        onDelete={() => {
                                            void actions.deleteWorkspaceUser(user.id).catch(() => {})
                                        }}
                                    />
                                ))}
                            </ul>
                        )}
                    </div>

                    <footer className="flex flex-wrap items-end gap-2 border-t border-[var(--app-rule)] px-5 py-4">
                        <input
                            value={newName}
                            onChange={(event) => setNewName(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') handleCreate()
                            }}
                            placeholder={t('workspaceUser.newPlaceholder')}
                            aria-label={t('workspaceUser.newPlaceholder')}
                            className="mr-1 min-w-0 flex-1 rounded-none border-0 border-b border-[var(--app-rule)] bg-transparent pb-[7px] pt-1.5 text-[15px] leading-[1.3] text-[var(--app-fg)] placeholder:text-[var(--app-hint)]"
                        />
                        <Button
                            type="button"
                            onClick={handleCreate}
                            disabled={actions.isPending || newName.trim().length === 0}
                        >
                            {t('workspaceUser.add')}
                        </Button>
                        <Button type="button" variant="outline" onClick={props.onClose}>
                            {t('workspaceUser.done')}
                        </Button>
                    </footer>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    )
}
