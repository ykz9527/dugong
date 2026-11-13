import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Store } from './index'
import { DELETED_TASK_MARKER } from './tasks'
import type { StoredTask } from './types'

let store: Store

beforeEach(() => {
    store = new Store(':memory:')
})

afterEach(() => {
    store.close()
})

function internalDb(): Database {
    return (store as unknown as { db: Database }).db
}

function makeTask(overrides: Partial<Parameters<Store['tasks']['create']>[0]> = {}): StoredTask {
    return store.tasks.create({
        namespace: 'default',
        title: 'Fix flaky store test',
        prompt: 'Investigate and fix.',
        workdir: '/repo',
        spawn: { flavor: 'claude' },
        ...overrides
    })
}

function makeSession(id: string): void {
    store.sessions.getOrCreateSession(
        id, { path: '/repo', host: 'box' }, null, 'default',
        undefined, undefined, undefined, id
    )
}

describe('task CRUD', () => {
    it('creates a task with backlog/worktree defaults', () => {
        const task = makeTask()
        expect(task.column).toBe('backlog')
        expect(task.isolation).toBe('worktree')
        expect(task.spawn).toEqual({ flavor: 'claude' })
        expect(task.currentSessionId).toBeNull()
        expect(task.lastRunStatus).toBeNull()
        expect(task.seq).toBe(0)
    })

    it('scopes reads to a namespace', () => {
        const mine = makeTask()
        makeTask({ namespace: 'other', title: 'Someone else' })

        expect(store.tasks.list('default')).toHaveLength(1)
        expect(store.tasks.getByNamespace(mine.id, 'other')).toBeNull()
        // The unscoped lookup is the internal carve-out and still resolves.
        expect(store.tasks.get(mine.id)?.id).toBe(mine.id)
    })

    it('hides archived tasks unless asked for them', () => {
        const task = makeTask()
        const archived = store.tasks.archive(task.id, 'default')
        expect(archived?.archivedAt).not.toBeNull()

        expect(store.tasks.list('default')).toHaveLength(0)
        expect(store.tasks.list('default', { includeArchived: true })).toHaveLength(1)

        const restored = store.tasks.unarchive(task.id, 'default')
        expect(restored?.archivedAt).toBeNull()
        expect(store.tasks.list('default')).toHaveLength(1)
    })

    it('archive is a no-op on an already archived task', () => {
        const task = makeTask()
        expect(store.tasks.archive(task.id, 'default')).not.toBeNull()
        expect(store.tasks.archive(task.id, 'default')).toBeNull()
    })

    it('filters by column and machine', () => {
        makeTask({ column: 'review', machineId: 'box-1' })
        makeTask({ column: 'ready', machineId: 'box-2' })

        expect(store.tasks.list('default', { column: 'review' })).toHaveLength(1)
        expect(store.tasks.list('default', { machineId: 'box-2' })).toHaveLength(1)
        expect(store.tasks.list('default', { column: 'done' })).toHaveLength(0)
    })

    it('counts live tasks per column', () => {
        makeTask({ column: 'ready' })
        makeTask({ column: 'ready' })
        const archived = makeTask({ column: 'review' })
        store.tasks.archive(archived.id, 'default')

        expect(store.tasks.countByColumn('default')).toEqual({ ready: 2 })
    })

    it('patches only the supplied fields and bumps seq', () => {
        const task = makeTask()
        const updated = store.tasks.update(task.id, 'default', { title: 'New title', branch: 'hapi/0821' })

        expect(updated?.title).toBe('New title')
        expect(updated?.branch).toBe('hapi/0821')
        expect(updated?.prompt).toBe(task.prompt)
        expect(updated?.seq).toBe(task.seq + 1)
    })

    it('replaces the spawn config wholesale', () => {
        const task = makeTask({ spawn: { flavor: 'claude', model: 'opus' } })
        const updated = store.tasks.update(task.id, 'default', { spawn: { flavor: 'codex' } })
        expect(updated?.spawn).toEqual({ flavor: 'codex' })
    })

    it('treats an empty patch as a read, without bumping seq', () => {
        const task = makeTask()
        const updated = store.tasks.update(task.id, 'default', {})
        expect(updated?.seq).toBe(task.seq)
    })

    it('refuses to patch across namespaces', () => {
        const task = makeTask()
        expect(store.tasks.update(task.id, 'other', { title: 'Hijacked' })).toBeNull()
        expect(store.tasks.get(task.id)?.title).toBe(task.title)
    })

    it('moves a task between columns', () => {
        const task = makeTask()
        expect(store.tasks.move(task.id, 'default', 'review')?.column).toBe('review')
    })

    it('deletes runs with the task but leaves the session behind', () => {
        const task = makeTask()
        makeSession('sess-del')
        const started = store.tasks.startRun({
            taskId: task.id, namespace: 'default', origin: 'user', sessionId: 'sess-del'
        })
        expect(started.outcome).toBe('started')

        expect(store.tasks.delete(task.id, 'default')).toBe(true)
        expect(store.tasks.get(task.id)).toBeNull()

        const runs = internalDb().prepare('SELECT COUNT(*) AS n FROM task_runs').get() as { n: number }
        expect(runs.n).toBe(0)

        // Session survives, tombstoned rather than cleared: an off-board
        // session is adopted on sight, and that must not resurrect the card.
        expect(store.sessions.getSession('sess-del')).not.toBeNull()
        const row = internalDb().prepare('SELECT task_id FROM sessions WHERE id = ?').get('sess-del') as {
            task_id: string | null
        }
        expect(row.task_id).toBe(DELETED_TASK_MARKER)
        expect(store.tasks.isSessionOnBoard('sess-del')).toBe(true)
    })

    it('refuses to delete across namespaces', () => {
        const task = makeTask()
        expect(store.tasks.delete(task.id, 'other')).toBe(false)
        expect(store.tasks.get(task.id)).not.toBeNull()
    })
})

