import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { readableError, type ApiClient } from '@/api/client'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { buildVisibleChatBlocks } from '@/chat/toolGroups'
import { HappyComposer } from '@/components/AssistantChat/HappyComposer'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useCodexModels } from '@/hooks/queries/useCodexModels'
import { useMessages } from '@/hooks/queries/useMessages'
import { useSession } from '@/hooks/queries/useSession'
import { useSSE } from '@/hooks/useSSE'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { useAppContext } from '@/lib/app-context'
import { getCodexModelReasoningEfforts } from '@/lib/codexModelCapabilities'
import { isQueuedForInvocation } from '@/lib/messages'
import { useTranslation } from '@/lib/use-translation'
import type { Session } from '@/types/api'

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

    const send = useCallback(async (input: { text: string; localId?: string; attachments?: unknown }) => {
        const result = await props.api.sendAssistantMessage({
            workspaceUserId: props.workspaceUserId,
            text: input.text,
            localId: input.localId,
            contextTaskId: props.contextTaskId
        })
        if (result.sessionId !== props.sessionId) {
            props.onSessionId(result.sessionId)
        }
        props.onSent?.()
    }, [props.api, props.workspaceUserId, props.contextTaskId, props.sessionId, props.onSessionId, props.onSent])

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
            onGone={props.onSessionGone}
        />
    )
}

function FirstMessage(props: {
    placeholder: string
    sending: boolean
    error: string | null
    onSend: (text: string) => Promise<void>
}) {
    const { t } = useTranslation()
    const [text, setText] = useState('')
    const submit = async () => {
        const value = text.trim()
        if (!value || props.sending) return
        await props.onSend(value)
        setText('')
    }
    return (
        <div className="flex min-h-0 flex-1 flex-col">
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
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault()
                            void submit()
                        }
                    }}
                    className="min-h-0 flex-1 resize-none bg-transparent px-2 py-1 text-base text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none"
                />
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
    send: (input: { text: string; localId: string }) => Promise<void>
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
    send: (input: { text: string; localId: string }) => Promise<void>
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
        onSendMessage: (text) => { void sendMessage(text) },
        onAbort: async () => {
            await abortSession()
            props.onRefresh()
        },
        allowSendWhenInactive: true
    })

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <div className="flex min-h-0 flex-1 flex-col">
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
                    hideAttachment
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
            </div>
        </AssistantRuntimeProvider>
    )
}
