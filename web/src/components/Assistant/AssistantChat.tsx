import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { readableError, type ApiClient } from '@/api/client'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { buildVisibleChatBlocks } from '@/chat/toolGroups'
import { AttachmentIcon } from '@/components/AssistantChat/ComposerButtons'
import { DragDropZone } from '@/components/AssistantChat/DragDropZone'
import { HappyComposer } from '@/components/AssistantChat/HappyComposer'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useCodexModels } from '@/hooks/queries/useCodexModels'
import { useMessages } from '@/hooks/queries/useMessages'
import { useSession } from '@/hooks/queries/useSession'
import { useDragOver } from '@/hooks/useDragOver'
import { useSSE } from '@/hooks/useSSE'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { useAppContext } from '@/lib/app-context'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import { saveDraftAttachments } from '@/lib/composer-attachment-drafts'
import { handoffComposerDraft } from '@/lib/composer-draft-transfer'
import { saveDraft } from '@/lib/composer-drafts'
import { randomId } from '@/lib/randomId'
import { getCodexModelReasoningEfforts } from '@/lib/codexModelCapabilities'
import { isQueuedForInvocation } from '@/lib/messages'
import { useTranslation } from '@/lib/use-translation'
import type { AttachmentMetadata, Session } from '@/types/api'

/**
 * The assistant's conversation inside its panel.
 *
 * A trimmed `SessionChat`: the same thread and composer, none of the things
 * that would take over the main view (files, terminal, fork, outline). It
 * keeps its own session-scoped SSE subscription, because the app's only
 * follows the session in the URL — which is the task, not the assistant.
 *
 * Sends go through `/api/assistant/messages`, which finds or starts the
 * person's assistant and tells it which task is in view.
 *
 * Files are uploaded to the assistant's own session, so they land on the
 * machine it runs on. A stopped (or not yet started) assistant is opened
 * first through `/api/assistant/session`.
 */
export function AssistantChat(props: {
    api: ApiClient
    workspaceUserId: string
    sessionId: string | null
    onSessionId: (sessionId: string) => void
    /** The cached session id no longer exists (a reopen folded it into a new row). */
    onSessionGone: () => void
    contextTaskId: string | null
    /** A message went through, carrying whatever context was in view. */
    onSent?: () => void
}) {
    const { t } = useTranslation()
    const [firstSendError, setFirstSendError] = useState<string | null>(null)
    const [firstSending, setFirstSending] = useState(false)

    const switchingRef = useRef(false)
    const send = useCallback(async (input: { text: string; localId?: string; attachments?: AttachmentMetadata[] }) => {
        const result = await props.api.sendAssistantMessage({
            workspaceUserId: props.workspaceUserId,
            text: input.text,
            localId: input.localId,
            attachments: input.attachments,
            contextTaskId: props.contextTaskId
        })
        if (result.sessionId !== props.sessionId) {
            switchingRef.current = false
            props.onSessionId(result.sessionId)
        }
        props.onSent?.()
    }, [props.api, props.workspaceUserId, props.contextTaskId, props.sessionId, props.onSessionId, props.onSent])

    // Waking a stopped assistant can fold it into a new session row, and the
    // old row then reads as gone. While a wake is in flight the panel waits
    // for `switchTo` (which carries the composer draft along) instead of
    // following the gone row and dropping the files being attached.
    const openSession = useCallback(async () => {
        switchingRef.current = true
        try {
            const result = await props.api.openAssistantSession({
                workspaceUserId: props.workspaceUserId,
                contextTaskId: props.contextTaskId
            })
            if (result.sessionId === props.sessionId) switchingRef.current = false
            return result.sessionId
        } catch (error) {
            switchingRef.current = false
            throw error
        }
    }, [props.api, props.workspaceUserId, props.contextTaskId, props.sessionId])
    const switchTo = useCallback((sessionId: string) => {
        switchingRef.current = false
        props.onSessionId(sessionId)
    }, [props.onSessionId])
    const onGone = useCallback(() => {
        if (!switchingRef.current) props.onSessionGone()
    }, [props.onSessionGone])

    if (!props.sessionId) {
        // No assistant yet: the first message starts one. No thread to show.
        return (
            <FirstMessage
                placeholder={props.contextTaskId ? t('assistant.placeholder.task') : t('assistant.placeholder.list')}
                sending={firstSending}
                error={firstSendError}
                onSend={async (text) => {
                    setFirstSending(true)
                    setFirstSendError(null)
                    try {
                        await send({ text })
                    } catch (error) {
                        setFirstSendError(readableError(error))
                    } finally {
                        setFirstSending(false)
                    }
                }}
                onAttach={async (text, files) => {
                    // Start the assistant so the files can go to its machine,
                    // then hand text and files to its composer as a draft:
                    // the composer restores them and uploads as usual.
                    setFirstSending(true)
                    setFirstSendError(null)
                    try {
                        const sessionId = await openSession()
                        if (text) saveDraft(sessionId, text)
                        saveDraftAttachments(sessionId, files.map((file) => ({ id: randomId(), file })))
                        switchTo(sessionId)
                    } catch (error) {
                        setFirstSendError(readableError(error))
                    } finally {
                        setFirstSending(false)
                    }
                }}
            />
        )
    }

    return (
        <AssistantThread
            key={props.sessionId}
            api={props.api}
            sessionId={props.sessionId}
            placeholder={props.contextTaskId ? t('assistant.placeholder.task') : t('assistant.placeholder.list')}
            send={send}
            openSession={openSession}
            switchTo={switchTo}
            onGone={onGone}
        />
    )
}

