import { useMemo, useState, type CSSProperties } from 'react'
import {
    ASSISTANT_MEMORY_TYPES,
    assistantRepoKey,
    isAssistantMemoryInContext,
    type AssistantGrant,
    type AssistantMemory,
    type AssistantMemoryScope,
    type AssistantMemoryType,
    type Task
} from '@hapi/protocol'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import type { useAssistantActions } from '@/hooks/queries/useAssistant'
import { formatRelativeTime } from '@/lib/relativeTime'
import { useTranslation } from '@/lib/use-translation'

/**
 * What the assistant remembers, as the person sees and edits it. Grouped the
 * way the assistant is told about them: this task, its repo, the person. An
 * entry the assistant changed after the person wrote it says so, shows what it
 * said before, and is one click to take back.
 */

type Actions = ReturnType<typeof useAssistantActions>

/**
 * Fire an action from a click. A failure is shown through `actions.error`,
 * so the rejection is absorbed here rather than left unhandled.
 */
function run(promise: Promise<unknown>): void {
    void promise.catch(() => {})
}

/** No box, 1px rule underneath, red on focus (DESIGN.md §6 Field). */
const FIELD_CLASS = 'w-full min-w-0 border-0 border-b border-[var(--app-rule)] bg-transparent px-0 py-1 text-[15px] text-[var(--app-fg)] placeholder-[var(--app-hint)] transition-[border-color] duration-300 focus:border-[var(--app-accent)] focus:outline-none'
const LABEL_CLASS = 'pw-eyebrow flex flex-col gap-1 text-[var(--app-hint)]'
const OUTLINE_PILL = 'pw-ghost-sweep rounded-full border border-[var(--app-fg)] px-3 py-1 text-xs font-semibold text-[var(--app-fg)] disabled:opacity-50'
const PRIMARY_PILL = 'pw-sweep rounded-full bg-[var(--app-button)] px-3 py-1 text-xs font-semibold text-[var(--app-button-text)] disabled:opacity-50'
const TEXT_ACTION = 'pw-underline text-xs font-semibold'

/** An assistant change the person has not looked at since. */
export function isFreshAssistantChange(memory: AssistantMemory, seenAt: number): boolean {
    return memory.previous !== null || (memory.lastEditedBy === 'ai' && memory.updatedAt > seenAt)
}

function repoLabel(path: string): string {
    return path.split('/').filter(Boolean).pop() ?? path
}

