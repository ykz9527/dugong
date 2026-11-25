/**
 * The size cap every stored agent message is held to.
 *
 * Shared because both ends apply it: the hub at ingest, and the machine before
 * it ships an imported transcript, so a page of history is measured in the
 * bytes that will actually be stored rather than in raw tool output.
 */

/** Per-string cap inside agent message content. Tool results above this are
 *  head+tail truncated at ingest — a single file read or build log can otherwise
 *  persist megabytes that no client ever renders in full. */
export const TRUNCATE_STRING_LIMIT = 64 * 1024
const TRUNCATE_HEAD = 48 * 1024
const TRUNCATE_TAIL = 12 * 1024

function truncateString(value: string): string {
    const removed = value.length - TRUNCATE_HEAD - TRUNCATE_TAIL
    // head + tail + marker stays well under TRUNCATE_STRING_LIMIT so the
    // function is idempotent — codexDesktop compares stored rows against
    // freshly-normalized transcripts and must get identical strings on both sides.
    return `${value.slice(0, TRUNCATE_HEAD)}\n…[hapi: truncated ${removed} chars]…\n${value.slice(value.length - TRUNCATE_TAIL)}`
}

/** Returns the same reference when nothing was truncated so callers can use
 *  identity to detect change. */
function truncateDeep(value: unknown): unknown {
    if (typeof value === 'string') {
        return value.length > TRUNCATE_STRING_LIMIT ? truncateString(value) : value
    }
    if (Array.isArray(value)) {
        let copy: unknown[] | null = null
        for (let i = 0; i < value.length; i++) {
            const item = truncateDeep(value[i])
            if (item !== value[i]) {
                copy ??= value.slice()
                copy[i] = item
            }
        }
        return copy ?? value
    }
    if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>
        let copy: Record<string, unknown> | null = null
        for (const key of Object.keys(record)) {
            const item = truncateDeep(record[key])
            if (item !== record[key]) {
                copy ??= { ...record }
                copy[key] = item
            }
        }
        return copy ?? value
    }
    return value
}

/** Truncate oversized strings inside agent-role message content.
 *
 *  Only role === 'agent' envelopes are touched: user messages are queued in the
 *  DB and later *delivered* to the CLI verbatim (getMatureScheduledMessages /
 *  getDeliverableMessagesAfter), so truncating them would corrupt real prompts,
 *  not just display history. Idempotent: re-applying to already-truncated
 *  content returns the same reference. */
export function truncateOversizedMessageContent(content: unknown): unknown {
    if (content === null || typeof content !== 'object') return content
    if ((content as Record<string, unknown>).role !== 'agent') return content
    return truncateDeep(content)
}
