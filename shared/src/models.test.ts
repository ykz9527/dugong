import { describe, expect, test } from 'bun:test'
import {
    CLAUDE_MODEL_PRESETS,
    CLAUDE_MODEL_LABELS,
    DEFAULT_GEMINI_MODEL,
    GEMINI_MODEL_LABELS,
    GEMINI_MODEL_PRESETS,
    getClaudeContextWindowTokens,
    getClaudeModelLabel,
    isClaudeModelPreset,
} from './models'

describe('isClaudeModelPreset', () => {
    test('accepts valid presets', () => {
        for (const preset of CLAUDE_MODEL_PRESETS) {
            expect(isClaudeModelPreset(preset)).toBe(true)
        }
    })

    test('rejects unknown model string', () => {
        expect(isClaudeModelPreset('claude-haiku-5-5')).toBe(false)
    })

    test('rejects null and undefined', () => {
        expect(isClaudeModelPreset(null)).toBe(false)
        expect(isClaudeModelPreset(undefined)).toBe(false)
    })
})

describe('getClaudeModelLabel', () => {
    test('returns label for known presets', () => {
        expect(getClaudeModelLabel('sonnet')).toBe('Sonnet')
        expect(getClaudeModelLabel('opus')).toBe('Opus')
        expect(getClaudeModelLabel('opus[1m]')).toBe('Opus 1M')
    })

    test('trims whitespace before lookup', () => {
        expect(getClaudeModelLabel('  sonnet  ')).toBe('Sonnet')
    })

    test('returns null for unknown model', () => {
        expect(getClaudeModelLabel('claude-haiku-5-5')).toBeNull()
    })

    test('returns null for empty/whitespace-only string', () => {
        expect(getClaudeModelLabel('')).toBeNull()
        expect(getClaudeModelLabel('   ')).toBeNull()
    })
})

describe('model constants consistency', () => {
    test('every CLAUDE_MODEL_PRESET has a label', () => {
        for (const preset of CLAUDE_MODEL_PRESETS) {
            expect(CLAUDE_MODEL_LABELS[preset]).toBeDefined()
        }
    })

    test('every GEMINI_MODEL_PRESET has a label', () => {
        for (const preset of GEMINI_MODEL_PRESETS) {
            expect(GEMINI_MODEL_LABELS[preset]).toBeDefined()
        }
    })

    test('DEFAULT_GEMINI_MODEL is a valid preset', () => {
        expect(GEMINI_MODEL_PRESETS).toContain(DEFAULT_GEMINI_MODEL)
    })
})

describe('getClaudeContextWindowTokens', () => {
    test('current-generation ids and aliases are 1M', () => {
        for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-mythos-5-2', 'opus', 'sonnet', 'fable', 'haiku']) {
            expect(getClaudeContextWindowTokens(id)).toBe(1_000_000)
        }
    })

    test('older ids are 200k unless they carry [1m]', () => {
        expect(getClaudeContextWindowTokens('claude-haiku-4-5')).toBe(200_000)
        expect(getClaudeContextWindowTokens('claude-sonnet-4-6')).toBe(200_000)
        expect(getClaudeContextWindowTokens('claude-3-5-sonnet-20241022')).toBe(200_000)
        expect(getClaudeContextWindowTokens('claude-opus-4-8[1m]')).toBe(1_000_000)
        expect(getClaudeContextWindowTokens('opus[1m]')).toBe(1_000_000)
    })

    test('non-Claude or empty ids are unknown', () => {
        expect(getClaudeContextWindowTokens('gpt-5.4')).toBeNull()
        expect(getClaudeContextWindowTokens('<synthetic>')).toBeNull()
        expect(getClaudeContextWindowTokens('')).toBeNull()
        expect(getClaudeContextWindowTokens(null)).toBeNull()
    })
})