describe('task runs', () => {
    it('starts a run, moves the card to running, and inherits the pinned base ref', () => {
        const task = makeTask({ baseRef: 'main' })
        const result = store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user' })

        expect(result.outcome).toBe('started')
        if (result.outcome !== 'started') return

        expect(result.run.status).toBe('running')
        expect(result.run.baseRef).toBe('main')
        expect(result.task.column).toBe('running')
        expect(result.task.lastRunId).toBe(result.run.id)
        expect(result.task.lastRunStatus).toBe('running')
    })

    it('refuses a second concurrent run on the same task', () => {
        const task = makeTask()
        const first = store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user' })
        const second = store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user' })

        expect(second.outcome).toBe('already-running')
        if (second.outcome !== 'already-running' || first.outcome !== 'started') return
        expect(second.run.id).toBe(first.run.id)
        expect(store.tasks.listRuns(task.id)).toHaveLength(1)
    })

    it('reports a missing task instead of orphaning a run row', () => {
        expect(store.tasks.startRun({ taskId: 'nope', namespace: 'default', origin: 'user' }).outcome)
            .toBe('task-not-found')
        const runs = internalDb().prepare('SELECT COUNT(*) AS n FROM task_runs').get() as { n: number }
        expect(runs.n).toBe(0)
    })

    it('binds a spawned session to the run, the task, and the session row', () => {
        const task = makeTask()
        makeSession('sess-1')
        const started = store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user' })
        if (started.outcome !== 'started') throw new Error('expected a started run')
        expect(started.task.currentSessionId).toBeNull()

        const attached = store.tasks.attachRunSession(started.run.id, 'sess-1')
        expect(attached?.sessionId).toBe('sess-1')
        expect(store.tasks.get(task.id)?.currentSessionId).toBe('sess-1')

        const row = internalDb().prepare('SELECT task_id FROM sessions WHERE id = ?').get('sess-1') as {
            task_id: string | null
        }
        expect(row.task_id).toBe(task.id)
        expect(store.tasks.getBySession('sess-1')?.id).toBe(task.id)
    })

    it('settles a run and lands the card in the requested column', () => {
        const task = makeTask()
        const started = store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user' })
        if (started.outcome !== 'started') throw new Error('expected a started run')

        const finished = store.tasks.finishRun(started.run.id, { status: 'succeeded', column: 'review' })
        expect(finished.outcome).toBe('finished')
        if (finished.outcome !== 'finished') return

        expect(finished.run.endedAt).not.toBeNull()
        expect(finished.task?.column).toBe('review')
        expect(finished.task?.lastRunStatus).toBe('succeeded')
        expect(finished.task?.lastError).toBeNull()
    })

    it('leaves the column alone when the caller omits it', () => {
        const task = makeTask()
        const started = store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user' })
        if (started.outcome !== 'started') throw new Error('expected a started run')
        store.tasks.move(task.id, 'default', 'blocked')

        const finished = store.tasks.finishRun(started.run.id, { status: 'failed', error: 'boom' })
        if (finished.outcome !== 'finished') throw new Error('expected a finished run')
        expect(finished.task?.column).toBe('blocked')
        expect(finished.task?.lastError).toBe('boom')
    })

    it('keeps a card the operator moved to Done in Done when its run settles later', () => {
        const task = makeTask()
        const started = store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user' })
        if (started.outcome !== 'started') throw new Error('expected a started run')
        store.tasks.move(task.id, 'default', 'done')

        const finished = store.tasks.finishRun(started.run.id, { status: 'canceled', column: 'ready' })
        if (finished.outcome !== 'finished') throw new Error('expected a finished run')
        expect(finished.task?.column).toBe('done')
        expect(finished.task?.lastRunStatus).toBe('canceled')
    })

    it('still moves a card that is not in Done when its run settles', () => {
        const task = makeTask()
        const started = store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user' })
        if (started.outcome !== 'started') throw new Error('expected a started run')
        store.tasks.move(task.id, 'default', 'review')

        const finished = store.tasks.finishRun(started.run.id, { status: 'canceled', column: 'ready' })
        if (finished.outcome !== 'finished') throw new Error('expected a finished run')
        expect(finished.task?.column).toBe('ready')
    })

    it('refuses to settle a run twice', () => {
        const task = makeTask()
        const started = store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user' })
        if (started.outcome !== 'started') throw new Error('expected a started run')

        store.tasks.finishRun(started.run.id, { status: 'succeeded' })
        const again = store.tasks.finishRun(started.run.id, { status: 'failed', error: 'late' })
        expect(again.outcome).toBe('already-finished')
        expect(store.tasks.get(task.id)?.lastRunStatus).toBe('succeeded')
    })

    it('does not let a late-settling older run overwrite a newer run', () => {
        const task = makeTask()
        const first = store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user' })
        if (first.outcome !== 'started') throw new Error('expected a started run')

        // The first run's process is gone but never settled; a retry opens a
        // second run, then the stale one reports failure.
        internalDb().prepare("UPDATE task_runs SET status = 'canceled' WHERE id = ?").run(first.run.id)
        const second = store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user' })
        if (second.outcome !== 'started') throw new Error('expected a second started run')
        internalDb().prepare("UPDATE task_runs SET status = 'running' WHERE id = ?").run(first.run.id)

        store.tasks.finishRun(first.run.id, { status: 'failed', error: 'stale', column: 'blocked' })

        const task2 = store.tasks.get(task.id)
        expect(task2?.lastRunId).toBe(second.run.id)
        expect(task2?.lastRunStatus).toBe('running')
        expect(task2?.column).toBe('running')
        // The stale run still records its own outcome.
        expect(store.tasks.getRun(first.run.id)?.status).toBe('failed')
    })

    it('clears the live session pointer on request', () => {
        const task = makeTask()
        makeSession('sess-clear')
        const started = store.tasks.startRun({
            taskId: task.id, namespace: 'default', origin: 'user', sessionId: 'sess-clear'
        })
        if (started.outcome !== 'started') throw new Error('expected a started run')
        expect(started.task.currentSessionId).toBe('sess-clear')

        store.tasks.finishRun(started.run.id, { status: 'succeeded', clearSession: true })
        expect(store.tasks.get(task.id)?.currentSessionId).toBeNull()
        // History keeps the id.
        expect(store.tasks.getRun(started.run.id)?.sessionId).toBe('sess-clear')
    })

    it('lists runs newest first', () => {
        const task = makeTask()
        const first = store.tasks.startRun({
            taskId: task.id, namespace: 'default', origin: 'user', startedAt: 1000
        })
        if (first.outcome !== 'started') throw new Error('expected a started run')
        store.tasks.finishRun(first.run.id, { status: 'failed' })
        const second = store.tasks.startRun({
            taskId: task.id, namespace: 'default', origin: 'followup', startedAt: 2000
        })
        if (second.outcome !== 'started') throw new Error('expected a second started run')

        const runs = store.tasks.listRuns(task.id)
        expect(runs.map((run) => run.id)).toEqual([second.run.id, first.run.id])
        expect(runs[0].origin).toBe('followup')
    })
})

