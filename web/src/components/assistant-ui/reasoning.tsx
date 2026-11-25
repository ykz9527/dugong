import { useState, useCallback, useEffect, useLayoutEffect, useRef, type FC, type KeyboardEvent, type PropsWithChildren, type UIEvent } from 'react'
import {
    useAuiState,
    type ReasoningGroupProps,
    type ReasoningMessagePartComponent,
} from '@assistant-ui/react'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { cn } from '@/lib/utils'
import { LEDGER_RUN_ITEM_CLASS } from '@/components/ToolCard/ledger'
import { useReasoningCollapse } from '@/hooks/useReasoningCollapse'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { useKatexRehypePlugins } from '@/lib/lazyKatex'
import {
    MARKDOWN_CLASSNAME,
    MARKDOWN_COMPONENTS_BY_LANGUAGE,
    MARKDOWN_PLUGINS,
    defaultComponents,
    denyOnlyTransform,
    UriConfirmProvider,
} from '@/components/assistant-ui/markdown-text'

function ShimmerDot() {
    return (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
    )
}

export const Reasoning: ReasoningMessagePartComponent = ({ text, status }) => {
    const previousTextRef = useRef(text)
    const runStartedWithRunningRef = useRef(status.type === 'running')
    const hasTextChangedDuringRunRef = useRef(false)
    const rehypePlugins = useKatexRehypePlugins()

    // The runtime keeps resumed reasoning history complete until a new output
    // block exists. Once this part is actually running, preserve assistant-ui's
    // typewriter from its first paint. A complete -> running transition with
    // unchanged text is still treated as hydration, not new reasoning output.
    if (status.type !== 'running') {
        runStartedWithRunningRef.current = false
        hasTextChangedDuringRunRef.current = false
    } else if (
        text !== previousTextRef.current
    ) {
        hasTextChangedDuringRunRef.current = true
    }
    const smooth = status.type === 'running'
        && (runStartedWithRunningRef.current || hasTextChangedDuringRunRef.current)

    previousTextRef.current = text

    return (
        <UriConfirmProvider>
            <MarkdownTextPrimitive
                smooth={smooth}
                remarkPlugins={MARKDOWN_PLUGINS}
                rehypePlugins={rehypePlugins}
                components={defaultComponents}
                componentsByLanguage={MARKDOWN_COMPONENTS_BY_LANGUAGE}
                urlTransform={denyOnlyTransform}
                className={cn(MARKDOWN_CLASSNAME, 'aui-reasoning-content text-[13.5px] text-[var(--app-hint)]')}
            />
        </UriConfirmProvider>
    )
}

type HappyReasoningGroupProps = PropsWithChildren<
    Partial<Pick<ReasoningGroupProps, 'startIndex' | 'endIndex'>>
>

