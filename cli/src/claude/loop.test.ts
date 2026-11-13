import { describe, expect, it, vi } from 'vitest'

const runLocalRemoteSessionMock = vi.hoisted(() => vi.fn(async (options: { session: { stopKeepAlive: () => void } }) => {
    options.session.stopKeepAlive()
}))

vi.mock('@/agent/loopBase', () => ({
    runLocalRemoteSession: runLocalRemoteSessionMock
}))

vi.mock('@/ui/logger', () => ({
    logger: {
        logFilePath: '/tmp/hapi.log',
        debug: vi.fn()
    }
}))

vi.mock('./claudeLocalLauncher', () => ({
    claudeLocalLauncher: vi.fn()
}))

vi.mock('./claudeRemoteLauncher', () => ({
    claudeRemoteLauncher: vi.fn()
}))

import { loop } from './loop'

describe('claude loop', () => {
    it('initializes the Claude session id from resumeSessionId', async () => {
        const sessionClient = {
            keepAlive: vi.fn(),
            emitMessagesConsumed: vi.fn(),
            updateMetadata: vi.fn()
        }

        await loop({
            path: '/tmp/project',
            startingMode: 'local',
            onModeChange: () => {},
            mcpServers: {},
            session: sessionClient as never,
            api: {} as never,
            messageQueue: {} as never,
            hookSettingsPath: '/tmp/hooks.json',
            resumeSessionId: '11111111-1111-4111-8111-111111111111'
        })

        expect(runLocalRemoteSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            session: expect.objectContaining({
                sessionId: '11111111-1111-4111-8111-111111111111'
            })
        }))
    })

    it('starts on auto when nothing said how the session should run', async () => {
        // `default` stops at every uncleared tool, which is the wrong footing
        // for a session resumed from the board or driven from a phone.
        const sessionClient = {
            keepAlive: vi.fn(),
            emitMessagesConsumed: vi.fn(),
            updateMetadata: vi.fn()
        }

        await loop({
            path: '/tmp/project',
            startingMode: 'local',
            onModeChange: () => {},
            mcpServers: {},
            session: sessionClient as never,
            api: {} as never,
            messageQueue: {} as never,
            hookSettingsPath: '/tmp/hooks.json'
        })

        expect(sessionClient.keepAlive).toHaveBeenCalledWith(
            false,
            'local',
            expect.objectContaining({ permissionMode: 'auto' })
        )
    })

    it('leaves an explicit default alone', async () => {
        // An explicit `default` is a decision, not an absence — the fallback
        // must not overrule the operator or the runner's --permission-mode.
        const sessionClient = {
            keepAlive: vi.fn(),
            emitMessagesConsumed: vi.fn(),
            updateMetadata: vi.fn()
        }

        await loop({
            path: '/tmp/project',
            startingMode: 'local',
            permissionMode: 'default',
            onModeChange: () => {},
            mcpServers: {},
            session: sessionClient as never,
            api: {} as never,
            messageQueue: {} as never,
            hookSettingsPath: '/tmp/hooks.json'
        })

        expect(sessionClient.keepAlive).toHaveBeenCalledWith(
            false,
            'local',
            expect.objectContaining({ permissionMode: 'default' })
        )
    })
})
