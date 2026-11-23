import { describe, expect, it } from 'vitest'
import { getContextBudgetTokens } from './modelConfig'

describe('getContextBudgetTokens', () => {
    it('uses the large budget only for explicit 1m Claude presets', () => {
        expect(getContextBudgetTokens('sonnet[1m]', 'claude')).toBe(990_000)
    })

    it('uses the default Claude budget for pre-5 Claude model names', () => {
        expect(getContextBudgetTokens('claude-sonnet-4-6', 'claude')).toBe(190_000)
        expect(getContextBudgetTokens('claude-haiku-4-5', 'claude')).toBe(190_000)
    })

    it('uses the large budget for current-generation Claude ids without a [1m] suffix', () => {
        // SDK results report modelUsage[id].contextWindow = 1,000,000 for all of these.
        expect(getContextBudgetTokens('claude-opus-5-5', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('claude-sonnet-5-5', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('claude-haiku-5-5', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('opus', 'claude')).toBe(990_000)
    })

    it('falls back to the default Claude budget when the model is unknown', () => {
        expect(getContextBudgetTokens(null, 'claude')).toBe(190_000)
        expect(getContextBudgetTokens('<synthetic>', 'claude')).toBeNull()
    })

    it('uses the large budget for a full Claude model name carrying a [1m] suffix', () => {
        expect(getContextBudgetTokens('claude-opus-4-8[1m]', 'claude')).toBe(990_000)
    })

    it('uses the large budget for Fable even under its bare id (1M window)', () => {
        expect(getContextBudgetTokens('claude-fable-5', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('fable', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('fable[1m]', 'claude')).toBe(990_000)
    })

    it('uses Codex app-server context window with headroom', () => {
        expect(getContextBudgetTokens('gpt-5.4', 'codex')).toBe(248_400)
    })

    it('parses context budget from Cursor wire ids', () => {
        expect(getContextBudgetTokens('composer-2.5-fast[context=300k]', 'cursor')).toBe(290_000)
    })

    it('returns null for unknown non-Claude sessions', () => {
        expect(getContextBudgetTokens('gemini-3-pro', 'gemini')).toBeNull()
    })
})
