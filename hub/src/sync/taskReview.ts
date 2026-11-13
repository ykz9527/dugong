import { TaskPullRequestSchema, type TaskPullRequest } from '@hapi/protocol'
import type { Store, StoredTask } from '../store'
import {
    createPull,
    findPullByHead,
    getDefaultBranch,
    getPull,
    isGitHostOwner,
    parseGitRemote,
    resolveGitHostTarget,
    type GitHostFailure,
    type GitHostTarget
} from '../gitHost'

/**
 * The review loop: turn a finished task's branch into a pull request, and keep
 * the task's view of that PR current.
 *
 * Two halves with deliberately different requirements:
 *
 *  - **Opening** a PR needs the machine. The branch only exists in the
 *    worktree on disk, so it has to be pushed from there, which means a live
 *    session to run the push through.
 *  - **Refreshing** one does not. Everything needed to query the forge is
 *    recoverable from the stored PR URL, so a task whose agent finished days
 *    ago still updates. This is the common case — tasks in review outlive
 *    their sessions — and making it depend on a session would have made the
 *    column mostly stale.
 *
 * Both use the hub's git host tokens, which belong to the owner and reach
 * every repo the owner can. So the whole loop is owner-only, like managing the
 * tokens: another namespace could otherwise point `origin` at the owner's
 * private repo and act on it with the owner's token.
 */

const PUSH_TIMEOUT_MS = 120_000
const REMOTE_TIMEOUT_MS = 15_000

export type TaskReviewFailure =
    | GitHostFailure
    | { outcome: 'task-not-found' }
    | { outcome: 'no-branch'; message: string }
    | { outcome: 'no-session'; message: string }
    | { outcome: 'push-failed'; message: string }
    | { outcome: 'no-pull-request'; message: string }
    /** Called from a namespace other than the token owner's. */
    | { outcome: 'owner-only' }

export type TaskReviewResult<T> = { outcome: 'ok'; value: T } | TaskReviewFailure

export type RunCommand = (
    sessionId: string,
    options: { command: string; cwd?: string; timeout?: number }
) => Promise<{ success?: boolean; stdout?: string; stderr?: string; exitCode?: number; error?: string }>

export type TaskReviewDeps = {
    store: Store
    runCommand: RunCommand
    /** Host-keyed forge tokens, read fresh per call so a newly added token
     *  takes effect without a hub restart. */
    readTokens: () => Promise<Record<string, string> | undefined>
    onTaskChanged?: (task: StoredTask) => void
}

/**
 * Recover owner/repo/host from a stored PR URL.
 *
 * `https://github.com/owner/repo/pull/12` — the same shape GitHub Enterprise
 * uses. This is what lets refresh work without touching the machine.
 */
export function parsePullRequestUrl(url: string): { host: string; owner: string; repo: string } | null {
    try {
        const parsed = new URL(url)
        const segments = parsed.pathname.split('/').filter(Boolean)
        const pullIndex = segments.indexOf('pull')
        if (pullIndex < 2) return null
        return {
            host: parsed.hostname.toLowerCase(),
            owner: segments.slice(0, pullIndex - 1).join('/'),
            repo: segments[pullIndex - 1]
        }
    } catch {
        return null
    }
}

/** Body text for a generated PR. The prompt is the most useful thing a
 *  reviewer can be handed; it is what the change was asked to do. */
export function buildPullBody(task: Pick<StoredTask, 'prompt' | 'id'>): string {
    const prompt = task.prompt.trim()
    const quoted = prompt
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    return `${quoted}\n\n---\nOpened from dugong task \`${task.id}\`.`
}

export class TaskReviewService {
    private readonly deps: TaskReviewDeps

    constructor(deps: TaskReviewDeps) {
        this.deps = deps
    }

