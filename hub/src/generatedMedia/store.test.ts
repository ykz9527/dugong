import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGeneratedMedia, saveGeneratedMedia } from './store'

const homes: string[] = []
function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'generated-media-'))
    homes.push(home)
    return home
}

afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('generated media store', () => {
    it('keeps a copy per namespace and reads it back', async () => {
        const home = makeHome()
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
        expect(await saveGeneratedMedia(home, 'default', 'img-1', { bytes: png, mimeType: 'image/png', fileName: 'shot.png' })).toBe(true)

        expect(await readGeneratedMedia(home, 'default', 'img-1')).toEqual({ bytes: png, mimeType: 'image/png', fileName: 'shot.png' })
        expect(await readGeneratedMedia(home, 'other', 'img-1')).toBeNull()
    })

    it('refuses ids that could leave the directory and types that are not media', async () => {
        const home = makeHome()
        const bytes = Buffer.from('x')
        expect(await saveGeneratedMedia(home, 'default', '../escape', { bytes, mimeType: 'image/png', fileName: 'a' })).toBe(false)
        expect(await saveGeneratedMedia(home, 'default', 'page', { bytes, mimeType: 'text/html', fileName: 'a' })).toBe(false)
        expect(await readGeneratedMedia(home, 'default', '../escape')).toBeNull()
    })

    it('drops the oldest items once over the size cap', async () => {
        const home = makeHome()
        const item = (fill: number) => ({ bytes: Buffer.alloc(40, fill), mimeType: 'image/png', fileName: 'a.png' })
        await saveGeneratedMedia(home, 'default', 'old', item(1), 100)
        // Make the first item clearly older than the next ones.
        utimesSync(join(home, 'generated-media', 'default', 'old.bin'), new Date(1_000), new Date(1_000))
        await saveGeneratedMedia(home, 'default', 'mid', item(2), 100)
        await saveGeneratedMedia(home, 'default', 'new', item(3), 100)

        expect(await readGeneratedMedia(home, 'default', 'old')).toBeNull()
        expect(await readGeneratedMedia(home, 'default', 'mid')).not.toBeNull()
        expect(await readGeneratedMedia(home, 'default', 'new')).not.toBeNull()
    })
})
