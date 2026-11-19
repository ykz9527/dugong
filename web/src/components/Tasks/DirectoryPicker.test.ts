import { describe, expect, it } from 'vitest'
import { canGoUp, folderNameProblem } from './DirectoryPicker'

describe('canGoUp', () => {
    it('stops the picker at the runner root', () => {
        expect(canGoUp('/home/dev/ytest', ['/home/dev/ytest'])).toBe(false)
        expect(canGoUp('/home/dev/ytest/proj', ['/home/dev/ytest'])).toBe(true)
    })

    it('never climbs above /', () => {
        expect(canGoUp('/', [])).toBe(false)
    })
})

describe('folderNameProblem', () => {
    it('accepts a plain name', () => {
        expect(folderNameProblem('new-project')).toBeNull()
        expect(folderNameProblem('  padded  ')).toBeNull()
    })

    it('refuses nothing, nesting and the dot names', () => {
        expect(folderNameProblem('')).toBe('empty')
        expect(folderNameProblem('   ')).toBe('empty')
        expect(folderNameProblem('a/b')).toBe('separator')
        expect(folderNameProblem('a\\b')).toBe('separator')
        expect(folderNameProblem('.')).toBe('reserved')
        expect(folderNameProblem('..')).toBe('reserved')
    })
})
