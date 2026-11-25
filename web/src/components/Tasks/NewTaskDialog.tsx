import { useEffect, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import {
    CREATABLE_AGENT_FLAVORS,
    deriveTaskTitle,
    getDefaultPermissionModeForFlavor,
    getPermissionModeOptionsForFlavor,
    isPathOwnedBy,
    isPermissionModeAllowedForFlavor,
    type AgentFlavor,
    type PermissionMode
} from '@hapi/protocol'
import type { CreateTaskRequest } from '@hapi/protocol/apiTypes'
import type { Machine } from '@/types/api'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { getFlavorLabel } from '@hapi/protocol'
import type { AdoptTaskInput } from '@/hooks/mutations/useTaskActions'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { Button } from '@/components/ui/button'
import { SelectControl } from '@/components/ui/select-control'
import { DirectoryPicker } from './DirectoryPicker'
import { ADOPTABLE_FLAVORS, AdoptSessionPicker, type AdoptableFlavor, type AdoptableSession } from './AdoptSessionPicker'

/**
 * Compose a task.
 *
 * Only the prompt and a directory are required — a task can sit in the backlog
 * without a machine. `start` is offered only once a machine is chosen, since
 * the hub rejects that combination anyway.
 */
export function NewTaskDialog(props: {
    machines: Machine[]
    /** The workspace user being looked through, if any; their directories are the task's natural home. */
    activeUser: { id: string; name: string; paths: readonly string[] } | null
    isPending: boolean
    error: string | null
    /** Set once the task exists but did not start; the dialog then only closes. */
    startFailure?: string | null
    onSubmit: (input: CreateTaskRequest) => void
    /** `workdir` is where the adopted conversation ran; empty when the session did not say. */
    onAdopt: (input: AdoptTaskInput, workdir: string) => void
    onClose: () => void
    /** Prefill from where the composer was opened, e.g. a browsed folder. */
    initialWorkdir?: string
    initialMachineId?: string
}) {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const [isPicking, setIsPicking] = useState(false)
    const [prompt, setPrompt] = useState('')
    const [workdir, setWorkdir] = useState(props.initialWorkdir ?? '')
    const [title, setTitle] = useState('')
    const [machineId, setMachineId] = useState(props.initialMachineId ?? '')
    const [flavor, setFlavor] = useState<AgentFlavor>('claude')
    // Every run replays this, so it is a property of the task, not of one turn.
    // Starts where an unspecified Claude session starts, so the two ways of
    // making a task do not disagree about what "nobody said" means. Visible and
    // changeable before submit — a default, not a decision made for anyone.
    const [permissionMode, setPermissionMode] = useState<PermissionMode>(
        () => getDefaultPermissionModeForFlavor('claude')
    )
    const [isolation, setIsolation] = useState<'simple' | 'worktree'>('worktree')
    const [baseRef, setBaseRef] = useState('')
    const [start, setStart] = useState(false)
    // Two ways to make a task: describe work that has not happened, or take
    // over a conversation that already did.
    const [source, setSource] = useState<'prompt' | 'adopt'>('prompt')
    const [adoptFlavor, setAdoptFlavor] = useState<AdoptableFlavor>('claude')
    const [adopted, setAdopted] = useState<AdoptableSession | null>(null)

    const isAdopting = source === 'adopt'
    const created = props.startFailure != null
    const canSubmit = created ? false : isAdopting
        ? Boolean(adopted && machineId) && !props.isPending
        : prompt.trim().length > 0 && workdir.trim().length > 0 && !props.isPending
    const derivedTitle = isAdopting ? adopted?.title ?? '' : deriveTaskTitle(prompt)

    // With exactly one machine there is nothing to choose, and leaving the field
    // blank only strands the operator on a disabled Browse button. More than one
    // is a real decision, so it stays unmade.
    useEffect(() => {
        if (!machineId && props.machines.length === 1) {
            setMachineId(props.machines[0].id)
        }
    }, [machineId, props.machines])

    // Each tab has its own agent: the adopt tab's is whoever ran the session
    // being taken over, whatever the prompt tab was last left on.
    const permissionFlavor: AgentFlavor = isAdopting ? adoptFlavor : flavor
    const permissionOptions = getPermissionModeOptionsForFlavor(permissionFlavor)
    const permissionModeTone = permissionOptions.find((option) => option.mode === permissionMode)?.tone ?? 'neutral'
    const selectedMachine = props.machines.find((machine) => machine.id === machineId)
    const allUserPaths = props.activeUser?.paths ?? []
    // A user's directories are stored without a machine, and two machines with
    // the same home layout would both claim them — so only the machine can say
    // which ones it actually has. Those become the picker's shortcuts.
    const userPathsHere = useQuery({
        queryKey: ['machine-paths-exist', machineId, allUserPaths],
        queryFn: async () => await api.checkMachinePathsExists(machineId, [...allUserPaths]),
        enabled: Boolean(machineId) && allUserPaths.length > 0
    })
    const userPaths = allUserPaths.filter((path) => userPathsHere.data?.exists[path])
    // The runner only serves paths under the roots it was started with, so the
    // picker browses those rather than the whole filesystem. It opens where
    // the person's work is, but is not fenced into it: a new project usually
    // sits *beside* their existing ones.
    const roots = selectedMachine?.metadata?.workspaceRoots ?? []
    const pickerStart = workdir.trim() || userPaths[0] || roots[0] || selectedMachine?.metadata?.homeDir || '/'
    // A task outside the user's directories vanishes from the very list it was
    // made on, so submitting also claims the directory for them — said up front.
    const willBindWorkdir = Boolean(
        props.activeUser && workdir.trim() && !isPathOwnedBy(workdir.trim(), props.activeUser.paths)
    )

    const submit = () => {
        if (!canSubmit) return
        if (isAdopting) {
            if (!adopted || !machineId) return
            props.onAdopt({
                flavor: adoptFlavor,
                nativeSessionId: adopted.id,
                machineId,
                title: title.trim() || undefined,
                permissionMode,
                force: adopted.force
            }, workdir.trim())
            return
        }
        props.onSubmit({
            prompt: prompt.trim(),
            workdir: workdir.trim(),
            spawn: { flavor, permissionMode },
            title: title.trim() || undefined,
            machineId: machineId || undefined,
            isolation,
            baseRef: baseRef.trim() || undefined,
            start: start && Boolean(machineId)
        })
    }

    // Template `.m-field`: label above, no box, one rule underneath.
    const fieldClass = 'w-full min-w-0 rounded-none border-0 border-b border-[var(--app-rule)] bg-transparent pb-[7px] pt-1.5 text-[15px] leading-[1.3] text-[var(--app-fg)] placeholder:text-[var(--app-hint)]'
    const selectClass = `${fieldClass} pr-6`
    const labelClass = 'pw-eyebrow text-[var(--app-fg)]'

    return (
        <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) props.onClose() }}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="pw-overlay fixed inset-0 z-50 bg-black/40" />
                <DialogPrimitive.Content
                    aria-modal="true"
                    aria-describedby={undefined}
                    // A stray click beside the dialog must not throw away a typed prompt.
                    onPointerDownOutside={(event) => event.preventDefault()}
                    className="pw-pop fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-full w-full max-w-lg flex-col overflow-y-auto border-t border-[var(--app-rule)] bg-[var(--app-dialog-bg)] p-5 text-[var(--app-fg)] focus:outline-none sm:inset-0 sm:m-auto sm:h-fit sm:max-h-[calc(100%-2rem)] sm:border"
                >
                    <DialogPrimitive.Title className="text-[17px] font-medium tracking-[-0.02em] text-[var(--app-fg)]">{t('board.new.title')}</DialogPrimitive.Title>

                    <div className="mt-4 flex flex-col gap-5">
                        <div className="flex flex-wrap gap-2">
                            {(['prompt', 'adopt'] as const).map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => {
                                        setSource(value)
                                        // Same reason the agent picker resets it: the two
                                        // tabs can be on different agents, and a mode
                                        // carried across would not survive the trip.
                                        const nextFlavor: AgentFlavor = value === 'adopt' ? adoptFlavor : flavor
                                        if (!isPermissionModeAllowedForFlavor(permissionMode, nextFlavor)) {
                                            setPermissionMode(getDefaultPermissionModeForFlavor(nextFlavor))
                                        }
                                    }}
                                    aria-pressed={source === value}
                                    className={`h-8 rounded-full border px-3.5 text-[13px] font-semibold transition-colors duration-300 ${
                                        source === value
                                            ? 'border-[var(--app-button)] bg-[var(--app-button)] text-[var(--app-button-text)]'
                                            : 'border-[var(--app-border)] text-[var(--app-hint)] hover:border-[var(--app-fg)] hover:text-[var(--app-fg)]'
                                    }`}
                                >
                                    {t(`board.new.source.${value}`)}
                                </button>
                            ))}
                        </div>

                        {isAdopting ? (
                            <div className="flex flex-col gap-1.5">
                                <span className={labelClass}>{t('board.new.adoptSession')}</span>
                                <AdoptSessionPicker
                                    api={api}
                                    flavor={adoptFlavor}
                                    machineId={machineId}
                                    activeUser={props.activeUser}
                                    selectedId={adopted?.id ?? null}
                                    onSelect={(session) => {
                                        setAdopted(session)
                                        // The conversation is anchored to the directory it
                                        // ran in; the task cannot choose another one.
                                        setWorkdir(session?.cwd ?? '')
                                    }}
                                />
                            </div>
                        ) : (
                            <label className="flex flex-col gap-1.5">
                                <span className={labelClass}>{t('board.new.prompt')}</span>
                                <textarea
                                    autoFocus
                                    rows={4}
                                    value={prompt}
                                    onChange={(event) => setPrompt(event.target.value)}
                                    placeholder={t('board.new.promptPlaceholder')}
                                    // Framed like the chat composer: a prompt is several lines.
                                    className="w-full resize-y rounded-none border border-[var(--app-rule)] bg-transparent px-3 py-2.5 text-[15px] leading-[1.5] text-[var(--app-fg)] transition-colors duration-300 placeholder:text-[var(--app-hint)] focus:border-[var(--app-accent)] focus-visible:outline-none"
                                />
                            </label>
                        )}

                        <div className="grid grid-cols-2 gap-x-5 gap-y-5">
                            <label className="flex min-w-0 flex-col gap-1.5">
                                <span className={labelClass}>{t('board.new.machine')}</span>
                                <SelectControl
                                    chevronClassName="right-0"
                                    value={machineId}
                                    onChange={(event) => {
                                        setMachineId(event.target.value)
                                        // A path only means something on the machine it
                                        // was browsed on; switching machines invalidates it.
                                        setWorkdir('')
                                    }}
                                    className={selectClass}
                                >
                                    <option value="">
                                        {props.machines.length === 0
                                            ? t('board.new.machineNoneAvailable')
                                            : t('board.new.machineNone')}
                                    </option>
                                    {props.machines.map((machine) => (
                                        <option key={machine.id} value={machine.id}>
                                            {machine.metadata?.displayName || machine.metadata?.host || machine.id}
                                        </option>
                                    ))}
                                </SelectControl>
                            </label>

                            <label className="flex min-w-0 flex-col gap-1.5">
                                <span className={labelClass}>{t('board.new.agent')}</span>
                                <div className="flex min-w-0 items-center gap-2">
                                    <AgentFlavorIcon flavor={permissionFlavor} className="h-4 w-4 shrink-0" />
                                    <SelectControl
                                        containerClassName="flex-1"
                                        chevronClassName="right-0"
                                        aria-label={t('board.new.agent')}
                                        value={permissionFlavor}
                                        onChange={(event) => {
                                            const next = event.target.value as AgentFlavor
                                            if (isAdopting) {
                                                // A picked session belongs to the agent it
                                                // was listed under; switching lists drops it.
                                                setAdoptFlavor(next as AdoptableFlavor)
                                                setAdopted(null)
                                                setWorkdir('')
                                            } else {
                                                setFlavor(next)
                                            }
                                            // Agents do not share a permission vocabulary —
                                            // carrying `acceptEdits` over to Codex would send
                                            // a mode it has never heard of.
                                            if (!isPermissionModeAllowedForFlavor(permissionMode, next)) {
                                                setPermissionMode(getDefaultPermissionModeForFlavor(next))
                                            }
                                        }}
                                        className={selectClass}
                                    >
                                        {(isAdopting ? ADOPTABLE_FLAVORS : CREATABLE_AGENT_FLAVORS).map((value) => (
                                            <option key={value} value={value}>{getFlavorLabel(value)}</option>
                                        ))}
                                    </SelectControl>
                                </div>
                            </label>
                        </div>

                        <div className="flex flex-col gap-1.5">
                            <span className={labelClass}>{t('board.new.workdir')}</span>
                            <div className="flex items-end gap-3">
                                <output
                                    className={`block w-full min-w-0 truncate border-b border-[var(--app-rule)] pb-[7px] pt-1.5 font-mono text-[13px] leading-[1.5] ${workdir ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                                    title={workdir}
                                >
                                    {workdir || t(isAdopting ? 'board.adopt.workdirFromSession' : 'board.new.workdirEmpty')}
                                </output>
                                {isAdopting ? null : (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        // The picker opens where the roots point, so it
                                        // waits for the machine to say which ones it has.
                                        disabled={!machineId || userPathsHere.isLoading}
                                        onClick={() => setIsPicking(true)}
                                        className="shrink-0"
                                    >
                                        {t('board.new.browse')}
                                    </Button>
                                )}
                            </div>
                            {!machineId ? (
                                <span className="text-[13px] text-[var(--app-badge-warning-text)]">
                                    {props.machines.length === 0
                                        ? t('board.new.noMachines')
                                        : t('board.new.workdirNeedsMachine')}
                                </span>
                            ) : willBindWorkdir && props.activeUser ? (
                                <span className="text-[13px] text-[var(--app-hint)]">
                                    {t('board.new.workdirWillBind', { name: props.activeUser.name })}
                                </span>
                            ) : null}
                        </div>

                        <label className="flex flex-col gap-1.5">
                            <span className={labelClass}>{t('board.new.titleOptional')}</span>
                            <input
                                type="text"
                                value={title}
                                onChange={(event) => setTitle(event.target.value)}
                                placeholder={derivedTitle || t('board.new.titlePlaceholder')}
                                className={fieldClass}
                            />
                        </label>

                        {permissionOptions.length > 0 ? (
                            <label className="flex flex-col gap-1.5">
                                <span className={labelClass}>{t('board.new.permission')}</span>
                                <SelectControl
                                    chevronClassName="right-0"
                                    // The label element also wraps the risk hint, so its
                                    // text is not a clean accessible name on its own.
                                    aria-label={t('board.new.permission')}
                                    value={permissionMode}
                                    onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
                                    className={selectClass}
                                >
                                    {permissionOptions.map((option) => (
                                        <option key={option.mode} value={option.mode}>
                                            {option.label}
                                        </option>
                                    ))}
                                </SelectControl>
                                {/* Red only where the mode skips every check; the in-between mode reads in black, the safe one in grey. */}
                                <span className={`text-[13px] ${
                                    permissionModeTone === 'danger'
                                        ? 'text-[var(--app-accent)]'
                                        : permissionModeTone === 'warning'
                                            ? 'text-[var(--app-fg)]'
                                            : 'text-[var(--app-hint)]'
                                }`}>
                                    {t(`board.new.permission.hint.${permissionModeTone}`)}
                                </span>
                            </label>
                        ) : null}

                        <div className={`grid grid-cols-2 gap-x-5 ${isAdopting ? 'hidden' : ''}`}>
                            <label className="flex min-w-0 flex-col gap-1.5">
                                <span className={labelClass}>{t('board.new.isolation')}</span>
                                <SelectControl
                                    chevronClassName="right-0"
                                    value={isolation}
                                    onChange={(event) => setIsolation(event.target.value as 'simple' | 'worktree')}
                                    className={selectClass}
                                >
                                    <option value="worktree">{t('board.new.isolation.worktree')}</option>
                                    <option value="simple">{t('board.new.isolation.simple')}</option>
                                </SelectControl>
                            </label>

                            <label className="flex min-w-0 flex-col gap-1.5">
                                <span className={labelClass}>{t('board.new.baseRef')}</span>
                                <input
                                    type="text"
                                    value={baseRef}
                                    onChange={(event) => setBaseRef(event.target.value)}
                                    placeholder={t('board.new.baseRefPlaceholder')}
                                    disabled={isolation !== 'worktree'}
                                    className={`${fieldClass} disabled:opacity-50`}
                                />
                            </label>
                        </div>

                        <label className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${isAdopting ? 'hidden' : ''}`}>
                            <input
                                type="checkbox"
                                checked={start && Boolean(machineId)}
                                disabled={!machineId}
                                onChange={(event) => setStart(event.target.checked)}
                                className="h-4 w-4 accent-[var(--app-fg)]"
                            />
                            <span className="text-[15px] text-[var(--app-fg)]">{t('board.new.startNow')}</span>
                            {!machineId ? (
                                <span className="text-[13px] text-[var(--app-hint)]">{t('board.new.startNeedsMachine')}</span>
                            ) : null}
                        </label>

                        {props.error ? (
                            <p role="alert" className="text-[13px] text-[var(--app-accent)]">
                                {props.error}
                            </p>
                        ) : null}
                        {created ? (
                            <p role="alert" className="text-[13px] text-[var(--app-accent)]">
                                {t('board.new.startFailed', { message: props.startFailure ?? '' })}
                            </p>
                        ) : null}
                    </div>

                    {isPicking && machineId ? (
                        <DirectoryPicker
                            api={api}
                            machineId={machineId}
                            roots={roots}
                            shortcuts={userPaths}
                            allowCreate
                            initialPath={pickerStart}
                            onPick={(picked) => {
                                setWorkdir(picked)
                                setIsPicking(false)
                            }}
                            onClose={() => setIsPicking(false)}
                        />
                    ) : null}

                    <div className="mt-6 flex justify-end gap-2">
                        {created ? (
                            <Button type="button" onClick={props.onClose}>
                                {t('button.close')}
                            </Button>
                        ) : (
                            <>
                                <Button type="button" variant="outline" onClick={props.onClose}>
                                    {t('board.new.cancel')}
                                </Button>
                                <Button type="button" disabled={!canSubmit} onClick={submit}>
                                    {props.isPending ? t('board.new.creating') : t('board.new.create')}
                                </Button>
                            </>
                        )}
                    </div>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    )
}
