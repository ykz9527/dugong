import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pruneLogFiles } from './logger'

describe('pruneLogFiles', () => {
    it('removes only .log files older than the retention window', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'dugong-logs-'))
        const now = Date.now()
        const day = 86_400_000
        const write = (name: string, ageDays: number) => {
            const path = join(dir, name)
            writeFileSync(path, 'x')
            const at = (now - ageDays * day) / 1000
            utimesSync(path, at, at)
        }
        write('old.log', 8)
        write('recent.log', 6)
        write('old-state.json', 30)

        expect(await pruneLogFiles(dir, 7 * day, now)).toBe(1)
        expect(readdirSync(dir).sort()).toEqual(['old-state.json', 'recent.log'])
    })

    it('returns 0 for a missing directory', async () => {
        expect(await pruneLogFiles(join(tmpdir(), 'dugong-no-such-dir-xyz'))).toBe(0)
    })
})
