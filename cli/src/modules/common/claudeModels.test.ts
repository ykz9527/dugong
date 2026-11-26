import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetClaudeModelsCacheForTests, listClaudeModels } from './claudeModels'

const OPUS = { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportsEffort: true }

describe('listClaudeModels', () => {
    afterEach(() => {
        _resetClaudeModelsCacheForTests()
        vi.useRealTimers()
    })

    it('keeps value, resolved id and name; drops entries without a value', async () => {
        const models = await listClaudeModels(async () => [OPUS, { displayName: 'no value' }, null])
        expect(models).toEqual([{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' }])
    })

    it('starts Claude Code once for concurrent asks and answers from cache after', async () => {
        const probe = vi.fn(async () => [OPUS])
        await Promise.all([listClaudeModels(probe), listClaudeModels(probe)])
        await listClaudeModels(probe)
        expect(probe).toHaveBeenCalledTimes(1)
    })

    it('after 5 minutes answers with the old list at once and refreshes behind it', async () => {
        vi.useFakeTimers()
        await listClaudeModels(async () => [OPUS])
        vi.advanceTimersByTime(5 * 60_000 + 1)
        let release!: (value: unknown[]) => void
        const probe = vi.fn(() => new Promise<unknown[]>((resolve) => { release = resolve }))
        expect((await listClaudeModels(probe))[0]?.displayName).toBe('Opus 5.5')
        expect(probe).toHaveBeenCalledTimes(1)
        release([{ ...OPUS, displayName: 'Opus 5.6' }])
        await vi.waitFor(async () => {
            expect((await listClaudeModels(probe))[0]?.displayName).toBe('Opus 5.6')
        })
    })
})
