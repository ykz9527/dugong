import { describe, expect, it } from 'vitest'
import { canGoUp, narrowRootsToUser } from './DirectoryPicker'

describe('narrowRootsToUser', () => {
    it('keeps the machine roots when nobody is selected', () => {
        expect(narrowRootsToUser(['/home/dev'], [])).toEqual(['/home/dev'])
    })

    it('browses the user directories instead of the machine roots', () => {
        expect(narrowRootsToUser(['/home/dev'], ['/home/dev/ytest', '/home/dev/projects/app']))
            .toEqual(['/home/dev/ytest', '/home/dev/projects/app'])
    })

    it('drops user directories the runner would refuse', () => {
        expect(narrowRootsToUser(['/home/dev/ytest'], ['/home/dev/ytest/a', '/srv/other']))
            .toEqual(['/home/dev/ytest/a'])
    })

    it('falls back to the machine roots when none of the user directories are reachable', () => {
        expect(narrowRootsToUser(['/home/dev/ytest'], ['/srv/other'])).toEqual(['/home/dev/ytest'])
    })

    it('stops the picker from climbing above a user directory', () => {
        const roots = narrowRootsToUser(['/home/dev'], ['/home/dev/ytest'])
        expect(canGoUp('/home/dev/ytest', roots)).toBe(false)
        expect(canGoUp('/home/dev/ytest/proj', roots)).toBe(true)
    })
})
