import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MAX_GENERATED_IMAGE_BYTES } from '../socket/socketLimits'

/**
 * The hub's own copy of media an agent generated (images, short clips).
 *
 * The CLI keeps generated media in process memory only, so once the session
 * process restarts, evicts it, or the session goes inactive, every reference
 * in the transcript turned into a broken image. The CLI now pushes each item
 * here when it is made, and the image route stores whatever it still has to
 * fetch from the CLI, so the transcript keeps its pictures.
 */

// Ids are random tokens minted by the CLI; anything else is never stored.
const MEDIA_ID = /^[A-Za-z0-9_-]{1,128}$/
const MEDIA_MIME_TYPE = /^(?:(?:image|video|audio)\/[A-Za-z0-9.+-]+|application\/octet-stream)$/
// A cache of what the CLI made, not an archive: keep the newest within this.
export const GENERATED_MEDIA_MAX_TOTAL_BYTES = 512 * 1024 * 1024

export type GeneratedMedia = {
    bytes: Buffer
    mimeType: string
    fileName: string
}

export function isStorableGeneratedMedia(id: string, mimeType: string, size: number): boolean {
    return MEDIA_ID.test(id) && MEDIA_MIME_TYPE.test(mimeType) && size <= MAX_GENERATED_IMAGE_BYTES
}

function mediaDir(home: string, namespace: string): string {
    const segment = namespace.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'default'
    return join(home, 'generated-media', segment)
}

export async function readGeneratedMedia(home: string, namespace: string, id: string): Promise<GeneratedMedia | null> {
    if (!MEDIA_ID.test(id)) return null
    const dir = mediaDir(home, namespace)
    try {
        const [meta, bytes] = await Promise.all([
            readFile(join(dir, `${id}.json`), 'utf8'),
            readFile(join(dir, `${id}.bin`))
        ])
        const parsed = JSON.parse(meta) as { mimeType?: unknown; fileName?: unknown }
        if (typeof parsed.mimeType !== 'string' || typeof parsed.fileName !== 'string') return null
        return { bytes, mimeType: parsed.mimeType, fileName: parsed.fileName }
    } catch {
        return null
    }
}

export async function saveGeneratedMedia(
    home: string,
    namespace: string,
    id: string,
    media: GeneratedMedia,
    maxTotalBytes: number = GENERATED_MEDIA_MAX_TOTAL_BYTES
): Promise<boolean> {
    if (!isStorableGeneratedMedia(id, media.mimeType, media.bytes.byteLength)) return false
    const dir = mediaDir(home, namespace)
    await mkdir(dir, { recursive: true })
    const temp = join(dir, `.${id}.${randomUUID()}.tmp`)
    await writeFile(temp, media.bytes)
    await rename(temp, join(dir, `${id}.bin`))
    // Written last: a reader only trusts an item once its metadata exists.
    await writeFile(join(dir, `${id}.json`), JSON.stringify({
        mimeType: media.mimeType,
        fileName: media.fileName.slice(0, 255)
    }))
    await pruneGeneratedMedia(dir, maxTotalBytes)
    return true
}

/** Drop the oldest items until the directory fits in `maxTotalBytes`. */
async function pruneGeneratedMedia(dir: string, maxTotalBytes: number): Promise<void> {
    const items: Array<{ id: string; size: number; mtimeMs: number }> = []
    for (const name of await readdir(dir)) {
        if (!name.endsWith('.bin')) continue
        try {
            const info = await stat(join(dir, name))
            items.push({ id: name.slice(0, -4), size: info.size, mtimeMs: info.mtimeMs })
        } catch {
            // Removed concurrently; nothing to count.
        }
    }
    let total = items.reduce((sum, item) => sum + item.size, 0)
    if (total <= maxTotalBytes) return
    items.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const item of items) {
        if (total <= maxTotalBytes) break
        await rm(join(dir, `${item.id}.json`), { force: true })
        await rm(join(dir, `${item.id}.bin`), { force: true })
        total -= item.size
    }
}
