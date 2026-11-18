import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { Terminal } from '@xterm/xterm'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { getShellTerminalId, typeCommandAtPrompt } from '@/lib/shellTerminal'
import { useTerminalSocket } from '@/hooks/useTerminalSocket'
import { usePendingShellCommand } from '@/hooks/usePendingShellCommand'
import { TerminalView } from '@/components/Terminal/TerminalView'

const HEIGHT_STORAGE_KEY = 'dugong.shellPanel.height'
const DEFAULT_HEIGHT = 300
const MIN_HEIGHT = 140
const KEYBOARD_STEP = 24
const EXIT_CLOSE_DELAY_MS = 700

function maxHeight(): number {
    return Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.7))
}

function clampHeight(value: number): number {
    return Math.min(maxHeight(), Math.max(MIN_HEIGHT, Math.round(value)))
}

function readStoredHeight(): number {
    try {
        const stored = Number.parseInt(window.localStorage.getItem(HEIGHT_STORAGE_KEY) ?? '', 10)
        return clampHeight(Number.isFinite(stored) ? stored : DEFAULT_HEIGHT)
    } catch {
        return clampHeight(DEFAULT_HEIGHT)
    }
}

function storeHeight(value: number): void {
    try {
        window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(value))
    } catch {
        // Height just won't be remembered.
    }
}

function CloseIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
    )
}

/**
 * The session's shell, docked under the chat on desktop. Closing the panel
 * only detaches: the shell keeps running and reopening reattaches to it.
 */
