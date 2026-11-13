import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

/**
 * A board card must survive its conversation being resumed.
 *
 * Resuming an agent does not reopen its session row: the CLI reports a new id
 * and `mergeSessions` folds the old row into it. `tasks.current_session_id` is
 * an FK with `ON DELETE SET NULL`, so a card left pointing at the old id comes
 * out of that merge with no session at all — no `Open chat`, only `Start`,
 * which resumes the same transcript a second time and leaves two agents on one
 * conversation.
 */

function createCapturingPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

function setup() {
    const store = new Store(':memory:')
    const events: SyncEvent[] = []
    const cache = new SessionCache(store, createCapturingPublisher(events))
    return { store, events, cache }
}

function makeSessions(cache: SessionCache) {
    const oldSession = cache.getOrCreateSession(
        'agent-task-old-' + Math.random().toString(36).slice(2, 8),
        { path: '/repo', host: 'localhost', flavor: 'claude' },
        null,
        'default'
    )
    const newSession = cache.getOrCreateSession(
        'agent-task-new-' + Math.random().toString(36).slice(2, 8),
        { path: '/repo', host: 'localhost', flavor: 'claude' },
        null,
        'default'
    )
    return { oldSession, newSession }
}

describe('mergeSessions - board pointers', () => {
    it('moves the card onto the surviving session', async () => {
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        const task = store.tasks.create({
            namespace: 'default',
            title: 'taxonomy',
            prompt: 'keep going',
            workdir: '/repo',
            isolation: 'simple',
            spawn: { flavor: 'claude', adoptedSessionId: oldSession.id, adoptedNativeSessionId: 'native-1' }
        })
        const started = store.tasks.startRun({
            taskId: task.id, namespace: 'default', origin: 'user', sessionId: oldSession.id
        })
        if (started.outcome !== 'started') throw new Error('expected a started run')

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const merged = store.tasks.get(task.id)
        expect(merged?.currentSessionId).toBe(newSession.id)
        expect(merged?.spawn).toEqual({
            flavor: 'claude',
            adoptedSessionId: newSession.id,
            adoptedNativeSessionId: 'native-1'
        })
        expect(store.tasks.getRun(started.run.id)?.sessionId).toBe(newSession.id)
        // The run is still open: the agent never stopped, it only changed id.
        expect(store.tasks.getActiveRunBySession(newSession.id)?.id).toBe(started.run.id)
    })

    it('says the session was merged rather than removed', async () => {
        const { events, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const removed = events.find(
            (event): event is Extract<SyncEvent, { type: 'session-removed' }> =>
                event.type === 'session-removed' && event.sessionId === oldSession.id
        )
        expect(removed?.mergedInto).toBe(newSession.id)
    })

    it('leaves the card alone when the old session stays alive', async () => {
        // `mergeSessionHistory` keeps both rows, so both pointers stay valid.
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        const task = store.tasks.create({
            namespace: 'default',
            title: 'taxonomy',
            prompt: 'keep going',
            workdir: '/repo',
            spawn: { flavor: 'claude' }
        })
        store.tasks.startRun({
            taskId: task.id, namespace: 'default', origin: 'user', sessionId: oldSession.id
        })

        await cache.mergeSessionHistory(oldSession.id, newSession.id, 'default')

        expect(store.tasks.get(task.id)?.currentSessionId).toBe(oldSession.id)
    })
})
