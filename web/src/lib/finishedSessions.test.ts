import { describe, expect, it } from 'vitest'
import type { Task } from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'
import {
    collectFinishedTaskSessionIds,
    isFinishedSession,
    partitionFinishedSessions
} from './finishedSessions'

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        namespace: 'default',
        title: 'Fix the parser',
        prompt: 'Fix it.',
        column: 'running',
        machineId: 'box-1',
        workdir: '/srv/repo',
        isolation: 'worktree',
        worktreeName: null,
        baseRef: null,
        branch: null,
        worktreePath: null,
        spawn: { flavor: 'claude' },
        currentSessionId: null,
        lastRunId: null,
        lastRunStatus: null,
        lastError: null,
        pullRequest: null,
        archivedAt: null,
        createdAt: 1,
        updatedAt: 1,
        seq: 0,
        ...overrides
    }
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: 'sess-1',
        active: false,
        thinking: false,
        activeAt: 1,
        updatedAt: 1,
        metadata: { path: '/srv/repo' },
        metadataVersion: 1,
        ...overrides
    } as SessionSummary
}

describe('collectFinishedTaskSessionIds', () => {
    it('collects done and archived cards, and nothing else', () => {
        const ids = collectFinishedTaskSessionIds([
            makeTask({ id: 'a', column: 'done', currentSessionId: 'sess-done' }),
            makeTask({ id: 'b', column: 'review', archivedAt: 5, currentSessionId: 'sess-archived' }),
            makeTask({ id: 'c', column: 'review', currentSessionId: 'sess-review' }),
            makeTask({ id: 'd', column: 'running', currentSessionId: 'sess-running' })
        ])

        expect([...ids].sort()).toEqual(['sess-archived', 'sess-done'])
    })

    it('skips cards that never ran', () => {
        expect(collectFinishedTaskSessionIds([makeTask({ column: 'done' })]).size).toBe(0)
    })
})

describe('isFinishedSession', () => {
    const done = new Set(['sess-done'])

    it('hides a session archived from its own menu', () => {
        const session = makeSession({ metadata: { path: '/srv', lifecycleState: 'archived' } })
        expect(isFinishedSession(session, new Set())).toBe(true)
    })

    it('hides the session of a done card', () => {
        expect(isFinishedSession(makeSession({ id: 'sess-done' }), done)).toBe(true)
    })

    it('keeps a session that is still connected', () => {
        expect(isFinishedSession(makeSession({ id: 'sess-done', active: true }), done)).toBe(false)
    })

    it('keeps a pinned session', () => {
        expect(isFinishedSession(makeSession({ id: 'sess-done', pinned: true }), done)).toBe(false)
        expect(isFinishedSession(makeSession({ id: 'sess-done', globalPinned: true }), done)).toBe(false)
    })

    it('keeps an ordinary finished-looking session that no card claims', () => {
        expect(isFinishedSession(makeSession({ id: 'sess-other' }), done)).toBe(false)
    })
})

describe('partitionFinishedSessions', () => {
    it('reports how many rows it held back', () => {
        const { visible, hiddenCount } = partitionFinishedSessions(
            [
                makeSession({ id: 'sess-done' }),
                makeSession({ id: 'sess-live', active: true }),
                makeSession({ id: 'sess-other' })
            ],
            new Set(['sess-done'])
        )

        expect(visible.map((session) => session.id)).toEqual(['sess-live', 'sess-other'])
        expect(hiddenCount).toBe(1)
    })

    it('never hides the session being read', () => {
        const { visible, hiddenCount } = partitionFinishedSessions(
            [makeSession({ id: 'sess-done' })],
            new Set(['sess-done']),
            'sess-done'
        )

        expect(visible.map((session) => session.id)).toEqual(['sess-done'])
        expect(hiddenCount).toBe(0)
    })
})
