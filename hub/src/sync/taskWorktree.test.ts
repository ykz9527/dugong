import { beforeEach, describe, expect, it } from 'bun:test'
import type { RemoveWorktreeRequest, RemoveWorktreeResponse } from '@hapi/protocol/apiTypes'
import type { StoredTask } from '../store'
import { TaskWorktreeService } from './taskWorktree'

let calls: RemoveWorktreeRequest[]
let capabilities: readonly string[] | null
let response: () => Promise<RemoveWorktreeResponse>
let service: TaskWorktreeService

function makeTask(overrides: Partial<StoredTask> = {}): StoredTask {
    return {
        id: 'task-1',
        namespace: 'default',
        title: 't',
        prompt: 'p',
        column: 'review',
        machineId: 'box-1',
        workdir: '/repo',
        isolation: 'worktree',
        worktreeName: null,
        baseRef: 'main',
        branch: 'hapi/fix',
        worktreePath: '/repo-worktrees/fix',
        spawn: { flavor: 'claude' },
        currentSessionId: null,
        lastRunId: null,
        lastRunStatus: 'succeeded',
        lastError: null,
        pullRequest: null,
        archivedAt: null,
        createdAt: 1,
        updatedAt: 1,
        seq: 1,
        ...overrides
    }
}

beforeEach(() => {
    calls = []
    capabilities = ['remove-worktree']
    response = async () => ({ outcome: 'removed', branch: 'deleted' })
    service = new TaskWorktreeService({
        getMachineCapabilities: () => capabilities,
        removeWorktree: async (_machineId, request) => {
            calls.push(request)
            return await response()
        }
    })
})

describe('TaskWorktreeService', () => {
    it('forwards the worktree and branch to the runner, never a repo root', async () => {
        expect(await service.teardown(makeTask())).toEqual({ outcome: 'removed', branch: 'deleted' })
        expect(calls[0]).toEqual({
            worktreePath: '/repo-worktrees/fix',
            branch: 'hapi/fix',
            force: false
        })
    })

    it('passes force through', async () => {
        await service.teardown(makeTask(), { force: true })
        expect(calls[0].force).toBe(true)
    })

    it('can leave the branch alone', async () => {
        await service.teardown(makeTask(), { deleteBranch: false })
        expect(calls[0].branch).toBeUndefined()
    })

    it('skips a task that never had a worktree', async () => {
        expect(await service.teardown(makeTask({ worktreePath: null })))
            .toEqual({ outcome: 'skipped', reason: 'no-worktree' })
        expect(calls).toHaveLength(0)
    })

    it('skips a task with no machine to ask', async () => {
        expect(await service.teardown(makeTask({ machineId: null })))
            .toEqual({ outcome: 'skipped', reason: 'no-machine' })
    })

    it('skips an offline machine rather than waiting on an RPC', async () => {
        capabilities = null
        expect(await service.teardown(makeTask()))
            .toEqual({ outcome: 'skipped', reason: 'machine-offline' })
        expect(calls).toHaveLength(0)
    })

    it('skips a runner that does not advertise the capability', async () => {
        capabilities = ['stop-runner', 'cursor-chat-store-status']
        expect(await service.teardown(makeTask()))
            .toEqual({ outcome: 'skipped', reason: 'unsupported-runner' })
        expect(calls).toHaveLength(0)
    })

    it('reports the runner refusing a dirty worktree', async () => {
        response = async () => ({ outcome: 'dirty', changedFiles: 2 })
        expect(await service.teardown(makeTask())).toEqual({ outcome: 'dirty', changedFiles: 2 })
    })

    it('probes without asking for a removal', async () => {
        response = async () => ({ outcome: 'dirty', changedFiles: 4 })
        expect(await service.probe(makeTask())).toEqual({ outcome: 'dirty', changedFiles: 4 })
        expect(calls[0]).toEqual({ worktreePath: '/repo-worktrees/fix', probe: true })
    })

    it('skips a probe the same way it skips a teardown', async () => {
        capabilities = null
        expect(await service.probe(makeTask())).toEqual({ outcome: 'skipped', reason: 'machine-offline' })
        expect(calls).toHaveLength(0)
    })

    it('turns a thrown RPC into a reported error', async () => {
        response = async () => { throw new Error('socket closed') }
        expect(await service.teardown(makeTask()))
            .toEqual({ outcome: 'error', message: 'socket closed' })
    })
})
