import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { Task } from '@hapi/protocol'
import type { TaskListResponse } from '@hapi/protocol/apiTypes'
import { queryKeys } from '@/lib/query-keys'
import { applyTaskUpdateToLists } from './taskListPatch'

function task(overrides: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        namespace: 'default',
        title: 'Fix the flaky test',
        prompt: 'Investigate.',
        column: 'ready',
        machineId: 'machine-1',
        workdir: '/repo',
        isolation: 'worktree',
        worktreeName: null,
        baseRef: 'main',
        branch: null,
        worktreePath: null,
        spawn: { flavor: 'claude', permissionMode: 'default' },
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
    } as Task
}

const liveKey = queryKeys.taskList('all:any:live:everyone')
const archivedKey = queryKeys.taskList('all:any:archived:everyone')

function seed(client: QueryClient, key: readonly unknown[], tasks: Task[]) {
    const counts: Record<string, number> = {}
    for (const t of tasks) if (t.archivedAt == null) counts[t.column] = (counts[t.column] ?? 0) + 1
    client.setQueryData<TaskListResponse>(key, { tasks, counts })
}

describe('applyTaskUpdateToLists', () => {
    it('patches a listed card in place and keeps hub order and counts', () => {
        const client = new QueryClient()
        seed(client, liveKey, [task({ id: 'b', updatedAt: 5 }), task({ id: 'a', updatedAt: 3 })])

        const stale = applyTaskUpdateToLists(client, task({ id: 'a', column: 'running', updatedAt: 9 }))

        expect(stale).toEqual([])
        const list = client.getQueryData<TaskListResponse>(liveKey)
        expect(list?.tasks.map((t) => [t.id, t.column])).toEqual([['a', 'running'], ['b', 'ready']])
        expect(list?.counts).toEqual({ ready: 1, running: 1 })
    })

    it('drops an archived card from live lists but keeps it in archived ones', () => {
        const client = new QueryClient()
        seed(client, liveKey, [task({ id: 'a' })])
        seed(client, archivedKey, [task({ id: 'a' })])

        applyTaskUpdateToLists(client, task({ id: 'a', archivedAt: 7, updatedAt: 7 }))

        expect(client.getQueryData<TaskListResponse>(liveKey)?.tasks).toEqual([])
        expect(client.getQueryData<TaskListResponse>(archivedKey)?.tasks.map((t) => t.archivedAt)).toEqual([7])
        expect(client.getQueryData<TaskListResponse>(archivedKey)?.counts).toEqual({ ready: 0 })
    })

    it('leaves lists without the card, and malformed events, to a refetch', () => {
        const client = new QueryClient()
        seed(client, liveKey, [task({ id: 'a' })])

        expect(applyTaskUpdateToLists(client, task({ id: 'new' }))).toEqual([liveKey])
        expect(applyTaskUpdateToLists(client, { id: 'a' })).toBe('all')
    })
})
