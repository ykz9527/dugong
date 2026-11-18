import type { Terminal } from '@xterm/xterm'
import { randomId } from '@/lib/randomId'

// The user's shell for a session ("Terminal" — not the agent's own PTY).
//
// One shell per browser tab per session: the id lives in sessionStorage, so
// closing the panel, leaving the terminal page or reloading reattaches to the
// same shell (the hub replays its scrollback) instead of leaving the old one
// running until the idle timeout. Another tab or device has its own storage and
// so its own shell; if a duplicated tab does reuse an id, the hub tells the tab
// it took over from (hub/src/socket/handlers/terminal.ts).

const STORAGE_PREFIX = 'dugong.shellTerminal.v1.'
const idsWithoutStorage = new Map<string, string>()

function tabStorage(): Storage | null {
    try {
        return window.sessionStorage
    } catch {
        return null
    }
}

export function getShellTerminalId(sessionId: string): string {
    const storage = tabStorage()
    const key = STORAGE_PREFIX + sessionId
    let id: string | null = null
    try {
        id = storage ? storage.getItem(key) : idsWithoutStorage.get(sessionId) ?? null
    } catch {
        id = idsWithoutStorage.get(sessionId) ?? null
    }
    if (id) {
        return id
    }

    id = `term-${sessionId}-${randomId()}`
    idsWithoutStorage.set(sessionId, id)
    try {
        storage?.setItem(key, id)
    } catch {
        // Storage full or blocked: the in-memory id still holds for this page.
    }
    return id
}

// A command handed to the shell from elsewhere ("Run in terminal" on a tool
// card). It waits here until a shell view for the session is connected; the
// view types it at the prompt without pressing Enter.

const pendingCommands = new Map<string, string>()
const listeners = new Set<() => void>()

export function queueShellCommand(sessionId: string, command: string): void {
    const trimmed = command.replace(/\s+$/, '')
    if (!trimmed) {
        return
    }
    pendingCommands.set(sessionId, trimmed)
    for (const listener of listeners) {
        listener()
    }
}

export function hasShellCommand(sessionId: string): boolean {
    return pendingCommands.has(sessionId)
}

export function takeShellCommand(sessionId: string): string | null {
    const command = pendingCommands.get(sessionId) ?? null
    pendingCommands.delete(sessionId)
    return command
}

export function subscribeShellCommands(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

/**
 * Types `command` at the prompt as a paste, without pressing Enter. Returns
 * false, typing nothing, for a multi-line command the shell would run line by
 * line because it has not turned on bracketed paste.
 */
export function typeCommandAtPrompt(
    terminal: Pick<Terminal, 'modes' | 'paste' | 'focus'>,
    command: string
): boolean {
    if (command.includes('\n') && !terminal.modes.bracketedPasteMode) {
        return false
    }
    terminal.paste(command)
    terminal.focus()
    return true
}