/** Sessions are stored inactive until the CLI reports in; these helpers make
 *  the liveness the sweep keys off explicit. */
function setSessionActive(store: Store, sessionId: string, active: boolean): void {
    const db = (store as unknown as { db: Database }).db
    db.prepare('UPDATE sessions SET active = ? WHERE id = ?').run(active ? 1 : 0, sessionId)
}

describe('following a merged session', () => {
    it('moves the card, its runs and the back-pointer onto the surviving id', () => {
        // What a resume looks like from the store's side: the agent comes back
        // under a new session id and the old row is about to be deleted.
        const task = makeTask()
        makeSession('sess-old')
        makeSession('sess-new')
        const started = store.tasks.startRun({
            taskId: task.id, namespace: 'default', origin: 'user', sessionId: 'sess-old'
        })
        if (started.outcome !== 'started') throw new Error('expected a started run')

        expect(store.tasks.reassignSession('sess-old', 'sess-new')).toEqual([task.id])

        expect(store.tasks.get(task.id)?.currentSessionId).toBe('sess-new')
        expect(store.tasks.getRun(started.run.id)?.sessionId).toBe('sess-new')
        expect(store.tasks.getActiveRunBySession('sess-new')?.id).toBe(started.run.id)
        const backPointer = internalDb()
            .prepare('SELECT task_id FROM sessions WHERE id = ?')
            .get('sess-new') as { task_id: string | null }
        expect(backPointer.task_id).toBe(task.id)
    })

    it('survives the delete that follows it', () => {
        // The point of moving first: `current_session_id` is ON DELETE SET NULL,
        // so a card left on the old id loses its conversation entirely.
        const task = makeTask()
        makeSession('sess-old')
        makeSession('sess-new')
        store.tasks.startRun({
            taskId: task.id, namespace: 'default', origin: 'user', sessionId: 'sess-old'
        })

        store.tasks.reassignSession('sess-old', 'sess-new')
        store.sessions.deleteSession('sess-old', 'default')

        expect(store.tasks.get(task.id)?.currentSessionId).toBe('sess-new')
    })

    it('follows the session an adopted card was taken over from', () => {
        const task = makeTask({
            spawn: { flavor: 'claude', adoptedSessionId: 'sess-old', adoptedNativeSessionId: 'native-1' }
        })
        makeSession('sess-old')
        makeSession('sess-new')

        expect(store.tasks.reassignSession('sess-old', 'sess-new')).toEqual([task.id])

        expect(store.tasks.get(task.id)?.spawn).toEqual({
            flavor: 'claude',
            adoptedSessionId: 'sess-new',
            adoptedNativeSessionId: 'native-1'
        })
    })

    it('leaves a card already sitting on the merge target alone', () => {
        // The surviving session can be the card's own: its back-pointer must
        // not be overwritten by whatever the disappearing row carried.
        const mine = makeTask()
        const other = makeTask({ title: 'Someone else' })
        makeSession('sess-old')
        makeSession('sess-new')
        store.tasks.startRun({
            taskId: other.id, namespace: 'default', origin: 'user', sessionId: 'sess-old'
        })
        store.tasks.startRun({
            taskId: mine.id, namespace: 'default', origin: 'user', sessionId: 'sess-new'
        })

        store.tasks.reassignSession('sess-old', 'sess-new')

        const backPointer = internalDb()
            .prepare('SELECT task_id FROM sessions WHERE id = ?')
            .get('sess-new') as { task_id: string | null }
        expect(backPointer.task_id).toBe(mine.id)
    })

    it('reports nothing when no card names the session', () => {
        makeSession('sess-old')
        makeSession('sess-new')
        expect(store.tasks.reassignSession('sess-old', 'sess-new')).toEqual([])
    })
})

