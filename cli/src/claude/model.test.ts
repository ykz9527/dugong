import { describe, expect, it, vi } from 'vitest'
import { normalizeClaudeSessionModel, reportClaudeResolvedModel } from './model'

describe('normalizeClaudeSessionModel', () => {
    it('returns null when model is missing', () => {
        expect(normalizeClaudeSessionModel()).toBeNull()
    })

    it('returns null for auto-like values', () => {
        expect(normalizeClaudeSessionModel('')).toBeNull()
        expect(normalizeClaudeSessionModel('auto')).toBeNull()
        expect(normalizeClaudeSessionModel('default')).toBeNull()
    })

    it('preserves Claude aliases and full model strings', () => {
        expect(normalizeClaudeSessionModel('sonnet')).toBe('sonnet')
        expect(normalizeClaudeSessionModel('opus[1m]')).toBe('opus[1m]')
        expect(normalizeClaudeSessionModel('claude-3-7-sonnet-latest')).toBe('claude-3-7-sonnet-latest')
        expect(normalizeClaudeSessionModel('  claude-opus-4-1-20250805  ')).toBe('claude-opus-4-1-20250805')
    })
})

describe('reportClaudeResolvedModel', () => {
    function client(initial: Record<string, unknown> = {}) {
        let metadata: any = initial
        const update = vi.fn((handler: (m: any) => any) => { metadata = handler(metadata) })
        return { getMetadata: () => metadata, updateMetadata: update, current: () => metadata }
    }

    it('stores the selection with what it resolved to; Default is null', () => {
        const c = client({ path: '/x' })
        reportClaudeResolvedModel(c, 'default', 'claude-opus-5-5')
        expect(c.current()).toEqual({ path: '/x', claudeResolvedModel: { selected: null, model: 'claude-opus-5-5' } })
    })

    it('skips the write when nothing changed, and ignores a missing model', () => {
        const c = client({ claudeResolvedModel: { selected: 'haiku', model: 'claude-haiku-5-5' } })
        reportClaudeResolvedModel(c, 'haiku', 'claude-haiku-5-5')
        reportClaudeResolvedModel(c, 'haiku', undefined)
        expect(c.updateMetadata).not.toHaveBeenCalled()
    })
})
