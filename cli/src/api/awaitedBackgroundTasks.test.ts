import { describe, expect, it } from 'vitest'
import { AwaitedBackgroundTasks, TURN_GAP_MS, UNSEEN_TASK_GRACE_MS } from './awaitedBackgroundTasks'

function harness() {
    let now = 1_000_000
    const alive = new Set<number>()
    const tasks = new AwaitedBackgroundTasks({ now: () => now, isPidAlive: (pid) => alive.has(pid) })
    return { tasks, alive, advance: (ms: number) => { now += ms } }
}

describe('AwaitedBackgroundTasks', () => {
    it('holds a declared task until it drops out of the snapshot', () => {
        const { tasks } = harness()
        tasks.onThinking(true)
        tasks.onSnapshot(['run', 'preview'])
        expect(tasks.declare({ taskId: 'run' })).toEqual({ ok: true })
        tasks.onThinking(false)
        expect(tasks.count()).toBe(1)

        // The preview server stays up; the run finishes.
        tasks.onSnapshot(['preview'])
        expect(tasks.count()).toBe(0)
    })

    it('waits for a snapshot that trails the declaration, but not forever', () => {
        const { tasks, advance } = harness()
        tasks.onSnapshot([])
        expect(tasks.declare({ taskId: 'late' })).toEqual(expect.objectContaining({ ok: true, warning: expect.any(String) }))
        tasks.onSnapshot(['late'])
        advance(UNSEEN_TASK_GRACE_MS + 1)
        expect(tasks.count()).toBe(1)

        expect(tasks.declare({ taskId: 'typo' }).ok).toBe(true)
        advance(UNSEEN_TASK_GRACE_MS + 1)
        expect(tasks.count()).toBe(1)
    })

    it('releases a declared pid once the process is gone', () => {
        const { tasks, alive } = harness()
        expect(tasks.declare({ pid: 4242 }).ok).toBe(false)
        alive.add(4242)
        expect(tasks.declare({ pid: 4242 }).ok).toBe(true)
        expect(tasks.count()).toBe(1)
        alive.delete(4242)
        expect(tasks.count()).toBe(0)
    })

    it('releases everything when the agent starts its next turn, not on a blip', () => {
        const { tasks, advance } = harness()
        tasks.onSnapshot(['run'])
        tasks.onThinking(true)
        tasks.declare({ taskId: 'run' })

        // Still the same turn.
        tasks.onThinking(false)
        advance(TURN_GAP_MS - 1)
        tasks.onThinking(true)
        expect(tasks.count()).toBe(1)

        tasks.onThinking(false)
        advance(TURN_GAP_MS)
        expect(tasks.count()).toBe(1)
        tasks.onThinking(true)
        expect(tasks.count()).toBe(0)
    })
})
