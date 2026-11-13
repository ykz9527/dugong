import { beforeEach, describe, expect, it } from 'bun:test'
import { AssistantCompaction, contextWindowFor } from './assistantCompaction'
import type { Session, SyncEvent } from './syncEngine'

let session: Session
let sent: Array<{ sessionId: string; text: string }>
let compacted: string[]
let compaction: AssistantCompaction

function usage(tokens: number): SyncEvent {
    return {
        type: 'message-received',
        sessionId: session.id,
        message: {
            id: `m-${Math.random()}`, seq: 1, localId: null, createdAt: 0,
            content: { role: 'agent', content: { type: 'output', data: { type: 'assistant', message: { usage: {
                input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0
            } } } } }
        }
    } as unknown as SyncEvent
}

function ready(): SyncEvent {
    return {
        type: 'message-received',
        sessionId: session.id,
        message: { id: `r-${Math.random()}`, seq: 2, localId: null, createdAt: 0, content: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } } }
    } as unknown as SyncEvent
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
    session = {
        id: 's-assistant', namespace: 'default', active: true, model: 'opus', backgroundTaskCount: 0,
        metadata: { path: '/a', host: 'h', role: 'assistant', workspaceUserId: 'wu' }
    } as unknown as Session
    sent = []
    compacted = []
    compaction = new AssistantCompaction({
        getSession: (id) => (id === session.id ? session : undefined),
        send: async (sessionId, text) => { sent.push({ sessionId, text }) },
        onCompacted: (id) => compacted.push(id)
    })
})

describe('AssistantCompaction', () => {
    it('leaves a turn alone below the threshold', async () => {
        compaction.handle(usage(100_000))
        compaction.handle(ready())
        await flush()
        expect(sent).toHaveLength(0)
    })

    it('curates, then compacts, then forgets the context it had sent', async () => {
        compaction.handle(usage(150_000))
        compaction.handle(ready())
        await flush()
        expect(sent).toHaveLength(1)
        expect(sent[0].text).toContain('[dugong:curate-memory] The context is about 75% full')

        compaction.handle(usage(152_000))
        compaction.handle(ready())
        await flush()
        expect(sent[1].text).toBe('/compact')
        expect(compacted).toEqual([])

        compaction.handle(ready())
        await flush()
        expect(compacted).toEqual(['s-assistant'])
        expect(sent).toHaveLength(2)

        // Fresh after compaction: a small turn does not start another round.
        compaction.handle(usage(20_000))
        compaction.handle(ready())
        await flush()
        expect(sent).toHaveLength(2)
    })

    it('keeps the hub\'s own two turns quiet, but not the person\'s turn that set them off', async () => {
        compaction.handle(usage(150_000))
        compaction.handle(ready())
        // The person's own ready is checked before the curate prompt is out.
        expect(compaction.consumeQuietReady('s-assistant')).toBe(false)
        await flush()

        compaction.handle(ready())
        expect(compaction.consumeQuietReady('s-assistant')).toBe(true)
        await flush()
        compaction.handle(ready())
        expect(compaction.consumeQuietReady('s-assistant')).toBe(true)
        await flush()
        expect(compaction.consumeQuietReady('s-assistant')).toBe(false)
    })

    it('waits for background work before either step', async () => {
        session = { ...session, backgroundTaskCount: 1 } as Session
        compaction.handle(usage(190_000))
        compaction.handle(ready())
        await flush()
        expect(sent).toHaveLength(0)

        session = { ...session, backgroundTaskCount: 0 } as Session
        compaction.handle(ready())
        await flush()
        expect(sent).toHaveLength(1)
    })

    it('ignores sessions that are not assistants', async () => {
        session = { ...session, metadata: { path: '/a', host: 'h' } } as unknown as Session
        compaction.handle(usage(190_000))
        compaction.handle(ready())
        await flush()
        expect(sent).toHaveLength(0)
    })

    it('goes by the window Claude reports over the model-name guess', async () => {
        compaction.handle({
            type: 'message-received',
            sessionId: session.id,
            message: { id: 'res', seq: 3, localId: null, createdAt: 0, content: { role: 'agent', content: { type: 'output', data: {
                type: 'summary', resultSummary: { modelUsage: { 'claude-haiku-4-5': { contextWindow: 200_000 }, 'claude-opus-5-5': { contextWindow: 1_000_000 } } }
            } } } }
        } as unknown as SyncEvent)
        compaction.handle(usage(150_000))
        compaction.handle(ready())
        await flush()
        // 15% of a 1M window: nowhere near the threshold.
        expect(sent).toHaveLength(0)

        compaction.handle(usage(720_000))
        compaction.handle(ready())
        await flush()
        expect(sent[0].text).toContain('about 72%')
    })

    it('reads Codex token counts and the window Codex reports', async () => {
        const codexUsage = (inputTokens: number) => ({
            type: 'message-received',
            sessionId: session.id,
            message: {
                id: `c-${Math.random()}`, seq: 1, localId: null, createdAt: 0,
                content: { role: 'agent', content: { type: 'codex', data: { type: 'token_count', info: {
                    last: { inputTokens, outputTokens: 10 }, total: { inputTokens: 9_000_000, outputTokens: 10 },
                    modelContextWindow: 400_000
                } } } }
            }
        }) as unknown as SyncEvent
        compaction.handle(codexUsage(200_000))
        compaction.handle(ready())
        await flush()
        expect(sent).toHaveLength(0)

        compaction.handle(codexUsage(300_000))
        compaction.handle(ready())
        await flush()
        expect(sent[0].text).toContain('about 75%')
    })

    it('knows the long-context model has a bigger window', () => {
        expect(contextWindowFor('opus')).toBe(200_000)
        expect(contextWindowFor('opus[1m]')).toBe(1_000_000)
    })
})