export function ShellTerminalPanel(props: {
    sessionId: string
    cwd: string | null
    onClose: () => void
}) {
    const { t } = useTranslation()
    const { token, baseUrl } = useAppContext()
    const { sessionId, onClose } = props
    const terminalId = getShellTerminalId(sessionId)
    const terminalRef = useRef<Terminal | null>(null)
    const inputDisposableRef = useRef<{ dispose: () => void } | null>(null)
    const connectOnceRef = useRef(false)
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
    const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [height, setHeight] = useState(readStoredHeight)
    const heightRef = useRef(height)
    const [dragging, setDragging] = useState(false)
    const [notice, setNotice] = useState<string | null>(null)

    const { state, connect, write, resize, disconnect, onOutput, onExit } = useTerminalSocket({
        token,
        sessionId,
        terminalId,
        baseUrl,
    })

    const applyCommand = useCallback((command: string) => {
        const terminal = terminalRef.current
        if (terminal) {
            setNotice(typeCommandAtPrompt(terminal, command) ? null : t('terminal.paste.multilineUnsafe'))
        }
    }, [t])

    const pending = usePendingShellCommand({
        sessionId,
        ready: state.status === 'connected',
        apply: applyCommand,
    })

    useEffect(() => {
        onOutput((data) => {
            terminalRef.current?.write(data)
            pending.noteOutput()
        })
    }, [onOutput, pending.noteOutput])

    useEffect(() => {
        onExit((code) => {
            terminalRef.current?.write(`\r\n[process exited${code !== null ? ` with code ${code}` : ''}]`)
            if (exitTimerRef.current) {
                clearTimeout(exitTimerRef.current)
            }
            exitTimerRef.current = setTimeout(() => {
                exitTimerRef.current = null
                onClose()
            }, EXIT_CLOSE_DELAY_MS)
        })
    }, [onExit, onClose])

    useEffect(() => {
        return () => {
            inputDisposableRef.current?.dispose()
            if (exitTimerRef.current) {
                clearTimeout(exitTimerRef.current)
            }
            disconnect()
        }
    }, [disconnect])

    const handleMount = useCallback((terminal: Terminal) => {
        terminalRef.current = terminal
        inputDisposableRef.current?.dispose()
        inputDisposableRef.current = terminal.onData((data) => {
            setNotice(null)
            write(data)
        })
        terminal.focus()
    }, [write])

    const handleResize = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        if (!connectOnceRef.current) {
            connectOnceRef.current = true
            connect(cols, rows)
        } else {
            resize(cols, rows)
        }
    }, [connect, resize])

    const handleRetry = useCallback(() => {
        const size = lastSizeRef.current
        if (size) {
            connect(size.cols, size.rows)
        }
    }, [connect])

    const applyHeight = useCallback((value: number) => {
        const next = clampHeight(value)
        heightRef.current = next
        setHeight(next)
    }, [])

    const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault()
        const handle = event.currentTarget
        const startY = event.clientY
        const startHeight = heightRef.current
        handle.setPointerCapture(event.pointerId)
        setDragging(true)
        const onMove = (moveEvent: PointerEvent) => applyHeight(startHeight + startY - moveEvent.clientY)
        const onEnd = () => {
            handle.removeEventListener('pointermove', onMove)
            handle.removeEventListener('pointerup', onEnd)
            handle.removeEventListener('pointercancel', onEnd)
            setDragging(false)
            storeHeight(heightRef.current)
        }
        handle.addEventListener('pointermove', onMove)
        handle.addEventListener('pointerup', onEnd)
        handle.addEventListener('pointercancel', onEnd)
    }, [applyHeight])

    const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
        const delta = event.key === 'ArrowUp' ? KEYBOARD_STEP : event.key === 'ArrowDown' ? -KEYBOARD_STEP : 0
        if (!delta) {
            return
        }
        event.preventDefault()
        applyHeight(heightRef.current + delta)
        storeHeight(heightRef.current)
    }, [applyHeight])

    const status = state.status
    const error = state.status === 'error' ? state.error : null
    const dotClass = status === 'connected'
        ? 'bg-[var(--app-fg)]'
        : status === 'connecting'
            ? 'bg-[var(--app-fg)] animate-pulse'
            : status === 'error'
                ? 'bg-[var(--app-accent)]'
                : 'bg-[var(--p-grey-3)]'

    return (
        <section
            className="flex shrink-0 flex-col bg-[var(--app-bg)]"
            style={{ height }}
            aria-label={t('composer.terminal')}
        >
            <div
                role="separator"
                aria-orientation="horizontal"
                aria-label={t('terminal.panel.resize')}
                aria-valuenow={height}
                aria-valuemin={MIN_HEIGHT}
                tabIndex={0}
                className="shell-panel-resize-handle shrink-0"
                data-dragging={dragging || undefined}
                onPointerDown={handleResizePointerDown}
                onKeyDown={handleResizeKeyDown}
            />
            <div className="mx-auto flex w-full max-w-content shrink-0 items-center gap-2 px-3 py-1">
                <span className="text-xs font-semibold text-[var(--app-fg)]">{t('composer.terminal')}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--app-hint)]" title={props.cwd ?? undefined}>
                    {props.cwd}
                </span>
                {error ? (
                    <>
                        <span className="min-w-0 max-w-[45%] truncate text-xs text-[var(--app-accent)]" title={error}>{error}</span>
                        <button
                            type="button"
                            onClick={handleRetry}
                            className="pw-ghost-sweep inline-flex h-6 shrink-0 items-center rounded-full border border-[var(--app-fg)] px-2.5 text-xs font-semibold"
                        >
                            {t('terminal.retry')}
                        </button>
                    </>
                ) : null}
                <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} role="status" aria-label={status} />
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('terminal.panel.close')}
                    title={t('terminal.panel.close')}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                >
                    <CloseIcon />
                </button>
            </div>
            {notice ? (
                <div className="mx-auto w-full max-w-content shrink-0 px-3 pb-1 text-xs text-[var(--app-accent)]">
                    {notice}
                </div>
            ) : null}
            <div className="min-h-0 flex-1 px-3 pb-2">
                <div className="mx-auto h-full w-full max-w-content">
                    <TerminalView onMount={handleMount} onResize={handleResize} className="h-full w-full" />
                </div>
            </div>
        </section>
    )
}