    async openPullRequest(
        taskId: string,
        namespace: string,
        options?: { baseBranch?: string; title?: string; draft?: boolean }
    ): Promise<TaskReviewResult<TaskPullRequest>> {
        if (!isGitHostOwner(namespace)) return { outcome: 'owner-only' }
        const store = this.deps.store
        const task = store.tasks.getByNamespace(taskId, namespace)
        if (!task) return { outcome: 'task-not-found' }

        if (!task.branch) {
            return {
                outcome: 'no-branch',
                message: 'This task has no branch to open a pull request from. Only worktree-isolated tasks produce one.'
            }
        }
        if (!task.currentSessionId) {
            return {
                outcome: 'no-session',
                message: 'Opening a pull request pushes the branch from the machine, which needs a live session. Resume the task first.'
            }
        }

        const cwd = task.worktreePath ?? task.workdir
        const sessionId = task.currentSessionId

        const remote = await this.deps.runCommand(sessionId, {
            command: 'git remote get-url origin',
            cwd,
            timeout: REMOTE_TIMEOUT_MS
        })
        const remoteUrl = (remote.stdout ?? '').trim()
        if (remote.success === false || !remoteUrl) {
            return {
                outcome: 'rejected',
                message: remote.error ?? remote.stderr?.trim() ?? 'Repository has no `origin` remote'
            }
        }

        const target = resolveGitHostTarget(remoteUrl, await this.deps.readTokens())
        if (target.outcome !== 'ok') return target

        // Push before asking the forge for anything: a PR against a branch the
        // remote has never seen fails with a confusing 422.
        const push = await this.deps.runCommand(sessionId, {
            command: `git push --set-upstream origin ${shellQuote(task.branch)}`,
            cwd,
            timeout: PUSH_TIMEOUT_MS
        })
        if (push.success === false) {
            return {
                outcome: 'push-failed',
                message: push.stderr?.trim() || push.error || 'git push failed'
            }
        }

        const baseBranch = options?.baseBranch ?? await this.resolveBaseBranch(target.value, task)
        if (typeof baseBranch !== 'string') return baseBranch

        const created = await createPull(target.value, {
            title: options?.title ?? task.title,
            body: buildPullBody(task),
            headBranch: task.branch,
            baseBranch,
            draft: options?.draft === true
        })

        if (created.outcome === 'already-exists') {
            // Adopt the PR that is already there instead of reporting a
            // conflict the operator would just have to resolve by hand.
            const existing = await findPullByHead(target.value, task.branch)
            if (existing.outcome !== 'ok') return existing
            return { outcome: 'ok', value: this.persist(task, namespace, existing.value) }
        }
        if (created.outcome !== 'ok') return created

        return { outcome: 'ok', value: this.persist(task, namespace, created.value) }
    }

    /** Re-read the stored PR from the forge. Needs no machine, no session. */
    async refreshPullRequest(
        taskId: string,
        namespace: string
    ): Promise<TaskReviewResult<TaskPullRequest>> {
        if (!isGitHostOwner(namespace)) return { outcome: 'owner-only' }
        const store = this.deps.store
        const task = store.tasks.getByNamespace(taskId, namespace)
        if (!task) return { outcome: 'task-not-found' }

        // An unreadable snapshot counts as none: the task can open a new one.
        const snapshot = task.pullRequest === null ? null : TaskPullRequestSchema.safeParse(task.pullRequest)
        const stored = snapshot?.success ? snapshot.data : null
        if (!stored) {
            return { outcome: 'no-pull-request', message: 'This task has no pull request yet' }
        }

        const parsed = parsePullRequestUrl(stored.url)
        if (!parsed) {
            return { outcome: 'rejected', message: `Could not parse pull request URL: ${stored.url}` }
        }

        const tokens = await this.deps.readTokens()
        // Rebuild a target from the URL: `resolveGitHostTarget` takes a git
        // remote, and an https PR URL parses identically for these purposes.
        const target = resolveGitHostTarget(`https://${parsed.host}/${parsed.owner}/${parsed.repo}`, tokens)
        if (target.outcome !== 'ok') return target

        const fresh = await getPull(target.value, stored.number)
        if (fresh.outcome !== 'ok') return fresh

        return { outcome: 'ok', value: this.persist(task, namespace, fresh.value) }
    }

    /** Drop the cached PR — used when it was opened against the wrong repo, or
     *  the operator wants the task to forget it. */
    forgetPullRequest(taskId: string, namespace: string): TaskReviewResult<StoredTask> {
        if (!isGitHostOwner(namespace)) return { outcome: 'owner-only' }
        const updated = this.deps.store.tasks.setPullRequest(taskId, namespace, null)
        if (!updated) return { outcome: 'task-not-found' }
        this.deps.onTaskChanged?.(updated)
        return { outcome: 'ok', value: updated }
    }

    private async resolveBaseBranch(
        target: GitHostTarget,
        task: StoredTask
    ): Promise<string | TaskReviewFailure> {
        // The pinned base ref is the honest default: it is what the worktree
        // branched from. It may be a tag or a sha though, and a PR base has to
        // be a branch — so fall back to the repo default when it is not one.
        if (task.baseRef && /^[\w./-]+$/.test(task.baseRef) && !/^[0-9a-f]{7,40}$/i.test(task.baseRef)) {
            return task.baseRef
        }
        const fallback = await getDefaultBranch(target)
        return fallback.outcome === 'ok' ? fallback.value : fallback
    }

    private persist(task: StoredTask, namespace: string, pull: TaskPullRequest): TaskPullRequest {
        const updated = this.deps.store.tasks.setPullRequest(task.id, namespace, pull)
        if (updated) this.deps.onTaskChanged?.(updated)
        return pull
    }
}

/** Single-quote a branch name for `sh -c`. Branch names allow very little, but
 *  they are still attacker-influenced through a repo's refs. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}

export { parseGitRemote }
