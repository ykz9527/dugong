import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Task } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { FueCallout, FueDot } from '@/components/Fue'
import { useSidebarResize, type SidebarResizeOptions } from '@/hooks/useSidebarResize'
import { setAssistantPanelOpen, toggleAssistantPanel, useAssistantPanelOpen } from '@/lib/assistantPanel'
import { useFue } from '@/lib/use-fue'
import { useTranslation } from '@/lib/use-translation'
import { AssistantPanel } from './AssistantPanel'
import { AssistantIcon } from './icons'

/**
 * Where the task assistant lives in the sessions layout.
 *
 * Split width: a resizable column on the right of the chat, toggled from the
 * task list's toolbar. Phone: a full-screen sheet, reached from a floating
 * button on the task list or from the session header. A push from the assistant links here with
 * `?assistant=1`, which opens it.
 */

const SPLIT_QUERY = '(min-width: 920px)'

const ASSISTANT_PANEL_RESIZE: SidebarResizeOptions = {
    storageKey: 'hapi-assistant-panel-width',
    side: 'right',
    minWidth: 320,
    maxWidth: 720,
    defaultWidth: 420
}

function subscribeSplit(listener: () => void): () => void {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {}
    const query = window.matchMedia(SPLIT_QUERY)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
}

function readSplit(): boolean {
    return typeof window === 'undefined' || !window.matchMedia ? true : window.matchMedia(SPLIT_QUERY).matches
}

/** Read synchronously so a phone's first paint never shows the split layout. */
export function useIsSplitLayout(): boolean {
    return useSyncExternalStore(subscribeSplit, readSplit, () => true)
}

export function AssistantHost(props: {
    api: ApiClient | null
    tasks: Task[]
    selectedSessionId: string | null
    isSessionsIndex: boolean
}) {
    const open = useAssistantPanelOpen()
    const split = useIsSplitLayout()
    const resize = useSidebarResize(ASSISTANT_PANEL_RESIZE)
    const task = props.selectedSessionId
        ? props.tasks.find((candidate) => candidate.currentSessionId === props.selectedSessionId) ?? null
        : null

    useEffect(() => {
        const params = new URLSearchParams(window.location.search)
        if (params.get('assistant') !== '1') return
        setAssistantPanelOpen(true)
        params.delete('assistant')
        const search = params.toString()
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`)
    }, [])

    if (split) {
        if (!open) return null
        return (
            <>
                <div
                    className="sidebar-resize-handle shrink-0"
                    data-dragging={resize.isDragging || undefined}
                    onPointerDown={resize.onPointerDown}
                />
                <AssistantPanel api={props.api} task={task} width={resize.width} onClose={() => setAssistantPanelOpen(false)} />
            </>
        )
    }

    if (open) {
        return <AssistantPanel api={props.api} task={task} fullScreen onClose={() => setAssistantPanelOpen(false)} />
    }
    // In a task's chat the header carries the button; the composer owns the
    // bottom of the screen there.
    return props.isSessionsIndex ? <AssistantFab /> : null
}

function AssistantFab() {
    const { t } = useTranslation()
    const fue = useFue('task-assistant')
    const buttonRef = useRef<HTMLButtonElement>(null)
    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                onClick={() => {
                    fue.engage()
                    setAssistantPanelOpen(true)
                }}
                className="fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] right-5 z-40 flex items-center gap-1.5 rounded-full bg-[var(--app-button)] px-4 py-3 text-sm font-semibold text-[var(--app-button-text)]"
            >
                <AssistantIcon className="h-4 w-4" />
                {t('assistant.title')}
                {fue.status !== 'acknowledged' ? <FueDot pulsing={fue.status === 'unseen'} /> : null}
            </button>
            {fue.status === 'engaging' ? (
                <FueCallout title={t('assistant.fue.title')} body={t('assistant.fue.body')} onDismiss={fue.dismiss} anchorRef={buttonRef} />
            ) : null}
        </>
    )
}

/** The panel's toggle; styled by the toolbar it sits in. */
export function AssistantHeaderButton(props: { className: (active: boolean) => string; iconClassName?: string }) {
    const { t } = useTranslation()
    const open = useAssistantPanelOpen()
    const fue = useFue('task-assistant')
    const buttonRef = useRef<HTMLButtonElement>(null)
    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                onClick={() => {
                    fue.engage()
                    toggleAssistantPanel()
                }}
                className={`relative ${props.className(open)}`}
                title={t('assistant.toggle')}
                aria-label={t('assistant.toggle')}
                aria-pressed={open}
            >
                <AssistantIcon className={props.iconClassName ?? 'h-[18px] w-[18px]'} />
                {fue.status !== 'acknowledged' ? <FueDot pulsing={fue.status === 'unseen'} className="absolute -right-0.5 -top-0.5" /> : null}
            </button>
            {fue.status === 'engaging' ? (
                <FueCallout title={t('assistant.fue.title')} body={t('assistant.fue.body')} onDismiss={fue.dismiss} anchorRef={buttonRef} />
            ) : null}
        </>
    )
}
