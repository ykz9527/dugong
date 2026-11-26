import { describe, expect, it } from 'vitest'
import { getClaudeComposerModelOptions, getClaudeResolvedModel, getNextClaudeComposerModel } from './claudeModelOptions'

describe('getClaudeComposerModelOptions', () => {
    it('includes the active non-preset Claude model in the options list', () => {
        expect(getClaudeComposerModelOptions('claude-opus-4-1-20250805')).toEqual([
            { value: null, label: 'Default' },
            { value: 'claude-opus-4-1-20250805', label: 'claude-opus-4-1-20250805' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'sonnet[1m]', label: 'Sonnet 1M' },
            { value: 'opus', label: 'Opus' },
            { value: 'opus[1m]', label: 'Opus 1M' },
            { value: 'fable', label: 'Fable' },
            { value: 'fable[1m]', label: 'Fable 1M' },
            { value: 'haiku', label: 'Haiku' },
        ])
    })

    it('does not duplicate preset Claude models', () => {
        expect(getClaudeComposerModelOptions('opus')).toEqual([
            { value: null, label: 'Default' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'sonnet[1m]', label: 'Sonnet 1M' },
            { value: 'opus', label: 'Opus' },
            { value: 'opus[1m]', label: 'Opus 1M' },
            { value: 'fable', label: 'Fable' },
            { value: 'fable[1m]', label: 'Fable 1M' },
            { value: 'haiku', label: 'Haiku' },
        ])
    })
})

describe('getNextClaudeComposerModel', () => {
    it('cycles from a non-preset Claude model to the next selectable model instead of auto', () => {
        expect(getNextClaudeComposerModel('claude-opus-4-1-20250805')).toBe('sonnet')
    })
})

describe('getClaudeResolvedModel', () => {
    const metadata = { claudeResolvedModel: { selected: null, model: 'claude-opus-5-5' } }

    it('answers the selection it was reported for; Default matches null and "default"', () => {
        expect(getClaudeResolvedModel(metadata, null)).toBe('claude-opus-5-5')
        expect(getClaudeResolvedModel(metadata, 'default')).toBe('claude-opus-5-5')
    })

    it('stays empty for another selection or before any report', () => {
        expect(getClaudeResolvedModel(metadata, 'sonnet')).toBeNull()
        expect(getClaudeResolvedModel({}, null)).toBeNull()
        expect(getClaudeResolvedModel(null, null)).toBeNull()
    })
})

describe('Claude options named from Claude Code\'s model list', () => {
    // What Claude Code 2.1.332 lists on 37.1, where availableModels is sonnet/opus/haiku.
    const catalog = [
        { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)' },
        { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },
        { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5' },
        { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8' }
    ]

    it('names each choice by version, 1M after its base, and marks aliases the machine lacks', () => {
        expect(getClaudeComposerModelOptions(null, catalog)).toEqual([
            { value: null, label: 'Default · Opus 5.5', resolvedModel: 'claude-opus-5-5' },
            { value: 'sonnet', label: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5' },
            { value: 'sonnet[1m]', label: 'Sonnet 5.5 1M', resolvedModel: 'claude-sonnet-5-5' },
            { value: 'opus', label: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
            { value: 'opus[1m]', label: 'Opus 5.5 1M', resolvedModel: 'claude-opus-5-5' },
            { value: 'fable', label: 'Fable', unavailable: true },
            { value: 'fable[1m]', label: 'Fable 1M', unavailable: true },
            { value: 'haiku', label: 'Haiku 5.5', resolvedModel: 'claude-haiku-5-5' },
        ])
    })

    it('names a pinned full id too, and marks nothing when the list names no alias', () => {
        expect(getClaudeComposerModelOptions('claude-opus-4-8', catalog)[1]).toEqual(
            { value: 'claude-opus-4-8', label: 'Opus 4.8', resolvedModel: 'claude-opus-4-8' }
        )
        const fullIdsOnly = [{ value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8' }]
        expect(getClaudeComposerModelOptions(null, fullIdsOnly).some((option) => option.unavailable)).toBe(false)
    })
})

describe('Claude options with an older Claude Code list (2.1.323 on 37.2, no availableModels)', () => {
    const catalog = [
        { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)' },
        { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus' },
        { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable' },
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet' },
        { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku' }
    ]

    it('takes the version from the id when the name has none, and keeps Fable pickable without guessing its version', () => {
        const labels = getClaudeComposerModelOptions(null, catalog).map((option) => [option.label, option.unavailable ?? false])
        expect(labels).toEqual([
            ['Default · Opus 5.5', false],
            ['Sonnet 5.5', false],
            ['Sonnet 5.5 1M', false],
            ['Opus 5.5', false],
            ['Opus 5.5 1M', false],
            // `--model fable` runs claude-fable-5-2 there; the list only names 5.1.
            ['Fable', false],
            ['Fable 1M', false],
            ['Haiku 5.5', false],
        ])
    })
})
