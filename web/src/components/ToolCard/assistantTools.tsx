import { useState, type ReactNode } from 'react'
import type { AssistantMemory } from '@hapi/protocol'
import { BrainIcon, EyeIcon, SendIcon } from '@/components/Assistant/icons'
import { ClipboardIcon } from '@/components/ToolCard/icons'
import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { useAppContext } from '@/lib/app-context'
import { getInputStringAny } from '@/lib/toolInputUtils'
import { useTranslation } from '@/lib/use-translation'

/**
 * Cards for the task assistant's hapi tools.
 *
 * A memory write is the one place the assistant changes something the person
 * owns without asking first, so its card carries the undo; a delete carries a
 * restore. Messages and prompts the assistant sends to other sessions show
 * their text, so the permission card under them is a decision about words
 * the person can read.
 */

const ICON_CLASS = 'h-3.5 w-3.5'

type Translator = (key: string, params?: Record<string, string | number>) => string
type EntryOpts = { input: unknown; result: unknown; t?: Translator }
type Entry = {
    icon: (opts: EntryOpts) => ReactNode
    title: (opts: EntryOpts) => string
    subtitle?: (opts: EntryOpts) => string | null
    minimal?: boolean
}

const label = (opts: EntryOpts, key: string, fallback: string, params?: Record<string, string | number>) =>
    opts.t ? opts.t(key, params) : fallback

/** Tool results arrive as MCP text content wrapping the hub's JSON. */
export function parseAssistantToolResult(result: unknown): Record<string, unknown> | null {
    const text = Array.isArray(result)
        ? result.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('')
        : typeof result === 'string' ? result : null
    if (!text) return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : null
    try {
        const parsed = JSON.parse(text)
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    } catch {
        return null
    }
}

export const assistantKnownTools: Record<string, Entry> = {
    mcp__hapi__memory_write: {
        icon: () => <BrainIcon className={ICON_CLASS} />,
        title: (opts) => label(opts, 'assistant.tool.memory_write', 'Remember'),
        subtitle: (opts) => getInputStringAny(opts.input, ['description'])
    },
    mcp__hapi__memory_delete: {
        icon: () => <BrainIcon className={ICON_CLASS} />,
        title: (opts) => label(opts, 'assistant.tool.memory_delete', 'Forget'),
        subtitle: (opts) => getInputStringAny(opts.input, ['name'])
    },
    mcp__hapi__memory_read: {
        icon: () => <BrainIcon className={ICON_CLASS} />,
        title: (opts) => label(opts, 'assistant.tool.memory_read', 'Read memory'),
        subtitle: (opts) => getInputStringAny(opts.input, ['name']),
        minimal: true
    },
    mcp__hapi__memory_list: {
        icon: () => <BrainIcon className={ICON_CLASS} />,
        title: (opts) => label(opts, 'assistant.tool.memory_list', 'List memories'),
        minimal: true
    },
    mcp__hapi__task_list: {
        icon: () => <ClipboardIcon className={ICON_CLASS} />,
        title: (opts) => label(opts, 'assistant.tool.task_list', 'List tasks'),
        minimal: true
    },
    mcp__hapi__task_get: {
        icon: () => <ClipboardIcon className={ICON_CLASS} />,
        title: (opts) => label(opts, 'assistant.tool.task_get', 'Look at task'),
        minimal: true
    },
    mcp__hapi__task_move: {
        icon: () => <ClipboardIcon className={ICON_CLASS} />,
        title: (opts) => label(opts, 'assistant.tool.task_move', 'Move task'),
        subtitle: (opts) => {
            const column = getInputStringAny(opts.input, ['column'])
            return column && opts.t ? opts.t('assistant.tool.task_move.to', { column: opts.t(`board.column.${column}`) }) : column
        }
    },
    mcp__hapi__task_start: {
        icon: () => <ClipboardIcon className={ICON_CLASS} />,
        title: (opts) => label(opts, 'assistant.tool.task_start', 'Start task')
    },
    mcp__hapi__task_cancel: {
        icon: () => <ClipboardIcon className={ICON_CLASS} />,
        title: (opts) => label(opts, 'assistant.tool.task_cancel', 'Stop task')
    },
    mcp__hapi__peer_respond: {
        icon: () => <SendIcon className={ICON_CLASS} />,
        title: (opts) => {
            const decision = getInputStringAny(opts.input, ['decision'])
            return decision === 'deny'
                ? label(opts, 'assistant.tool.peer_respond.deny', 'Deny a task\'s request')
                : label(opts, 'assistant.tool.peer_respond.approve', 'Approve a task\'s request')
        }
    },
    mcp__hapi__ping_peer: {
        icon: () => <SendIcon className={ICON_CLASS} />,
        title: (opts) => label(opts, 'assistant.tool.ping_peer', 'Message a task')
    },
    mcp__hapi__inspect_peer: {
        icon: () => <EyeIcon className={ICON_CLASS} />,
        title: (opts) => label(opts, 'assistant.tool.inspect_peer', 'Look at a task\'s session'),
        minimal: true
    }
}