describe('orphan reconciliation', () => {
    it('flips stuck running rows to orphaned and parks the cards in ready', () => {
        const task = makeTask({ machineId: 'box-1' })
        makeSession('sess-orphan')
        const started = store.tasks.startRun({
            taskId: task.id, namespace: 'default', origin: 'user', sessionId: 'sess-orphan'
        })
        if (started.outcome !== 'started') throw new Error('expected a started run')
        setSessionActive(store, 'sess-orphan', false)

        const result = store.tasks.reconcileOrphanedRuns()
        expect(result.runIds).toEqual([started.run.id])
        expect(result.taskIds).toEqual([task.id])

        const settled = store.tasks.get(task.id)
        expect(settled?.column).toBe('ready')
        expect(settled?.lastRunStatus).toBe('orphaned')
        // The pointer survives: the session row went inactive, not away, and it
        // is the card's only route back into the transcript.
        expect(settled?.currentSessionId).toBe('sess-orphan')
        expect(store.tasks.getRun(started.run.id)?.status).toBe('orphaned')
    })

    it('leaves a reviewable card in review when it sweeps its run', () => {
        // A Claude Code session does not exit when the turn ends, so a card in
        // `review` still has a `running` run row behind it. Sweeping that run
        // must settle it without dragging the card out of Review — that was
        // work waiting to be looked at.
        const task = makeTask({ machineId: 'box-1' })
        makeSession('sess-review')
        const started = store.tasks.startRun({
            taskId: task.id, namespace: 'default', origin: 'user', sessionId: 'sess-review'
        })
        if (started.outcome !== 'started') throw new Error('expected a started run')
        store.tasks.move(task.id, 'default', 'review')
        setSessionActive(store, 'sess-review', false)

        store.tasks.reconcileOrphanedRuns()

        const settled = store.tasks.get(task.id)
        expect(settled?.column).toBe('review')
        expect(settled?.lastRunStatus).toBe('orphaned')
        expect(store.tasks.getRun(started.run.id)?.status).toBe('orphaned')
    })

    it('leaves a run alone while its session is still alive', () => {
        // A CLI survives a hub restart. Settling its run here would let the next
        // Start spawn a second agent alongside the first.
        const task = makeTask({ machineId: 'box-1' })
        makeSession('sess-live')
        setSessionActive(store, 'sess-live', true)
        store.tasks.startRun({
            taskId: task.id, namespace: 'default', origin: 'user', sessionId: 'sess-live'
        })

        expect(store.tasks.reconcileOrphanedRuns()).toEqual({ runIds: [], taskIds: [] })
        expect(store.tasks.get(task.id)?.column).toBe('running')
        expect(store.tasks.getActiveRun(task.id)).not.toBeNull()
    })

    it('settles a run that never got a session at all', () => {
        // Spawn died before `attachRunSession`: nothing is running, and nothing
        // ever will be.
        const task = makeTask({ machineId: 'box-1' })
        store.tasks.startRun({ taskId: task.id, namespace: 'default', origin: 'user' })

        expect(store.tasks.reconcileOrphanedRuns().taskIds).toEqual([task.id])
    })

    it('scopes the sweep to one machine', () => {
        const mine = makeTask({ machineId: 'box-1' })
        const other = makeTask({ machineId: 'box-2' })
        store.tasks.startRun({ taskId: mine.id, namespace: 'default', origin: 'user' })
        store.tasks.startRun({ taskId: other.id, namespace: 'default', origin: 'user' })

        const result = store.tasks.reconcileOrphanedRuns({ machineId: 'box-1' })
        expect(result.taskIds).toEqual([mine.id])
        expect(store.tasks.get(other.id)?.lastRunStatus).toBe('running')
    })

    it('is a no-op when nothing is running', () => {
        makeTask()
        expect(store.tasks.reconcileOrphanedRuns()).toEqual({ runIds: [], taskIds: [] })
    })
})