function FirstMessage(props: {
    placeholder: string
    sending: boolean
    error: string | null
    onSend: (text: string) => Promise<void>
    /** Files picked, pasted or dropped before the assistant exists. */
    onAttach: (text: string, files: File[]) => Promise<void>
}) {
    const { t } = useTranslation()
    const [text, setText] = useState('')
    const fileInputRef = useRef<HTMLInputElement>(null)
    const isDragging = useDragOver()
    const submit = async () => {
        const value = text.trim()
        if (!value || props.sending) return
        await props.onSend(value)
        setText('')
    }
    const attach = (files: File[]) => {
        if (files.length === 0 || props.sending) return
        void props.onAttach(text, files)
    }
    const onDrop = (event: DragEvent) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        attach(Array.from(event.dataTransfer.files))
    }
    return (
        <div
            className="relative flex min-h-0 flex-1 flex-col"
            onDragOver={(event) => {
                if (!event.dataTransfer.types.includes('Files')) return
                event.preventDefault()
                event.dataTransfer.dropEffect = props.sending ? 'none' : 'copy'
            }}
            onDrop={onDrop}
        >
            {isDragging && !props.sending ? (
                <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-[var(--app-link)] bg-[var(--app-link)]/10">
                    <div className="bg-[var(--app-bg)] px-4 py-2 text-sm font-medium text-[var(--app-link)]">
                        {t('composer.dropToAttach')}
                    </div>
                </div>
            ) : null}
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-[13px] text-[var(--app-hint)]">
                <p className="text-[15px] text-[var(--app-fg)]">{t('assistant.empty.title')}</p>
                <p>{t('assistant.empty.body')}</p>
            </div>
            {props.error ? (
                <p className="mx-3 mb-2 text-xs text-[var(--app-accent)]">{props.error}</p>
            ) : null}
            <div className="m-3 flex items-end gap-2 border border-[var(--app-rule)] bg-[var(--app-dialog-bg)] p-2 transition-[border-color] duration-300 focus-within:border-[var(--app-accent)]">
                <textarea
                    rows={2}
                    value={text}
                    placeholder={props.placeholder}
                    disabled={props.sending}
                    onChange={(event) => setText(event.target.value)}
                    onPaste={(event) => {
                        const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'))
                        if (images.length === 0) return
                        event.preventDefault()
                        attach(images)
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault()
                            void submit()
                        }
                    }}
                    className="min-h-0 flex-1 resize-none bg-transparent px-2 py-1 text-base text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none"
                />
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    hidden
                    onChange={(event) => {
                        const files = Array.from(event.target.files ?? [])
                        event.target.value = ''
                        attach(files)
                    }}
                />
                <button
                    type="button"
                    aria-label={t('composer.attach')}
                    title={t('composer.attach')}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={props.sending}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <AttachmentIcon />
                </button>
                <button
                    type="button"
                    onClick={() => void submit()}
                    disabled={props.sending || !text.trim()}
                    className="pw-sweep shrink-0 rounded-full bg-[var(--app-button)] px-4 py-1.5 text-[13px] font-semibold text-[var(--app-button-text)] disabled:opacity-50"
                >
                    {props.sending ? t('assistant.starting') : t('assistant.send')}
                </button>
            </div>
        </div>
    )
}

