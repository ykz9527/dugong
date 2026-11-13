import { describe, expect, it } from 'bun:test'
import type { Session } from '../sync/syncEngine'
import type { StoredWorkspaceUser } from '../store/types'
import { selectTargetsInScope, sessionPaths, sessionTargetScope } from './notificationScope'

function makeUser(id: string, paths: string[]): StoredWorkspaceUser {
    return { id, namespace: 'default', name: id, paths, createdAt: 0, updatedAt: 0 }
}

const alice = makeUser('alice', ['/home/alice'])
const bob = makeUser('bob', ['/home/bob'])

describe('sessionPaths', () => {
    it('reports the checkout and the repo it came from', () => {
        const session = {
            metadata: {
                path: '/home/alice/repo-worktrees/0903',
                worktree: { basePath: '/home/alice/repo', branch: 'b', name: 'n' }
            }
        } as unknown as Session

        expect(sessionPaths(session)).toEqual(['/home/alice/repo-worktrees/0903', '/home/alice/repo'])
    })

    it('is empty for a session that never reported a directory', () => {
        expect(sessionPaths({} as Session)).toEqual([])
    })
})

describe('selectTargetsInScope', () => {
    const users = [alice, bob]

    it('drops a device paired to somebody who does not own the work', () => {
        const targets = [
            { id: 'alice-phone', workspaceUserId: 'alice' },
            { id: 'bob-phone', workspaceUserId: 'bob' }
        ]

        expect(selectTargetsInScope(targets, users, ['/home/bob/repo']).map((t) => t.id))
            .toEqual(['bob-phone'])
    })

    it('keeps a device that claims nobody — an unscoped target made no claim to honour', () => {
        const targets = [
            { id: 'legacy', workspaceUserId: null },
            { id: 'bob-phone', workspaceUserId: 'bob' }
        ]

        expect(selectTargetsInScope(targets, users, ['/home/alice/repo']).map((t) => t.id))
            .toEqual(['legacy'])
    })

    it('keeps everything when the session reported no directory', () => {
        const targets = [{ id: 'bob-phone', workspaceUserId: 'bob' }]

        expect(selectTargetsInScope(targets, users, []).map((t) => t.id)).toEqual(['bob-phone'])
        expect(selectTargetsInScope(targets, users, undefined).map((t) => t.id)).toEqual(['bob-phone'])
    })

    it('mutes a device whose workspace user was deleted rather than opening the firehose', () => {
        const targets = [{ id: 'ghost-phone', workspaceUserId: 'deleted-user' }]

        expect(selectTargetsInScope(targets, users, ['/home/alice/repo'])).toEqual([])
    })

    it('matches a worktree checkout through the repo it was forked from', () => {
        const targets = [{ id: 'alice-phone', workspaceUserId: 'alice' }]

        expect(selectTargetsInScope(
            targets,
            users,
            ['/srv/shared-worktrees/0903', '/home/alice/repo']
        ).map((t) => t.id)).toEqual(['alice-phone'])
    })
})

describe('task assistant sessions', () => {
    it('go to the assistant\'s person, not to whoever owns its directory', () => {
        const session = {
            metadata: { path: '/home/svc/.dugong/assistant/alice', host: 'h', role: 'assistant', workspaceUserId: 'alice' }
        } as unknown as Session
        const scope = sessionTargetScope(session)
        expect(scope).toEqual({ workspaceUserId: 'alice' })

        const targets = [
            { id: 'alice-phone', workspaceUserId: 'alice' },
            { id: 'bob-phone', workspaceUserId: 'bob' },
            { id: 'legacy', workspaceUserId: null }
        ]
        expect(selectTargetsInScope(targets, [alice, bob], scope).map((t) => t.id))
            .toEqual(['alice-phone', 'legacy'])
    })

    it('leave ordinary sessions on directory ownership', () => {
        const session = { metadata: { path: '/home/bob/repo', host: 'h' } } as unknown as Session
        expect(sessionTargetScope(session)).toEqual(['/home/bob/repo'])
    })
})
