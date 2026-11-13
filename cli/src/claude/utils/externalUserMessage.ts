import type { RawJSONLines } from '@/claude/types'

/**
 * XML tags that Claude Code injects as `type:'user'` messages.
 * These are internal bookkeeping, not text the human actually typed.
 */
const SYSTEM_INJECTION_PREFIXES = [
    '<task-notification>',
    '<command-name>',
    '<local-command-caveat>',
    '<system-reminder>',
]

export function extractRawUserTextContent(content: unknown): string | null {
    if (typeof content === 'string') {
        return content
    }

    if (!Array.isArray(content)) {
        return null
    }

    const parts = content
        .map((block) => {
            if (!block || typeof block !== 'object' || Array.isArray(block)) return null
            const record = block as Record<string, unknown>
            return record.type === 'text' && typeof record.text === 'string'
                ? record.text
                : null
        })
        .filter((text): text is string => text !== null)

    return parts.length > 0 ? parts.join('\n') : null
}

/**
 * Returns true if a JSONL message should be classified as a user-role message
 * (i.e., text typed by a real human) rather than an agent-role message.
 *
 * Claude Code injects system messages (task notifications, command caveats, …)
 * into the JSONL log as `type:'user'` entries so the model sees them in
 * context.  All metadata fields (`userType`, `isMeta`, …) are identical to
 * genuine user messages, so the only reliable signal is the message content
 * itself: injected messages always start with a well-known XML tag.
 *
 * Lives here rather than next to the live socket client because the import
 * path (`modules/common/claudeSessions`) has to classify the very same rows
 * offline, and a second copy of this list would drift the day Claude Code
 * adds a tag.
 */
export function isExternalUserMessage(body: RawJSONLines): body is Extract<RawJSONLines, { type: 'user' }> {
    if (body.type !== 'user') return false
    // Defensive: a malformed/minimal user line may lack `.message`. Treat it as
    // a non-external (forwardable) message rather than throwing.
    const message = (body as { message?: { content?: unknown } }).message
    if (!message || typeof message !== 'object') return false
    const text = extractRawUserTextContent(message.content)
    if (text === null) return false
    if (body.isSidechain === true) return false
    if (body.isMeta === true) return false

    const trimmed = text.trimStart()
    for (const prefix of SYSTEM_INJECTION_PREFIXES) {
        if (trimmed.startsWith(prefix)) return false
    }
    return true
}
