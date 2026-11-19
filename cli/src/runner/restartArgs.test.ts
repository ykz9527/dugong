import { describe, expect, it } from 'vitest'
import { runnerRestartArgs } from './restartArgs'

describe('runnerRestartArgs', () => {
    it('keeps the running runner\'s workspace roots', () => {
        expect(runnerRestartArgs(['runner', 'start-sync', '--workspace-root', '/home/a', '--workspace-root=/srv/b', '--other']))
            .toEqual(['runner', 'start-sync', '--workspace-root', '/home/a', '--workspace-root=/srv/b'])
    })

    it('starts a bare runner when nothing was recorded', () => {
        expect(runnerRestartArgs(undefined)).toEqual(['runner', 'start-sync'])
    })
})
