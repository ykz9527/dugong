import { describe, expect, it } from 'vitest'
import { approveForSessionOptions } from './permissionApproval'

describe('approveForSessionOptions', () => {
    it('allows the tool by name for Claude, which ignores `decision`', () => {
        expect(approveForSessionOptions('claude', 'Edit', { file_path: '/a' }))
            .toEqual({ allowTools: ['Edit'] })
    })

    it('allows only the exact command for a Claude Bash request', () => {
        expect(approveForSessionOptions('claude', 'Bash', { command: 'npm test' }))
            .toEqual({ allowTools: ['Bash(npm test)'] })
    })

    it('says approved_for_session to every other agent', () => {
        expect(approveForSessionOptions('codex', 'CodexBash', { command: 'ls' }))
            .toEqual({ decision: 'approved_for_session' })
        expect(approveForSessionOptions(undefined, 'Edit', {}))
            .toEqual({ decision: 'approved_for_session' })
    })
})
