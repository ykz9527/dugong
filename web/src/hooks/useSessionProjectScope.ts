import { useCallback, useEffect, useState } from 'react'

/**
 * Whether the sidebar narrows to the open session's project.
 *
 * `follow` is the default: opening a session is a statement about what you are
 * working on, and the list following that is the behaviour people expect from
 * a project-scoped tool. `all` is the escape hatch, and it persists — someone
 * who deliberately wants the full list should not have to re-say it on every
 * navigation.
 *
 * Storage shape and cross-tab sync mirror `useSessionListMachineFilter`.
 */

export type SessionProjectScope = 'follow' | 'all'

const STORAGE_KEY = 'hapi.sessionList.projectScope'

function isBrowser(): boolean {
    return typeof window !== 'undefined'
}

function parseSessionProjectScope(raw: string | null): SessionProjectScope {
    return raw === 'all' ? 'all' : 'follow'
}

function readStoredScope(): SessionProjectScope {
    if (!isBrowser()) return 'follow'
    try {
        return parseSessionProjectScope(localStorage.getItem(STORAGE_KEY))
    } catch {
        return 'follow'
    }
}

export function useSessionProjectScope(): {
    projectScope: SessionProjectScope
    setProjectScope: (scope: SessionProjectScope) => void
} {
    const [projectScope, setScopeState] = useState<SessionProjectScope>(readStoredScope)

    useEffect(() => {
        if (!isBrowser()) return

        const onStorage = (event: StorageEvent) => {
            if (event.key !== STORAGE_KEY) return
            setScopeState(parseSessionProjectScope(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setProjectScope = useCallback((scope: SessionProjectScope) => {
        setScopeState(scope)
        if (!isBrowser()) return
        try {
            localStorage.setItem(STORAGE_KEY, scope)
        } catch {
            // Private mode / blocked storage: the scope still applies this session.
        }
    }, [])

    return { projectScope, setProjectScope }
}
