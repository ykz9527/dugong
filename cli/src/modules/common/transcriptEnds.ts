import { open } from 'node:fs/promises'

/**
 * The first and last lines of a JSONL transcript, without reading the middle.
 *
 * A session picker needs a title, a directory and the last thing said, and
 * all three live at the ends of the file. Reading whole transcripts to get
 * them is what made listing slow on a machine with a long history: the forty
 * newest Claude transcripts on one shared box came to 1.5 GB, and parsing
 * them took five seconds per listing.
 *
 * Lines cut by a window edge are dropped, never half-parsed. A window that
 * holds no complete line (one enormous tool result) is widened until it does
 * or `maxBytes` is reached.
 */

export type TranscriptEnds = {
    size: number
    /** True when `head` is the whole file; `tail` is then empty. */
    whole: boolean
    head: string[]
    tail: string[]
}

export type TranscriptEndsOptions = {
    headBytes: number
    tailBytes: number
    /** Ceiling for widening a window that holds no complete line. */
    maxBytes: number
}

export const DEFAULT_TRANSCRIPT_ENDS: TranscriptEndsOptions = {
    headBytes: 256 * 1024,
    tailBytes: 256 * 1024,
    maxBytes: 4 * 1024 * 1024
}

type Handle = Awaited<ReturnType<typeof open>>

async function readRange(handle: Handle, position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length)
    let filled = 0
    while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
        if (bytesRead === 0) break
        filled += bytesRead
    }
    return buffer.subarray(0, filled)
}

function splitLines(text: string): string[] {
    return text.split('\n').filter((line) => line.trim() !== '')
}

async function readHead(handle: Handle, size: number, options: TranscriptEndsOptions): Promise<string[]> {
    for (let length = options.headBytes; ; length *= 4) {
        const window = Math.min(length, size)
        const buffer = await readRange(handle, 0, window)
        const end = buffer.lastIndexOf(0x0a)
        if (end >= 0) return splitLines(buffer.toString('utf-8', 0, end))
        if (window >= size || window >= options.maxBytes) return []
    }
}

async function readTail(handle: Handle, size: number, floor: number, options: TranscriptEndsOptions): Promise<string[]> {
    for (let length = options.tailBytes; ; length *= 4) {
        const start = Math.max(floor, size - length)
        const buffer = await readRange(handle, start, size - start)
        // The first line is cut unless the window starts on a line boundary.
        const begin = start === 0 ? 0 : buffer.indexOf(0x0a) + 1
        if (begin > 0 || start === 0) return splitLines(buffer.toString('utf-8', begin))
        if (start === floor || size - start >= options.maxBytes) return []
    }
}

export async function readTranscriptEnds(
    filePath: string,
    options: TranscriptEndsOptions = DEFAULT_TRANSCRIPT_ENDS
): Promise<TranscriptEnds | null> {
    let handle: Handle
    try {
        handle = await open(filePath, 'r')
    } catch {
        return null
    }
    try {
        const { size } = await handle.stat()
        if (size <= options.headBytes + options.tailBytes) {
            const text = (await readRange(handle, 0, size)).toString('utf-8')
            return { size, whole: true, head: splitLines(text), tail: [] }
        }
        const head = await readHead(handle, size, options)
        // The tail stops at the head window. A head widened past it can share
        // a line with the tail; harmless, as nothing counts rows on a partial
        // read.
        const tail = await readTail(handle, size, options.headBytes, options)
        return { size, whole: false, head, tail }
    } catch {
        return null
    } finally {
        await handle.close().catch(() => undefined)
    }
}
