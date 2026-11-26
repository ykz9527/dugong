import { afterEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { EnhancedMode } from './loop'

// Stand-in for Claude Code's alias resolution, as its system/init reports it.
const RESOLVES_TO: Record<string, string> = { default: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' }

const harness = vi.hoisted(() => ({
    triggerSwitch: null as (() => void) | null,
    finalMessage: 'two'
}))

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: any) => {
        const initial = await opts.nextMessage()
        if (!initial) return
        const model = initial.mode.model ?? 'default'
        let turn = initial
        while (true) {
            // Like Claude Code: every turn of the process starts with system/init.
            opts.onMessage({ type: 'system', subtype: 'init', session_id: 's', model: RESOLVES_TO[model] })
            if (turn.message === harness.finalMessage) harness.triggerSwitch?.()
            turn = await opts.nextMessage()
            if (!turn) return
        }
    }
}))

vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class {
        setOnPermissionRequest(): void {}
        getResponses(): Map<string, unknown> { return new Map() }
        onMessage(): void {}
        handleToolCall = async () => ({ behavior: 'allow', updatedInput: {} })
        reset(): void {}
        isAborted(): boolean { return false }
        handleModeChange(): void {}
    }
}))

vi.mock('./utils/OutgoingMessageQueue', () => ({
    OutgoingMessageQueue: class {
        releaseToolCall(): void {}
        enqueue(): void {}
        async flush(): Promise<void> {}
        destroy(): void {}
    }
}))

import { claudeRemoteLauncher } from './claudeRemoteLauncher'
import { Session } from './session'

function createClientStub() {
    const rpcHandlers = new Map<string, () => void | Promise<void>>()
    let metadata: any = {}
    const writes: any[] = []
    return {
        rpcHandlerManager: {
            registerHandler: (method: string, handler: () => void | Promise<void>) => {
                rpcHandlers.set(method, handler)
            }
        },
        rpcHandlers,
        writes,
        getMetadata: () => metadata,
        updateMetadata: (mutator: (metadata: any) => any) => {
            metadata = mutator(metadata)
            writes.push(metadata.claudeResolvedModel)
        },
        keepAlive: () => {},
        emitMessagesConsumed: () => {},
        sendClaudeSessionMessage: () => {},
        sendSessionEvent: () => {},
        notePendingHubPromptEcho: () => {},
        discardPendingHubPromptEcho: () => {},
        discardPendingHubPromptEchoText: () => {},
        resetBackgroundTasks: () => {}
    }
}

describe('claudeRemoteLauncher reports the resolved model', () => {
    afterEach(() => {
        harness.triggerSwitch = null
    })

    it('pairs each init model with the selection its turn ran with, writing only on change', async () => {
        const client = createClientStub()
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode))
        const session = new Session({
            api: {} as any,
            client: client as any,
            path: '/tmp/test',
            logPath: '/tmp/test.log',
            sessionId: null,
            claudeEnvVars: {},
            claudeArgs: undefined,
            mcpServers: {},
            messageQueue: queue,
            onModeChange: () => {},
            allowedTools: [],
            mode: 'remote',
            startedBy: 'runner',
            startingMode: 'remote',
            hookSettingsPath: '/tmp/hook.json',
            permissionMode: 'default'
        })
        try {
            queue.push('one', { permissionMode: 'default' }, 'local-1')
            queue.push('one-b', { permissionMode: 'default' }, 'local-1b')
            queue.push('two', { permissionMode: 'default', model: 'sonnet' }, 'local-2')
            harness.triggerSwitch = () => { client.rpcHandlers.get(RPC_METHODS.Switch)?.() }

            await claudeRemoteLauncher(session as any)

            expect(client.writes).toEqual([
                { selected: null, model: 'claude-opus-5-5' },
                { selected: 'sonnet', model: 'claude-sonnet-5-5' }
            ])
        } finally {
            session.stopKeepAlive()
        }
    })
})