function AssistantThread(props: {
    api: ApiClient
    sessionId: string
    placeholder: string
    send: (input: { text: string; localId: string; attachments?: AttachmentMetadata[] }) => Promise<void>
    openSession: () => Promise<string>
    switchTo: (sessionId: string) => void
    onGone: () => void
}) {
    const { token, baseUrl } = useAppContext()
    const { session, notFound, refetch: refetchSession } = useSession(props.api, props.sessionId)
    useEffect(() => {
        if (notFound) props.onGone()
    }, [notFound, props.onGone])
    const {
        messages,
        warning,
        isSyncingTail,
        isLoadingMore,
        hasMore,
        messagesVersion,
        historyVersion,
        loadMore,
        cancelLoadMore,
        refetch,
        setViewMode
    } = useMessages(props.api, props.sessionId)

    // Live updates for this session alone; the app-level subscription follows
    // whichever task is open in the main view.
    useSSE({
        enabled: Boolean(token),
        token,
        baseUrl,
        subscription: { sessionId: props.sessionId },
        scope: 'full',
        onEvent: () => {}
    })

    if (!session) {
        return <div className="flex-1" />
    }
    return (
        <LoadedThread
            api={props.api}
            session={session}
            messages={messages}
            warning={warning}
            isSyncingTail={isSyncingTail}
            isLoadingMore={isLoadingMore}
            hasMore={hasMore}
            messagesVersion={messagesVersion}
            historyVersion={historyVersion}
            loadMore={loadMore}
            cancelLoadMore={cancelLoadMore}
            onRefresh={() => {
                void refetch()
                void refetchSession()
            }}
            setViewMode={setViewMode}
            placeholder={props.placeholder}
            send={props.send}
            openSession={props.openSession}
            switchTo={props.switchTo}
        />
    )
}

