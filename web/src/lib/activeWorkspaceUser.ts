import { useSyncExternalStore } from 'react'

/**
 * Which workspace user the operator is currently looking through.
 *
 * The *definitions* live on the hub (so a phone and a laptop agree on who
 * "Kai" is and which directories are his), but the *selection* is local: it is
 * a lens on this screen, and two people sharing a hub must be able to hold
 * different lenses at the same time. Putting it on the server would make one
 * of them flip the other's view.
 *
 * Module-level rather than React state because the SSE handler needs the same
 * answer the session list is rendering from. If the stream applied a live
 * update the list would have filtered out, someone else's session would appear
 * mid-scroll and stay until a refetch.
 */

const STORAGE_KEY = 'hapi.workspaceUser.v1.activeId'

type Listener = () => void

const listeners = new Set<Listener>()
/** Told only when another tab switched the user; see the `storage` listener. */
const elsewhereListeners = new Set<Listener>()

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof localStorage !== 'undefined'
}

function read(): string | null {
    if (!isBrowser()) return null
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        return raw && raw.trim().length > 0 ? raw : null
    } catch {
        return null
    }
}

let current: string | null = read()

function emit(): void {
    for (const listener of listeners) {
        listener()
    }
}

/**
 * Root paths of the selected user, mirrored out of the hub's list.
 *
 * The SSE handler needs to answer "is this session mine?" the instant an event
 * arrives, from a plain function call — it cannot read a query. Kept in sync by
 * `useWorkspaceUserScopeSync`, mounted once at app level. Null means either
 * nobody is selected or the list has not loaded yet; both read as "no filter",
 * which matches what the list endpoint returns in the same state.
 */
let activeRoots: readonly string[] | null = null

export function getActiveWorkspaceUserId(): string | null {
    return current
}

export function getActiveWorkspaceRoots(): readonly string[] | null {
    if (current === null) return null
    // Selected, but the list has not loaded yet: claim nothing rather than
    // everything. A live update dropped here comes back on the next refetch;
    // one let through would put another person's session in front of someone
    // who explicitly asked not to see it.
    return activeRoots ?? []
}

export function setActiveWorkspaceRoots(roots: readonly string[] | null): void {
    activeRoots = roots
}

export function setActiveWorkspaceUserId(id: string | null): void {
    if (current === id) return
    current = id
    // Dropped rather than carried over: the old user's roots applied to the new
    // selection would be exactly backwards for one render.
    activeRoots = null
    if (isBrowser()) {
        try {
            if (id === null) {
                localStorage.removeItem(STORAGE_KEY)
            } else {
                localStorage.setItem(STORAGE_KEY, id)
            }
        } catch {
            // A private-mode browser still gets the filter for this tab.
        }
    }
    emit()
}

function subscribeActiveWorkspaceUser(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

/**
 * Called when another tab switched the user, after this tab has followed.
 *
 * A switch made here goes through `useSwitchWorkspaceUser`, which also drops
 * the cached session list; one made elsewhere has to do the same, and only a
 * component (with a query client) can.
 */
export function subscribeWorkspaceUserSwitchedElsewhere(listener: Listener): () => void {
    elsewhereListeners.add(listener)
    return () => {
        elsewhereListeners.delete(listener)
    }
}

if (isBrowser()) {
    // Another tab switching user should not leave this one filtering by
    // somebody who is no longer selected anywhere.
    window.addEventListener('storage', (event) => {
        if (event.key !== STORAGE_KEY) return
        const next = event.newValue && event.newValue.trim().length > 0 ? event.newValue : null
        if (current === next) return
        current = next
        // Same reason as `setActiveWorkspaceUserId`: the old user's roots
        // must not filter the new user's sessions.
        activeRoots = null
        emit()
        for (const listener of elsewhereListeners) {
            listener()
        }
    })
}

export function useActiveWorkspaceUserId(): string | null {
    return useSyncExternalStore(
        subscribeActiveWorkspaceUser,
        getActiveWorkspaceUserId,
        () => null
    )
}
