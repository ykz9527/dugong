import { describe, expect, it } from 'vitest'
import { parseAgyCommandOptions } from './agy'

describe('parseAgyCommandOptions', () => {
    it('defaults AGY to remote (headless) mode', () => {
        expect(parseAgyCommandOptions([]).startingMode).toBe('remote')
    })

    it('accepts explicit remote mode', () => {
        expect(parseAgyCommandOptions(['--hapi-starting-mode', 'remote']).startingMode).toBe('remote')
    })

    it.each(['local', 'pty'])('rejects unsupported %s mode', (mode) => {
        expect(() => parseAgyCommandOptions(['--hapi-starting-mode', mode])).toThrow(
            'Invalid --hapi-starting-mode'
        )
    })

    it('reads the task assistant flags without disturbing the rest', () => {
        const options = parseAgyCommandOptions([
            '--hapi-starting-mode', 'remote', '--started-by', 'runner',
            '--dugong-role', 'assistant', '--dugong-workspace-user', 'wu-1', '--dugong-add-dir', '/home/u/a',
            '--existing-session-id', 's-1'
        ])
        expect(options.assistant).toEqual({ workspaceUserId: 'wu-1', addDirs: ['/home/u/a'] })
        expect(options.existingSessionId).toBe('s-1')
        expect(options.startedBy).toBe('runner')
        expect(parseAgyCommandOptions([]).assistant).toBeUndefined()
    })
})
