import { useCallback, useEffect, useRef, useState } from 'react'
import { hasShellCommand, subscribeShellCommands, takeShellCommand } from '@/lib/shellTerminal'

// How long the shell must stay quiet before a queued command is typed in. A
// fresh shell is still printing its prompt (and turning on bracketed paste)
// when it reports ready; typing into that would scramble the prompt.
const SETTLE_MS = 300

/**
 * Hands a queued "Run in terminal" command to `apply` once the shell is
 * connected and has gone quiet. Call `noteOutput` for every chunk of shell
 * output so the hand-off waits for the prompt.
 */
export function usePendingShellCommand(options: {
    sessionId: string
    ready: boolean
    apply: (command: string) => void
}): { noteOutput: () => void } {
    const { sessionId, ready } = options
    const [revision, setRevision] = useState(0)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const applyRef = useRef(options.apply)

    useEffect(() => {
        applyRef.current = options.apply
    }, [options.apply])

    useEffect(() => subscribeShellCommands(() => setRevision((value) => value + 1)), [])

    const schedule = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current)
        }
        timerRef.current = setTimeout(() => {
            timerRef.current = null
            const command = takeShellCommand(sessionId)
            if (command) {
                applyRef.current(command)
            }
        }, SETTLE_MS)
    }, [sessionId])

    useEffect(() => {
        if (!ready || !hasShellCommand(sessionId)) {
            return
        }
        schedule()
        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current)
                timerRef.current = null
            }
        }
    }, [ready, sessionId, revision, schedule])

    const noteOutput = useCallback(() => {
        if (timerRef.current) {
            schedule()
        }
    }, [schedule])

    return { noteOutput }
}
