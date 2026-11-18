import { describe, expect, it } from 'vitest'
import { getRunnableShellCommand } from './shellCommand'

describe('getRunnableShellCommand', () => {
    it('takes a command string as is', () => {
        expect(getRunnableShellCommand('Bash', { command: 'sudo systemctl restart nginx' })).toBe('sudo systemctl restart nginx')
    })

    it('unwraps the script from a Codex bash -lc argv', () => {
        expect(getRunnableShellCommand('CodexBash', { command: ['bash', '-lc', "grep -r 'a b' ."] })).toBe("grep -r 'a b' .")
    })

    it('re-quotes other argv so it means the same in a shell', () => {
        expect(getRunnableShellCommand('exec_command', { command: ['git', 'commit', '-m', "it's done"] }))
            .toBe("git commit -m 'it'\\''s done'")
    })

    it('ignores tools that do not run shell commands', () => {
        expect(getRunnableShellCommand('Read', { command: 'ls' })).toBeNull()
    })
})
