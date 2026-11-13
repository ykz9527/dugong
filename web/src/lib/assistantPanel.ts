import { useSyncExternalStore } from 'react'

/**
 * Whether the task assistant's panel is open, shared by the sidebar layout,
 * the session header's button and the phone's floating button. Remembered per
 * browser, like the sidebar width.
 */

const STORAGE_KEY = 'hapi.assistant.v1.open'
const listeners = new Set<() => void>()

function read(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
        return false
    }
}

let open = typeof window !== 'undefined' ? read() : false

export function setAssistantPanelOpen(next: boolean): void {
    if (next === open) return
    open = next
    try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
    } catch {
        // Storage can be unavailable (private mode); the panel still opens.
    }
    for (const listener of listeners) listener()
}

export function toggleAssistantPanel(): void {
    setAssistantPanelOpen(!open)
}

export function useAssistantPanelOpen(): boolean {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        () => open,
        () => false
    )
}