/** Ask the open assistant panel to show one entry in its memory tab. */
function openAssistantMemory(memoryId: string): void {
    window.dispatchEvent(new CustomEvent('hapi:assistant-open-memory', { detail: memoryId }))
}

function MemoryWriteView(props: ToolViewProps) {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const [state, setState] = useState<'idle' | 'busy' | 'undone' | 'failed'>('idle')
    const result = parseAssistantToolResult(props.block.tool.result)
    const memory = result?.memory as AssistantMemory | undefined
    const description = getInputStringAny(props.block.tool.input, ['description'])
    const done = props.block.tool.state === 'completed' && memory

    return (
        <div className="flex items-center gap-2 text-sm">
            <span className={`min-w-0 flex-1 ${state === 'undone' ? 'text-[var(--app-hint)] line-through' : 'text-[var(--app-fg)]'}`}>
                {result?.outcome === 'updated' ? `${t('assistant.tool.memory_write.updated')} · ` : ''}{description}
            </span>
            {done && state !== 'undone' ? (
                <>
                    <button
                        type="button"
                        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]"
                        onClick={() => openAssistantMemory(memory.id)}
                    >
                        {t('assistant.tool.view')}
                    </button>
                    <button
                        type="button"
                        disabled={state === 'busy' || !api}
                        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
                        onClick={async () => {
                            setState('busy')
                            try {
                                // Only this write: if the person kept or edited
                                // the entry since, there is nothing to undo here.
                                await api!.undoAssistantMemory(memory.id, { ifUpdatedAt: memory.updatedAt })
                                setState('undone')
                            } catch {
                                setState('failed')
                            }
                        }}
                    >
                        {state === 'failed' ? t('assistant.tool.undoFailed') : t('assistant.tool.undo')}
                    </button>
                </>
            ) : null}
            {state === 'undone' ? <span className="shrink-0 text-xs text-[var(--app-hint)]">{t('assistant.tool.undone')}</span> : null}
        </div>
    )
}

function MemoryDeleteView(props: ToolViewProps) {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const [state, setState] = useState<'idle' | 'busy' | 'restored' | 'failed'>('idle')
    const deleted = parseAssistantToolResult(props.block.tool.result)?.deleted as AssistantMemory | undefined
    if (!deleted) return null
    return (
        <div className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 text-[var(--app-hint)] line-through">{deleted.description}</span>
            {state === 'restored' ? (
                <span className="shrink-0 text-xs text-[var(--app-hint)]">{t('assistant.tool.restored')}</span>
            ) : (
                <button
                    type="button"
                    disabled={state === 'busy' || !api}
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                    onClick={async () => {
                        setState('busy')
                        try {
                            await api!.createAssistantMemory({
                                workspaceUserId: deleted.workspaceUserId,
                                scope: deleted.scope,
                                scopeRef: deleted.scopeRef,
                                name: deleted.name,
                                description: deleted.description,
                                type: deleted.type,
                                body: deleted.body
                            })
                            setState('restored')
                        } catch {
                            setState('failed')
                        }
                    }}
                >
                    {state === 'failed' ? t('assistant.tool.undoFailed') : t('assistant.tool.restore')}
                </button>
            )}
        </div>
    )
}

function MessageView(props: ToolViewProps) {
    const message = getInputStringAny(props.block.tool.input, ['message'])
    if (!message) return null
    return (
        <blockquote className="whitespace-pre-wrap border-l border-[var(--app-md-quote-border)] pl-3 text-sm text-[var(--app-fg)]">
            {message}
        </blockquote>
    )
}

export const assistantToolViews: Record<string, (props: ToolViewProps) => ReactNode> = {
    mcp__hapi__memory_write: MemoryWriteView,
    mcp__hapi__memory_delete: MemoryDeleteView,
    mcp__hapi__ping_peer: MessageView
}