export function AssistantMemoryTab(props: {
    workspaceUserId: string
    task: Task | null
    memories: AssistantMemory[]
    grants: AssistantGrant[]
    actions: Actions
    seenAt: number
    initialOpenId?: string | null
    onOpenSource: () => void
}) {
    const { t } = useTranslation()
    const [filter, setFilter] = useState<'related' | 'all'>(props.task ? 'related' : 'all')
    const [query, setQuery] = useState('')
    const [openId, setOpenId] = useState<string | null>(props.initialOpenId ?? null)
    const repo = props.task ? assistantRepoKey(props.task.workdir) : null

    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase()
        return props.memories.filter((memory) => {
            if (filter === 'related' && !isAssistantMemoryInContext(memory, { taskId: props.task?.id ?? null, repo })) {
                return false
            }
            return !needle || `${memory.description}\n${memory.body}\n${memory.name}`.toLowerCase().includes(needle)
        })
    }, [props.memories, props.task, repo, filter, query])

    const groups: Array<{ scope: AssistantMemoryScope; title: string; hint: string }> = [
        { scope: 'task', title: t('assistant.memory.scope.task'), hint: props.task?.title ?? '' },
        { scope: 'repo', title: t('assistant.memory.scope.repo'), hint: repo ? repoLabel(repo) : '' },
        { scope: 'user', title: t('assistant.memory.scope.user'), hint: t('assistant.memory.scope.userHint') }
    ]

    const createNote = async () => {
        const task = props.task
        const scope: AssistantMemoryScope = task ? 'task' : 'user'
        const created = await props.actions.create({
            workspaceUserId: props.workspaceUserId,
            scope,
            scopeRef: task ? task.id : props.workspaceUserId,
            name: `note-${Date.now().toString(36)}`,
            description: t('assistant.memory.newDescription'),
            type: 'project',
            body: ''
        })
        setOpenId(created.id)
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-end gap-3 px-4 pb-2 pt-3">
                <input
                    type="search"
                    aria-label={t('assistant.memory.search')}
                    placeholder={t('assistant.memory.search')}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className={`${FIELD_CLASS} flex-1 text-sm`}
                />
                <select
                    aria-label={t('assistant.memory.filter')}
                    value={filter}
                    onChange={(event) => setFilter(event.target.value as 'related' | 'all')}
                    className="shrink-0 border-0 border-b border-[var(--app-rule)] bg-transparent py-1 pr-1 text-sm text-[var(--app-fg)] focus:border-[var(--app-accent)] focus:outline-none"
                >
                    <option value="related" disabled={!props.task}>{t('assistant.memory.filter.related')}</option>
                    <option value="all">{t('assistant.memory.filter.all')}</option>
                </select>
                <button
                    type="button"
                    onClick={() => run(createNote())}
                    disabled={props.actions.isPending}
                    className={`${PRIMARY_PILL} shrink-0`}
                >
                    {t('assistant.memory.new')}
                </button>
            </div>
            {props.actions.error ? (
                <p role="alert" className="px-4 pb-1 text-xs text-[var(--app-accent)]">{props.actions.error}</p>
            ) : null}

            <div className="app-scroll-y min-h-0 flex-1 px-4 pb-3">
                {groups.map((group) => {
                    const items = visible.filter((memory) => memory.scope === group.scope)
                    if (filter === 'all' && items.length === 0) return null
                    return (
                        <section key={group.scope} className="border-b border-[var(--app-border)]">
                            <h3 className="pw-eyebrow flex items-baseline gap-2 pb-2 pt-5 text-[var(--app-hint)]">
                                <span className="shrink-0 text-[var(--app-fg)]">{group.title}</span>
                                <span className="shrink-0 tabular-nums">{items.length}</span>
                                {filter === 'related' && group.hint ? <span className="min-w-0 truncate font-normal">{group.hint}</span> : null}
                            </h3>
                            {items.length === 0 ? (
                                <p className="pw-ledger py-2.5 text-[13px] text-[var(--app-hint)]">{t('assistant.memory.emptyGroup')}</p>
                            ) : items.map((memory, index) => (
                                <MemoryRow
                                    key={memory.id}
                                    index={index}
                                    memory={memory}
                                    task={props.task}
                                    workspaceUserId={props.workspaceUserId}
                                    fresh={isFreshAssistantChange(memory, props.seenAt)}
                                    showRepo={filter === 'all' && memory.scope === 'repo'}
                                    open={openId === memory.id}
                                    onToggle={() => setOpenId(openId === memory.id ? null : memory.id)}
                                    actions={props.actions}
                                    onOpenSource={props.onOpenSource}
                                />
                            ))}
                        </section>
                    )
                })}
                {filter === 'all' && visible.length === 0 ? (
                    <p className="py-8 text-center text-[13px] text-[var(--app-hint)]">{t('assistant.memory.empty')}</p>
                ) : null}

                {props.grants.length > 0 ? (
                    <section className="border-b border-[var(--app-border)]">
                        <h3 className="pw-eyebrow pt-6 text-[var(--app-fg)]">{t('assistant.grants.title')}</h3>
                        <p className="pb-2 pt-1 text-xs text-[var(--app-hint)]">{t('assistant.grants.hint')}</p>
                        {props.grants.map((grant, index) => (
                            <div key={grant.id} className="pw-ledger pw-row-fill flex items-center gap-2 py-2.5 text-sm" style={{ '--i': index } as CSSProperties}>
                                <span className="min-w-0 flex-1 truncate text-[var(--app-fg)]">{t(`assistant.tool.${grant.tool.replace(/^mcp__hapi__/, '')}`)}</span>
                                <button
                                    type="button"
                                    onClick={() => run(props.actions.revokeGrant(grant.id))}
                                    className={`${TEXT_ACTION} shrink-0 text-[var(--app-accent)]`}
                                >
                                    {t('assistant.grants.revoke')}
                                </button>
                            </div>
                        ))}
                    </section>
                ) : null}
            </div>
            <p className="border-t border-[var(--app-border)] px-4 py-2 text-xs leading-relaxed text-[var(--app-hint)]">
                {t('assistant.memory.footer')}
            </p>
        </div>
    )
}