function LoadedThread(props: {
    api: ApiClient
    session: Session
    messages: ReturnType<typeof useMessages>['messages']
    warning: string | null
    isSyncingTail: boolean
    isLoadingMore: boolean
    hasMore: boolean
    messagesVersion: number
    historyVersion: number
    loadMore: ReturnType<typeof useMessages>['loadMore']
    cancelLoadMore: () => void
    onRefresh: () => void
    setViewMode: ReturnType<typeof useMessages>['setViewMode']
    placeholder: string
    send: (input: { text: string; localId: string; attachments?: AttachmentMetadata[] }) => Promise<void>
    openSession: () => Promise<string>
    switchTo: (sessionId: string) => void
}) {
    const { session } = props
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const agentFlavor = session.metadata?.flavor ?? 'claude'
    const isCodex = agentFlavor === 'codex'
    const { abortSession, setModel, setModelReasoningEffort, setPermissionMode } = useSessionActions(props.api, session.id, agentFlavor)
    const codexModels = useCodexModels({
        api: props.api,
        sessionId: session.id,
        machineId: session.metadata?.machineId ?? null,
        enabled: isCodex && session.active
    }).models
    const codexModelOptions = useMemo(
        () => isCodex ? codexModels.map((model) => ({ value: model.id, label: model.displayName })) : undefined,
        [isCodex, codexModels]
    )
    const codexEffortOptions = useMemo(
        () => isCodex ? getCodexModelReasoningEfforts(codexModels, session.model)?.map((value) => ({ value })) : undefined,
        [isCodex, codexModels, session.model]
    )
    const { sendMessage, isSending, sendSettlement } = useSendMessage(props.api, session.id, {
        isSessionThinking: session.thinking,
        send: props.send
    })

    // A stopped assistant is woken before the upload, so the file lands on
    // the machine that will read it. One wake per adapter, shared by every
    // file of a multi-pick. A wake that lands in a new session row hands the
    // draft over to it, and that composer uploads the files.
    const attachmentAdapter = useMemo(() => {
        if (session.active) return createAttachmentAdapter(props.api, session.id)
        let opening: Promise<string> | undefined
        return createAttachmentAdapter(
            props.api,
            session.id,
            () => {
                opening ??= props.openSession().catch((error: unknown) => {
                    opening = undefined
                    throw error
                })
                return opening
            },
            (targetSessionId, pending) => handoffComposerDraft(session.id, targetSessionId, pending, props.switchTo)
        )
    }, [props.api, session.id, session.active, props.openSession, props.switchTo])

    const normalized = useMemo(() => {
        const result: NormalizedMessage[] = []
        for (const message of props.messages) {
            if (isQueuedForInvocation(message)) continue
            const next = normalizeDecryptedMessage(message)
            if (next) result.push(next)
        }
        return result
    }, [props.messages])
    const reduced = useMemo(() => reduceChatBlocks(normalized, session.agentState, {}), [normalized, session.agentState])
    const reconciled = useMemo(() => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current), [reduced.blocks])
    blocksByIdRef.current = reconciled.byId
    const blocks = useMemo(
        () => buildVisibleChatBlocks(reconciled.blocks, { hasMoreMessages: props.hasMore }),
        [reconciled.blocks, props.hasMore]
    )

    const runtime = useHappyRuntime({
        session,
        blocks,
        messagesVersion: props.messagesVersion,
        historyVersion: props.historyVersion,
        isSyncingTail: props.isSyncingTail,
        isLoadingMore: props.isLoadingMore,
        isSending,
        onSendMessage: (text, attachments) => { void sendMessage(text, attachments) },
        onAbort: async () => {
            await abortSession()
            props.onRefresh()
        },
        attachmentAdapter,
        allowSendWhenInactive: true
    })

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <DragDropZone disabled={isSending}>
                <HappyThread
                    api={props.api}
                    session={session}
                    sessionId={session.id}
                    metadata={session.metadata}
                    disabled={false}
                    onRefresh={props.onRefresh}
                    onViewModeChange={props.setViewMode}
                    isSyncingTail={props.isSyncingTail}
                    messagesWarning={props.warning}
                    hasMoreMessages={props.hasMore}
                    isLoadingMoreMessages={props.isLoadingMore}
                    onLoadMore={props.loadMore}
                    onCancelLoadMore={props.cancelLoadMore}
                    unseenCount={0}
                    rawMessagesCount={props.messages.length}
                    normalizedMessagesCount={normalized.length}
                    messagesVersion={props.messagesVersion}
                    historyVersion={props.historyVersion}
                    forceScrollToken={0}
                    outlineOpen={false}
                    outlineItems={[]}
                    onOutlineOpenChange={() => {}}
                />
                <HappyComposer
                    key={`assistant-composer-${session.id}`}
                    sessionId={session.id}
                    placeholder={props.placeholder}
                    globalShortcuts={false}
                    disabled={isSending}
                    sendSettlement={sendSettlement}
                    permissionMode={session.permissionMode}
                    activePermissionMode={session.activePermissionMode}
                    model={session.model}
                    effort={session.effort}
                    modelReasoningEffort={isCodex ? session.modelReasoningEffort : undefined}
                    availableModelOptions={codexModelOptions}
                    availableModelReasoningEffortOptions={codexEffortOptions}
                    agentFlavor={agentFlavor}
                    active={session.active}
                    allowSendWhenInactive
                    thinking={session.thinking}
                    agentState={session.agentState}
                    backgroundTaskCount={session.backgroundTaskCount}
                    backgroundAgentCount={session.backgroundAgentCount}
                    contextSize={reduced.latestUsage?.contextSize}
                    contextCacheRead={reduced.latestUsage?.cacheRead}
                    contextWindow={reduced.latestUsage?.contextWindow}
                    contextModel={reduced.latestUsage?.model ?? session.model}
                    onPermissionModeChange={async (mode) => {
                        await setPermissionMode(mode)
                        props.onRefresh()
                    }}
                    onModelChange={async (model) => {
                        await setModel(model)
                        props.onRefresh()
                    }}
                    onModelReasoningEffortChange={isCodex ? async (effort) => {
                        await setModelReasoningEffort(effort)
                        props.onRefresh()
                    } : undefined}
                />
            </DragDropZone>
        </AssistantRuntimeProvider>
    )
}
