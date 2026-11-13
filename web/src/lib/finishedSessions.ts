import type { Task } from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'

/**
 * Sessions the operator is finished with, and the sidebar's default of hiding
 * them.
 *
 * Three separate things end a session's useful life and all three used to keep
 * a row in the list: the card was moved to Done, the card was archived, or the
 * session itself was archived from its own menu. A list that keeps every one of
 * them is mostly history, and the sessions still being worked on get pushed
 * down out of sight.
 *
 * Hidden rather than deleted, and announced with a count and a toggle: a filter
 * the operator did not set has to say so, or the sessions look lost.
 */

/** Sessions belonging to a card that is done with, live or archived. */
export function collectFinishedTaskSessionIds(tasks: readonly Task[]): Set<string> {
    const ids = new Set<string>()
    for (const task of tasks) {
        if (task.column !== 'done' && task.archivedAt === null) continue
        if (task.currentSessionId) {
            ids.add(task.currentSessionId)
        }
    }
    return ids
}

/**
 * Whether a row is finished business.
 *
 * A connected session is never finished no matter what its card says — an agent
 * that is still running is the one thing the list must not hide. Pinning is an
 * explicit "keep this in front of me", so it outranks the filter too.
 */
export function isFinishedSession(
    session: SessionSummary,
    finishedTaskSessionIds: ReadonlySet<string>
): boolean {
    if (session.active || session.pinned || session.globalPinned) return false
    if (session.metadata?.lifecycleState === 'archived') return true
    return finishedTaskSessionIds.has(session.id)
}

/** Split the list, keeping the open session visible whatever its state — a
 *  filter that closes the conversation being read is a filter that broke. */
export function partitionFinishedSessions(
    sessions: readonly SessionSummary[],
    finishedTaskSessionIds: ReadonlySet<string>,
    selectedSessionId?: string | null
): { visible: SessionSummary[]; hiddenCount: number } {
    const visible: SessionSummary[] = []
    let hiddenCount = 0
    for (const session of sessions) {
        if (session.id !== selectedSessionId && isFinishedSession(session, finishedTaskSessionIds)) {
            hiddenCount += 1
            continue
        }
        visible.push(session)
    }
    return { visible, hiddenCount }
}
