import { describe, expect, it } from 'vitest'
import type { AssistantMemory } from '@hapi/protocol'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { parseAssistantToolResult } from '@/components/ToolCard/assistantTools'
import { isFreshAssistantChange } from '@/components/Assistant/AssistantMemoryTab'

const t = (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key

describe('task assistant tool cards', () => {
    it('give the assistant\'s MCP tools their own titles instead of the generic MCP card', () => {
        const write = getToolPresentation({
            toolName: 'mcp__hapi__memory_write',
            input: { description: '发布前比对 schema' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null
        }, t)
        expect(write.title).toBe('assistant.tool.memory_write')
        expect(write.subtitle).toBe('发布前比对 schema')
        expect(write.minimal).toBe(false)

        const other = getToolPresentation({
            toolName: 'mcp__someone__else',
            input: {},
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null
        }, t)
        expect(other.title).toBe('MCP: Someone Else')
    })

    it('reads the hub\'s JSON out of an MCP text result', () => {
        const result = [{ type: 'text', text: '{"outcome":"created","memory":{"id":"m-1"}}' }]
        expect(parseAssistantToolResult(result)).toEqual({ outcome: 'created', memory: { id: 'm-1' } })
        expect(parseAssistantToolResult([{ type: 'text', text: 'Failed: nope' }])).toBeNull()
    })
})

describe('memory tab badge', () => {
    const base = {
        previous: null, lastEditedBy: 'ai', updatedAt: 2_000
    } as unknown as AssistantMemory

    it('counts what the assistant changed since the person last looked, and any edit still awaiting a decision', () => {
        expect(isFreshAssistantChange(base, 1_000)).toBe(true)
        expect(isFreshAssistantChange(base, 3_000)).toBe(false)
        expect(isFreshAssistantChange({ ...base, lastEditedBy: 'human' }, 1_000)).toBe(false)
        expect(isFreshAssistantChange({ ...base, updatedAt: 0, previous: { body: 'x' } } as unknown as AssistantMemory, 3_000)).toBe(true)
    })
})
