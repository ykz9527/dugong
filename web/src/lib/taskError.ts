import { decodeTaskError } from '@hapi/protocol'

/**
 * Turn a task's `lastError` into something worth showing.
 *
 * Two sources land in that field. Messages the hub authored carry a `hapi:`
 * code and get localised; everything else is raw output from the agent, git or
 * the runner and is shown exactly as received — a translated `protected branch
 * hook declined` would be worse than useless when you go looking for it.
 */
export function formatTaskError(
    raw: string | null | undefined,
    t: (key: string, params?: Record<string, string | number>) => string
): string | null {
    if (!raw) return null

    const decoded = decodeTaskError(raw)
    if (!decoded) return raw

    const message = t(`board.error.${decoded.code}`)
    return decoded.detail ? `${message}（${decoded.detail}）` : message
}
