import { describe, expect, it } from 'vitest'
import { parseSideQuestion } from './SideQuestionPanel'

describe('parseSideQuestion', () => {
    it('extracts the question', () => {
        expect(parseSideQuestion('/btw why is the sky blue?')).toBe('why is the sky blue?')
        expect(parseSideQuestion('  /btw  multi\nline  ')).toBe('multi\nline')
    })

    it('returns empty string for a bare /btw', () => {
        expect(parseSideQuestion('/btw')).toBe('')
    })

    it('ignores other text', () => {
        expect(parseSideQuestion('/btwx hi')).toBeNull()
        expect(parseSideQuestion('hey /btw hi')).toBeNull()
        expect(parseSideQuestion('/clear')).toBeNull()
    })
})
