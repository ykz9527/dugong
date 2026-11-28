import { describe, expect, it, vi } from 'vitest'
import type { PermissionCompletion } from '@/modules/common/permission/BasePermissionHandler'
import type { HapiToolResult } from '@/claude/utils/startHappyServer'

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))

import { createAssistantToolGate } from './assistantToolGate'

const done = (text: string): HapiToolResult => ({ content: [{ type: 'text', text }], isError: false })

function setup(opts: { alwaysProceed?: boolean; granted?: boolean; holdMs?: number } = {}) {
    let answer: ((completion: PermissionCompletion) => void) | null = null
    let cancel: ((error: Error) => void) | null = null
    const delivered: string[] = []
    const asked: Array<{ toolId: string; input: unknown }> = []
    const run = vi.fn(async () => done('moved'))
    const gate = createAssistantToolGate({
        isAlwaysProceed: () => opts.alwaysProceed ?? false,
        hasGrant: async () => opts.granted ?? false,
        ask: (toolId, input) => {
            asked.push({ toolId, input })
            return new Promise((resolve, reject) => { answer = resolve; cancel = reject })
        },
        deliver: (text) => delivered.push(text),
        holdMs: opts.holdMs ?? 5_000
    })
    return {
        gate, run, delivered, asked,
        answer: (completion: PermissionCompletion) => answer?.(completion),
        cancel: () => cancel?.(new Error('Session ended'))
    }
}

describe('createAssistantToolGate', () => {
    it('runs at once under always-proceed or a standing grant', async () => {
        for (const opts of [{ alwaysProceed: true }, { granted: true }]) {
            const s = setup(opts)
            expect(await s.gate('task_move', { taskId: 't' }, s.run)).toEqual(done('moved'))
            expect(s.asked).toEqual([])
        }
    })

    it('asks about peer_respond every time, whatever the mode or grants', async () => {
        const s = setup({ alwaysProceed: true, granted: true })
        const result = s.gate('peer_respond', { requestId: 'r' }, s.run)
        await vi.waitFor(() => expect(s.asked).toEqual([{ toolId: 'mcp__hapi__peer_respond', input: { requestId: 'r' } }]))
        s.answer({ status: 'approved' })
        expect(await result).toEqual(done('moved'))
    })

    it('runs or refuses in the same call when the person answers in time', async () => {
        const approved = setup()
        const first = approved.gate('task_move', {}, approved.run)
        await vi.waitFor(() => expect(approved.asked).toHaveLength(1))
        approved.answer({ status: 'approved' })
        expect(await first).toEqual(done('moved'))

        const denied = setup()
        const second = denied.gate('task_move', {}, denied.run)
        await vi.waitFor(() => expect(denied.asked).toHaveLength(1))
        denied.answer({ status: 'denied', reason: 'not now' })
        const result = await second
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('declined task_move. Their reason: not now')
        expect(denied.run).not.toHaveBeenCalled()
    })

    it('returns before agy gives up, then reports a later answer as a message', async () => {
        const s = setup({ holdMs: 20 })
        const result = await s.gate('ping_peer', {}, s.run)
        expect(result.isError).toBe(false)
        expect(result.content[0].text).toContain('they have not answered yet')
        expect(s.run).not.toHaveBeenCalled()

        s.answer({ status: 'approved' })
        await vi.waitFor(() => expect(s.delivered).toHaveLength(1))
        expect(s.run).toHaveBeenCalledTimes(1)
        expect(s.delivered[0]).toContain('[dugong] The person approved ping_peer, and it has now run.')
        expect(s.delivered[0]).toContain('Result: moved')
    })

    it('reports a later refusal, and stays quiet about a cancel', async () => {
        const denied = setup({ holdMs: 20 })
        await denied.gate('task_start', {}, denied.run)
        denied.answer({ status: 'denied' })
        await vi.waitFor(() => expect(denied.delivered).toEqual(['[dugong] The person declined task_start. Do not retry it unless they ask.']))

        const canceled = setup({ holdMs: 20 })
        await canceled.gate('task_start', {}, canceled.run)
        canceled.cancel()
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(canceled.delivered).toEqual([])
        expect(canceled.run).not.toHaveBeenCalled()
    })
})
