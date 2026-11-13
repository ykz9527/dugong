import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    countProjects,
    filterSessionsInProject,
    getProjectLabel,
    getSessionProjectPath
} from './sessionProject'

function makeSession(id: string, metadata: Partial<NonNullable<SessionSummary['metadata']>> | null): SessionSummary {
    return {
        id,
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: metadata as SessionSummary['metadata'],
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null
    }
}

describe('getSessionProjectPath', () => {
    it('uses the plain path for an ordinary session', () => {
        expect(getSessionProjectPath(makeSession('a', { path: '/srv/repo' }))).toBe('/srv/repo')
    })

    it('resolves a worktree session to the repo it branched from', () => {
        // Board tasks each get their own worktree; without this they would each
        // look like a separate project.
        const session = makeSession('a', {
            path: '/srv/repo-worktrees/0821-abcd',
            worktree: { basePath: '/srv/repo', branch: 'hapi-0821-abcd', name: '0821-abcd' }
        })
        expect(getSessionProjectPath(session)).toBe('/srv/repo')
    })

    it('returns null when there is no path at all', () => {
        expect(getSessionProjectPath(makeSession('a', null))).toBeNull()
    })
})

describe('getProjectLabel', () => {
    it('names a project by its last path segment', () => {
        expect(getProjectLabel('/home/dev/board-demo')).toBe('board-demo')
        expect(getProjectLabel('/home/dev/board-demo/')).toBe('board-demo')
        expect(getProjectLabel('C:\\work\\repo')).toBe('repo')
    })
})

describe('filterSessionsInProject', () => {
    const repo = makeSession('repo-1', { path: '/srv/repo' })
    const worktree = makeSession('wt-1', {
        path: '/srv/repo-worktrees/0821-abcd',
        worktree: { basePath: '/srv/repo', branch: 'b', name: 'n' }
    })
    const other = makeSession('other-1', { path: '/srv/other' })
    const pathless = makeSession('ghost-1', null)
    const all = [repo, worktree, other, pathless]

    it('keeps the project and its worktrees together', () => {
        const kept = filterSessionsInProject(all, '/srv/repo', 'repo-1').map((s) => s.id)
        expect(kept).toContain('repo-1')
        expect(kept).toContain('wt-1')
        expect(kept).not.toContain('other-1')
    })

    it('never hides the session being read', () => {
        // Selected row wins even though it belongs to a different project —
        // a sidebar that hides your open session is disorienting.
        const kept = filterSessionsInProject(all, '/srv/repo', 'other-1').map((s) => s.id)
        expect(kept).toContain('other-1')
    })

    it('keeps sessions with no resolvable path rather than stranding them', () => {
        expect(filterSessionsInProject(all, '/srv/repo').map((s) => s.id)).toContain('ghost-1')
    })

    it('is a no-op without a project', () => {
        expect(filterSessionsInProject(all, null)).toHaveLength(4)
    })
})

describe('countProjects', () => {
    it('counts a repo and its worktrees once', () => {
        expect(countProjects([
            makeSession('a', { path: '/srv/repo' }),
            makeSession('b', {
                path: '/srv/repo-worktrees/x',
                worktree: { basePath: '/srv/repo', branch: 'b', name: 'x' }
            }),
            makeSession('c', { path: '/srv/other' })
        ])).toBe(2)
    })

    it('ignores sessions with no path', () => {
        expect(countProjects([makeSession('a', null)])).toBe(0)
    })
})
