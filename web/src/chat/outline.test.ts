import { describe, expect, it } from 'vitest'
import type { AgentEvent, ChatBlock } from '@/chat/types'
import { buildConversationOutline, mergeOutlineWithTurns, truncateOutlineLabel } from '@/chat/outline'

function userBlock(
    id: string,
    text: string,
    createdAt: number,
    overrides: Partial<Extract<ChatBlock, { kind: 'user-text' }>> = {}
): ChatBlock {
    return {
        kind: 'user-text',
        id,
        localId: null,
        createdAt,
        text,
        ...overrides
    }
}

function eventBlock(id: string, event: AgentEvent, createdAt: number): ChatBlock {
    return {
        kind: 'agent-event',
        id,
        createdAt,
        event,
    }
}

describe('conversation outline', () => {
    it('creates outline items from user messages', () => {
        expect(buildConversationOutline([
            userBlock('m1', 'Implement the outline panel', 1000),
        ])).toEqual([
            {
                id: 'outline:user-text:m1',
                targetMessageId: 'user-text:m1',
                kind: 'user',
                label: 'Implement the outline panel',
                createdAt: 1000
            }
        ])
    })

    it('ignores title and summary events', () => {
        const items = buildConversationOutline([
            eventBlock('e1', { type: 'title-changed', title: 'Add conversation outline' }, 1000),
            eventBlock('e2', { type: 'message', message: 'Context compacted into a summary.' }, 2000),
            eventBlock('e3', { type: 'ready' }, 3000),
        ])

        expect(items).toEqual([])
    })

    it('handles empty and long labels', () => {
        expect(buildConversationOutline([
            userBlock('empty', ' \n\t ', 1000),
        ])[0]?.label).toBe('Empty message')

        expect(truncateOutlineLabel('a '.repeat(80), 20)).toBe('a a a a a a a a a...')
    })

    it('filters queued user messages that are not yet locatable in the thread', () => {
        const items = buildConversationOutline([
            userBlock('queued', 'Queued prompt', 1000, { status: 'queued', invokedAt: null }),
            userBlock('sent', 'Visible prompt', 2000, { status: 'sent', invokedAt: 2500 }),
        ])

        expect(items.map((item) => item.id)).toEqual([
            'outline:user-text:sent'
        ])
    })

    it('keeps block order stable', () => {
        const items = buildConversationOutline([
            userBlock('first', 'First', 1000),
            eventBlock('summary', { type: 'message', message: 'Summary' }, 900),
            userBlock('second', 'Second', 1100),
        ])

        expect(items.map((item) => item.id)).toEqual([
            'outline:user-text:first',
            'outline:user-text:second'
        ])
    })
})

describe('mergeOutlineWithTurns', () => {
    it('lists every turn, reusing loaded rows and jumping to the rest', () => {
        const loaded = buildConversationOutline([
            userBlock('m3', 'third, loaded', 3_000),
            userBlock('m4', 'sent after the list was fetched', 4_000)
        ])
        const turns = [
            { id: 'm1', seq: 1, at: 1_000, text: 'first' },
            { id: 'm2', seq: 50, at: 2_000, text: 'second' },
            { id: 'm3', seq: 90, at: 3_000, text: 'third, loaded' }
        ]

        const items = mergeOutlineWithTurns(loaded, turns)

        expect(items.map((item) => item.targetMessageId)).toEqual([
            'user-text:m1', 'user-text:m2', 'user-text:m3', 'user-text:m4'
        ])
        expect(items[0]?.jumpTo).toEqual({ target: { at: 1_000, seq: 1 }, end: { at: 2_000, seq: 50 } })
        expect(items[1]?.jumpTo).toEqual({ target: { at: 2_000, seq: 50 }, end: { at: 3_000, seq: 90 } })
        expect(items[2]).toBe(loaded[0])
        expect(items[3]).toBe(loaded[1])
    })

    it('falls back to the loaded rows before the list arrives', () => {
        const loaded = buildConversationOutline([userBlock('m1', 'only', 1_000)])
        expect(mergeOutlineWithTurns(loaded, undefined)).toEqual(loaded)
    })
})
