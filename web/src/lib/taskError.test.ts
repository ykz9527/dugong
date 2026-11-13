import { describe, expect, it } from 'vitest'
import { formatTaskError } from './taskError'

const t = (key: string) => ({
    'board.error.run.interrupted': '这次运行被打断了',
    'board.error.run.promptUndelivered': 'agent 没收到任务',
}[key] ?? key)

describe('formatTaskError', () => {
    it('localises errors the hub authored', () => {
        expect(formatTaskError('hapi:run.interrupted', t)).toBe('这次运行被打断了')
    })

    it('appends the detail a coded error carries', () => {
        expect(formatTaskError('hapi:run.promptUndelivered|socket hung up', t))
            .toBe('agent 没收到任务（socket hung up）')
    })

    it('passes agent and git output through untouched', () => {
        // Translating this would destroy the string the operator needs to search for.
        expect(formatTaskError('protected branch hook declined', t))
            .toBe('protected branch hook declined')
        expect(formatTaskError('runner offline', t)).toBe('runner offline')
    })

    it('leaves an unknown hapi: code alone rather than showing a raw key', () => {
        expect(formatTaskError('hapi:something.new', t)).toBe('hapi:something.new')
    })

    it('returns null for no error', () => {
        expect(formatTaskError(null, t)).toBeNull()
        expect(formatTaskError('', t)).toBeNull()
    })
})