export const ReasoningGroup: FC<HappyReasoningGroupProps> = ({
    children,
    startIndex = 0,
    endIndex,
}) => {
    const [isOpen, setIsOpen] = useState(false)
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const followLatestRef = useRef(true)
    const pointerActiveRef = useRef(false)
    const pointerCleanupRef = useRef<(() => void) | null>(null)
    const followSyncFrameRef = useRef<number | null>(null)

    const isStreaming = useAuiState((state) => {
        const parts = state.message.parts.slice(startIndex, endIndex === undefined ? undefined : endIndex + 1)
        return parts.some((part) => part.type === 'reasoning' && part.status.type === 'running')
    })
    const { reasoningCollapsed } = useReasoningCollapse()
    const chatContext = useOptionalHappyChatContext()

    useEffect(() => {
        if (!isStreaming) return
        const nextOpen = !reasoningCollapsed
        if (nextOpen) {
            followLatestRef.current = true
        }
        setIsOpen(nextOpen)
    }, [isStreaming, reasoningCollapsed])

    useEffect(() => {
        if (isOpen || followLatestRef.current) return
        followLatestRef.current = true
        chatContext?.onNestedScrollFollowChange?.(true)
    }, [isOpen, chatContext])

    useLayoutEffect(() => {
        const scroll = scrollRef.current
        if (!scroll || !isOpen || !isStreaming || !followLatestRef.current) return
        scroll.scrollTop = scroll.scrollHeight
    })

    const handleToggle = () => {
        const nextOpen = !isOpen
        if (nextOpen && isStreaming) {
            followLatestRef.current = true
        }
        setIsOpen(nextOpen)
    }

    const syncNestedFollow = useCallback(() => {
        const scroll = scrollRef.current
        if (!scroll) return
        const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 8
        const followLatest = atBottom && !pointerActiveRef.current
        followLatestRef.current = followLatest
        chatContext?.onNestedScrollFollowChange?.(followLatest)
    }, [chatContext])

    const handleScroll = (_event: UIEvent<HTMLDivElement>) => {
        syncNestedFollow()
    }

    const claimNestedScroll = () => {
        chatContext?.onNestedScrollFollowChange?.(false)
    }

    const scheduleNestedFollowSync = () => {
        if (followSyncFrameRef.current !== null) {
            window.cancelAnimationFrame(followSyncFrameRef.current)
        }
        followSyncFrameRef.current = window.requestAnimationFrame(() => {
            followSyncFrameRef.current = null
            syncNestedFollow()
        })
    }

    const claimNestedPointerScroll = () => {
        pointerActiveRef.current = true
        followLatestRef.current = false
        claimNestedScroll()
        pointerCleanupRef.current?.()

        const finish = () => {
            pointerCleanupRef.current?.()
            pointerActiveRef.current = false
            syncNestedFollow()
        }
        const cleanup = () => {
            window.removeEventListener('pointerup', finish)
            window.removeEventListener('pointercancel', finish)
            pointerCleanupRef.current = null
        }
        pointerCleanupRef.current = cleanup
        window.addEventListener('pointerup', finish, { once: true })
        window.addEventListener('pointercancel', finish, { once: true })
    }

    const claimNestedWheelScroll = () => {
        claimNestedScroll()
        scheduleNestedFollowSync()
    }

    const claimNestedKeyboardScroll = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return
        claimNestedScroll()
        scheduleNestedFollowSync()
    }

    useEffect(() => () => {
        pointerCleanupRef.current?.()
        if (followSyncFrameRef.current !== null) {
            window.cancelAnimationFrame(followSyncFrameRef.current)
        }
    }, [])

    return (
        <div
            data-hapi-share-exclude="true"
            data-pw-tool=""
            className={cn('aui-reasoning-group pw-ledger overflow-hidden', LEDGER_RUN_ITEM_CLASS)}
        >
            <button
                type="button"
                onClick={handleToggle}
                aria-expanded={isOpen}
                className={cn(
                    'pw-row-fill flex w-full items-center gap-3 px-1 py-2.5 text-left text-[13px] font-semibold',
                    'text-[var(--app-hint)] transition-colors duration-[var(--dur-fast)] hover:text-[var(--app-fg)]',
                    'cursor-pointer select-none'
                )}
            >
                <span
                    aria-hidden="true"
                    className="pw-plus text-[var(--app-fg)]"
                    data-open={isOpen ? '' : undefined}
                />
                <span>Reasoning</span>
                {isStreaming && (
                    <span className="flex items-center gap-1 text-[var(--app-fg)]">
                        <ShimmerDot />
                    </span>
                )}
            </button>

            <div
                className={cn(
                    'overflow-hidden',
                    isOpen ? 'max-h-[5000px] opacity-100' : 'max-h-0 opacity-0'
                )}
            >
                <div
                    ref={scrollRef}
                    data-hapi-nested-scroll="true"
                    tabIndex={isOpen ? 0 : -1}
                    onScroll={handleScroll}
                    onPointerDown={claimNestedPointerScroll}
                    onWheel={claimNestedWheelScroll}
                    onKeyDown={claimNestedKeyboardScroll}
                    // No overscroll containment: native scroll chaining must pass
                    // to the outer chat viewport once the panel reaches its
                    // bottom (see #1264). The follow-tail coordination above
                    // (onNestedScrollFollowChange) already pauses the outer
                    // auto-follow while the user scrolls inside this panel, so
                    // contain is not needed to stop the two from fighting.
                    className="aui-reasoning-scroll max-h-[60vh] overflow-y-auto pb-3 pl-7 pr-1 pt-0.5"
                >
                    {children}
                </div>
            </div>
        </div>
    )
}