function AuthorTag(props: { memory: AssistantMemory }) {
    const { t } = useTranslation()
    const { memory } = props
    if (memory.previous && memory.previous.lastEditedBy === 'human') {
        return <span className="text-[var(--app-badge-warning-text)]">{t('assistant.memory.author.aiChangedYours')}</span>
    }
    const human = memory.lastEditedBy === 'human'
    return (
        <span>
            {human ? t('assistant.memory.author.human') : t('assistant.memory.author.ai')}
        </span>
    )
}

function MemoryRow(props: {
    index: number
    memory: AssistantMemory
    task: Task | null
    workspaceUserId: string
    fresh: boolean
    showRepo: boolean
    open: boolean
    onToggle: () => void
    actions: Actions
    onOpenSource: () => void
}) {
    const { t } = useTranslation()
    const { memory, actions } = props
    const [editing, setEditing] = useState(false)
    // Two presses, like deleting a task: a memory has no undo once gone.
    const [confirmingDelete, setConfirmingDelete] = useState(false)
    const [draft, setDraft] = useState({ description: memory.description, type: memory.type, body: memory.body, name: memory.name })
    const assistantDraft = memory.createdBy === 'ai' && memory.lastEditedBy === 'ai' && !memory.previous

    const save = async () => {
        await actions.update({ id: memory.id, patch: draft })
        setEditing(false)
    }

    return (
        <div className="pw-ledger" style={{ '--i': props.index } as CSSProperties}>
            <button type="button" onClick={props.onToggle} aria-expanded={props.open} className="pw-row-fill flex w-full items-start gap-3 py-2.5 text-left">
                <span className="pw-eyebrow mt-0.5 w-16 shrink-0 truncate text-[var(--app-hint)]">{t(`assistant.memory.type.${memory.type}`)}</span>
                <span className="min-w-0 flex-1">
                    <span className="block text-sm text-[var(--app-fg)]">{memory.description}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--app-hint)]">
                        <AuthorTag memory={memory} />
                        {props.showRepo ? <span>{repoLabel(memory.scopeRef)}</span> : null}
                        <span>{formatRelativeTime(memory.updatedAt, t)}</span>
                        {props.fresh ? <span className="font-semibold text-[var(--app-accent)]">{t('assistant.memory.new.badge')}</span> : null}
                    </span>
                </span>
                <span className="pw-plus mt-1 text-[var(--app-fg)]" data-open={props.open || undefined} aria-hidden="true" />
            </button>

            {props.open ? (
                <div className="pb-4 pt-1 text-sm sm:pl-[4.75rem]">
                    {memory.previous && !editing ? (
                        <div className="mb-3 text-xs">
                            <div className="pw-eyebrow mb-1 text-[var(--app-badge-warning-text)]">{t('assistant.memory.previous.title')}</div>
                            <div className="whitespace-pre-wrap bg-[var(--app-subtle-bg)] px-3 py-2 text-[var(--app-hint)]">{memory.previous.body}</div>
                            <div className="mt-2 flex items-center gap-3">
                                <button type="button" className={OUTLINE_PILL} onClick={() => run(actions.undo(memory.id))}>
                                    {t('assistant.memory.previous.undo')}
                                </button>
                                <button type="button" className={`${TEXT_ACTION} text-[var(--app-fg)]`} onClick={() => run(actions.update({ id: memory.id, patch: { acceptPrevious: true } }))}>
                                    {t('assistant.memory.previous.keep')}
                                </button>
                            </div>
                        </div>
                    ) : null}

                    {editing ? (
                        <div className="flex flex-col gap-3">
                            <label className={LABEL_CLASS}>
                                {t('assistant.memory.field.description')}
                                <input
                                    className={FIELD_CLASS}
                                    value={draft.description}
                                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                                />
                            </label>
                            <div className="flex gap-3">
                                <label className={`${LABEL_CLASS} flex-1`}>
                                    {t('assistant.memory.field.type')}
                                    <select
                                        className={FIELD_CLASS}
                                        value={draft.type}
                                        onChange={(event) => setDraft({ ...draft, type: event.target.value as AssistantMemoryType })}
                                    >
                                        {ASSISTANT_MEMORY_TYPES.map((type) => <option key={type} value={type}>{t(`assistant.memory.type.${type}`)}</option>)}
                                    </select>
                                </label>
                                <label className={`${LABEL_CLASS} flex-1`}>
                                    {t('assistant.memory.field.name')}
                                    <input
                                        className={`${FIELD_CLASS} font-mono !text-[13px]`}
                                        value={draft.name}
                                        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                                    />
                                </label>
                            </div>
                            <label className={LABEL_CLASS}>
                                {t('assistant.memory.field.body')}
                                <textarea
                                    rows={7}
                                    className="border border-[var(--app-rule)] bg-transparent px-2 py-1.5 font-mono text-[13px] font-normal text-[var(--app-fg)] transition-[border-color] duration-300 focus:border-[var(--app-accent)] focus:outline-none"
                                    value={draft.body}
                                    onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                                />
                            </label>
                            <div className="flex items-center justify-end gap-3">
                                <button type="button" className={`${TEXT_ACTION} text-[var(--app-hint)]`} onClick={() => setEditing(false)}>
                                    {t('assistant.memory.cancel')}
                                </button>
                                <button type="button" className={PRIMARY_PILL} disabled={actions.isPending} onClick={() => run(save())}>
                                    {t('assistant.memory.save')}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            {memory.body.trim() ? (
                                <div className="text-[var(--app-fg)] [&_p]:my-1">
                                    <MarkdownRenderer content={memory.body} />
                                </div>
                            ) : (
                                <p className="text-[13px] text-[var(--app-hint)]">{t('assistant.memory.noBody')}</p>
                            )}
                            <div className="mt-2 flex items-center gap-2 text-xs text-[var(--app-hint)]">
                                <code className="truncate">{memory.name}</code>
                                <span className="flex-1" />
                                {memory.source ? (
                                    <button type="button" className={`${TEXT_ACTION} text-[var(--app-fg)]`} onClick={props.onOpenSource}>
                                        {t('assistant.memory.source')}
                                    </button>
                                ) : null}
                            </div>
                            <div className="mt-3 flex items-center gap-3">
                                <button
                                    type="button"
                                    className={OUTLINE_PILL}
                                    onClick={() => {
                                        setDraft({ description: memory.description, type: memory.type, body: memory.body, name: memory.name })
                                        setEditing(true)
                                    }}
                                >
                                    {t('assistant.memory.edit')}
                                </button>
                                {assistantDraft ? (
                                    <button type="button" className={`${TEXT_ACTION} text-[var(--app-hint)]`} onClick={() => run(actions.undo(memory.id))}>
                                        {t('assistant.memory.undoCreate')}
                                    </button>
                                ) : null}
                                {confirmingDelete ? (
                                    <>
                                        <button
                                            type="button"
                                            disabled={actions.isPending}
                                            className="rounded-full border border-[var(--app-accent)] px-3 py-1 text-xs font-semibold text-[var(--app-accent)] transition-colors duration-300 hover:bg-[var(--app-accent)] hover:text-[var(--app-bg)] disabled:opacity-50"
                                            onClick={() => {
                                                setConfirmingDelete(false)
                                                run(actions.remove(memory.id))
                                            }}
                                        >
                                            {t('assistant.memory.deleteConfirm')}
                                        </button>
                                        <button type="button" className={`${TEXT_ACTION} text-[var(--app-hint)]`} onClick={() => setConfirmingDelete(false)}>
                                            {t('assistant.memory.deleteCancel')}
                                        </button>
                                    </>
                                ) : (
                                    <button type="button" className={`${TEXT_ACTION} text-[var(--app-accent)]`} onClick={() => setConfirmingDelete(true)}>
                                        {t('assistant.memory.delete')}
                                    </button>
                                )}
                            </div>
                        </>
                    )}
                </div>
            ) : null}
        </div>
    )
}
