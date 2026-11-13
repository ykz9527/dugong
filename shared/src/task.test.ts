import { describe, expect, it } from 'bun:test'
import {
    TASK_COLUMNS,
    TASK_TITLE_MAX_LENGTH,
    deriveTaskTitle,
    TaskSchema,
    TaskPullRequestSchema,
    TaskRunSchema,
    TaskSpawnConfigSchema,
    isTaskColumn,
    isTaskRunning,
    taskNeedsAttention
} from './task'

function makeTask(overrides: Record<string, unknown> = {}) {
    return {
        id: 'task-1',
        namespace: 'default',
        title: 'Fix the flaky test',
        prompt: 'Investigate hub/src/store flakiness and fix it.',
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
    }
}

describe('TaskSchema', () => {
    it('accepts a fully specified task', () => {
        const parsed = TaskSchema.parse(makeTask())
        expect(parsed.column).toBe('ready')
        expect(parsed.spawn.flavor).toBe('claude')
    })

    it('rejects an unknown column', () => {
        expect(TaskSchema.safeParse(makeTask({ column: 'archived' })).success).toBe(false)
    })

    it('rejects an unknown agent flavor', () => {
        expect(TaskSchema.safeParse(makeTask({ spawn: { flavor: 'nope' } })).success).toBe(false)
    })

    it('requires nullable fields to be present, not omitted', () => {
        const { branch, ...withoutBranch } = makeTask()
        expect(branch).toBeNull()
        expect(TaskSchema.safeParse(withoutBranch).success).toBe(false)
    })
})

describe('TaskPullRequestSchema', () => {
    const snapshot = {
        url: 'https://github.com/acme/widget/pull/7',
        number: 7,
        state: 'open',
        title: 'Fix the parser',
        headBranch: 'hapi/fix',
        baseBranch: 'main',
        isDraft: false,
        mergeable: null,
        checks: 'pending',
        checkedAt: 1
    }

    it('accepts a snapshot with an undecided mergeable verdict', () => {
        expect(TaskPullRequestSchema.parse(snapshot).mergeable).toBeNull()
    })

    it('rejects an unknown state or check verdict', () => {
        expect(TaskPullRequestSchema.safeParse({ ...snapshot, state: 'draft' }).success).toBe(false)
        expect(TaskPullRequestSchema.safeParse({ ...snapshot, checks: 'green' }).success).toBe(false)
    })

    it('rides on a task as a nullable field', () => {
        expect(TaskSchema.parse(makeTask({ pullRequest: snapshot })).pullRequest?.number).toBe(7)
        const { pullRequest, ...withoutPr } = makeTask()
        expect(pullRequest).toBeNull()
        expect(TaskSchema.safeParse(withoutPr).success).toBe(false)
    })
})

describe('TaskSpawnConfigSchema', () => {
    it('needs nothing but a flavor', () => {
        expect(TaskSpawnConfigSchema.parse({ flavor: 'codex' })).toEqual({ flavor: 'codex' })
    })
})

describe('TaskRunSchema', () => {
    it('keeps the reproducibility anchor separate from the requested ref', () => {
        const run = TaskRunSchema.parse({
            id: 'run-1',
            taskId: 'task-1',
            sessionId: 'sess-1',
            status: 'succeeded',
            origin: 'user',
            baseRef: 'main',
            baseCommit: 'c0ffee',
            branch: 'hapi/0821-fix',
            worktreePath: '/repo-worktrees/0821-fix',
            startedAt: 1,
            endedAt: 2,
            error: null
        })
        expect(run.baseRef).toBe('main')
        expect(run.baseCommit).toBe('c0ffee')
    })
})

describe('helpers', () => {
    it('isTaskColumn guards every declared column and nothing else', () => {
        for (const column of TASK_COLUMNS) {
            expect(isTaskColumn(column)).toBe(true)
        }
        expect(isTaskColumn('archived')).toBe(false)
        expect(isTaskColumn(null)).toBe(false)
    })

    it('taskNeedsAttention covers blocked and review, but not archived cards', () => {
        expect(taskNeedsAttention({ column: 'blocked', archivedAt: null })).toBe(true)
        expect(taskNeedsAttention({ column: 'review', archivedAt: null })).toBe(true)
        expect(taskNeedsAttention({ column: 'running', archivedAt: null })).toBe(false)
        expect(taskNeedsAttention({ column: 'review', archivedAt: 123 })).toBe(false)
    })

    it('isTaskRunning needs both the column and the run status', () => {
        expect(isTaskRunning({ column: 'running', lastRunStatus: 'running' })).toBe(true)
        expect(isTaskRunning({ column: 'running', lastRunStatus: 'orphaned' })).toBe(false)
        expect(isTaskRunning({ column: 'review', lastRunStatus: 'running' })).toBe(false)
    })
})

describe('deriveTaskTitle', () => {
    it('takes the first non-empty line and collapses whitespace', () => {
        expect(deriveTaskTitle('\n\n  Fix   the   parser \nand add tests')).toBe('Fix the parser')
    })

    it('returns an empty string for a blank prompt', () => {
        expect(deriveTaskTitle('   \n\n')).toBe('')
    })

    it('truncates on a word boundary', () => {
        const prompt = 'Rewrite the tokenizer so that it stops choking on nested template literals in TypeScript files'
        const title = deriveTaskTitle(prompt)

        expect(title.endsWith('...')).toBe(true)
        expect(title.length).toBeLessThanOrEqual(TASK_TITLE_MAX_LENGTH + 3)
        expect(prompt.startsWith(title.slice(0, -3))).toBe(true)
        // The break landed between words, not mid-word.
        expect(title.slice(0, -3).endsWith(' ')).toBe(false)
        expect(prompt[title.length - 3]).toBe(' ')
    })

    it('hard-clips a single unbroken token rather than collapsing to nothing', () => {
        const title = deriveTaskTitle('x'.repeat(200))
        expect(title).toBe(`${'x'.repeat(TASK_TITLE_MAX_LENGTH)}...`)
    })
})
