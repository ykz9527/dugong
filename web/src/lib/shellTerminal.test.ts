import { describe, expect, it, vi } from 'vitest'
import { queueShellCommand, takeShellCommand, typeCommandAtPrompt } from './shellTerminal'

function fakeTerminal(bracketedPasteMode: boolean) {
    return {
        modes: { bracketedPasteMode } as { bracketedPasteMode: boolean } & Record<string, unknown>,
        paste: vi.fn(),
        focus: vi.fn(),
    }
}

describe('typeCommandAtPrompt', () => {
    it('pastes a one-line command without a newline, so it waits for Enter', () => {
        const terminal = fakeTerminal(false)
        expect(typeCommandAtPrompt(terminal as never, 'sudo chown -R me .')).toBe(true)
        expect(terminal.paste).toHaveBeenCalledWith('sudo chown -R me .')
    })

    it('pastes a multi-line command only when the shell has bracketed paste on', () => {
        const unsafe = fakeTerminal(false)
        expect(typeCommandAtPrompt(unsafe as never, 'cd /srv\nsudo make install')).toBe(false)
        expect(unsafe.paste).not.toHaveBeenCalled()

        const safe = fakeTerminal(true)
        expect(typeCommandAtPrompt(safe as never, 'cd /srv\nsudo make install')).toBe(true)
        expect(safe.paste).toHaveBeenCalledWith('cd /srv\nsudo make install')
    })
})

describe('queueShellCommand', () => {
    it('hands the latest command over once, without trailing newlines', () => {
        queueShellCommand('s1', 'ls\n')
        queueShellCommand('s1', 'sudo ls /root\n\n')
        expect(takeShellCommand('s1')).toBe('sudo ls /root')
        expect(takeShellCommand('s1')).toBeNull()
    })
})
