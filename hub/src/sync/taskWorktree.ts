import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import type {
    RemoveWorktreeRequest,
    RemoveWorktreeResponse
} from '@hapi/protocol/apiTypes'
import type { StoredTask } from '../store'

/**
 * Task worktree teardown.
 *
 * Deleting a task used to leave its git worktree and branch on disk forever.
 * This closes that, but not by making deletion destructive: the runner refuses
 * to remove a worktree with uncommitted work unless explicitly forced, only
 * ever deletes a branch git considers fully merged, and removes nothing when
 * it cannot tell whether the worktree is clean.
 *
 * Every failure path is reported rather than thrown. A worktree that could not
 * be removed must not block deleting the task — the task is hub state, the
 * worktree is disk state, and stranding the former to protect the latter is the
 * worse outcome. Uncommitted work is the exception, which is why callers can
 * `probe` for it before they stop or change anything.
 */

export type WorktreeTeardownSkipReason =
    | 'no-worktree'
    | 'no-machine'
    | 'machine-offline'
    | 'unsupported-runner'

export type WorktreeTeardownResult =
    | { outcome: 'removed'; branch: 'deleted' | 'kept-unmerged' | 'not-found' | 'failed' | 'skipped' }
    | { outcome: 'dirty'; changedFiles: number }
    | { outcome: 'not-a-worktree' }
    | { outcome: 'unmerged' }
    | { outcome: 'skipped'; reason: WorktreeTeardownSkipReason }
    | { outcome: 'error'; message: string }

export type WorktreeProbeResult =
    | { outcome: 'clean' }
    | { outcome: 'dirty'; changedFiles: number }
    | { outcome: 'not-a-worktree' }
    | { outcome: 'skipped'; reason: WorktreeTeardownSkipReason }
    | { outcome: 'error'; message: string }

export type TaskWorktreeDeps = {
    /** Advertised machine capabilities, or null when the machine is unknown. */
    getMachineCapabilities: (machineId: string) => readonly string[] | null
    removeWorktree: (machineId: string, request: RemoveWorktreeRequest) => Promise<RemoveWorktreeResponse>
}

export class TaskWorktreeService {
    private readonly deps: TaskWorktreeDeps

    constructor(deps: TaskWorktreeDeps) {
        this.deps = deps
    }

    /**
     * Ask the runner whether the task's worktree holds uncommitted work,
     * without touching it. Archive and delete call this first, so a dirty
     * worktree is refused before the agent is stopped or the run cancelled.
     */
    async probe(task: StoredTask): Promise<WorktreeProbeResult> {
        const target = this.target(task)
        if ('outcome' in target) return target

        const result = await this.call(target.machineId, { worktreePath: target.worktreePath, probe: true })
        switch (result.outcome) {
            case 'clean':
            case 'dirty':
            case 'not-a-worktree':
            case 'error':
                return result
            default:
                return { outcome: 'error', message: `Unexpected probe answer: ${result.outcome}` }
        }
    }

    async teardown(
        task: StoredTask,
        options?: { force?: boolean; deleteBranch?: boolean; keepUnmerged?: boolean }
    ): Promise<WorktreeTeardownResult> {
        const target = this.target(task)
        if ('outcome' in target) return target

        const result = await this.call(target.machineId, {
            worktreePath: target.worktreePath,
            branch: options?.deleteBranch === false ? undefined : task.branch ?? undefined,
            force: options?.force === true,
            ...(options?.keepUnmerged ? { keepUnmerged: true } : {})
        })
        // Only a probe is answered with `clean`; anything else asked for a removal.
        return result.outcome === 'clean'
            ? { outcome: 'error', message: 'Runner answered a removal as a probe' }
            : result
    }

    private target(
        task: StoredTask
    ): { machineId: string; worktreePath: string } | { outcome: 'skipped'; reason: WorktreeTeardownSkipReason } {
        if (!task.worktreePath) {
            return { outcome: 'skipped', reason: 'no-worktree' }
        }
        if (!task.machineId) {
            return { outcome: 'skipped', reason: 'no-machine' }
        }

        const capabilities = this.deps.getMachineCapabilities(task.machineId)
        if (capabilities === null) {
            return { outcome: 'skipped', reason: 'machine-offline' }
        }
        // Older runners simply do not have this handler. Reporting that is
        // better than a timeout the operator has to interpret.
        if (!capabilities.includes(MACHINE_CAPABILITIES.RemoveWorktree)) {
            return { outcome: 'skipped', reason: 'unsupported-runner' }
        }
        return { machineId: task.machineId, worktreePath: task.worktreePath }
    }

    private async call(machineId: string, request: RemoveWorktreeRequest): Promise<RemoveWorktreeResponse> {
        try {
            return await this.deps.removeWorktree(machineId, request)
        } catch (error) {
            return {
                outcome: 'error',
                message: error instanceof Error ? error.message : String(error)
            }
        }
    }
}
