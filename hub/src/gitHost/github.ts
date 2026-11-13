import type { TaskPullRequestChecks, TaskPullRequestState } from '@hapi/protocol'
import type {
    CreatePullInput,
    GitHostResult,
    GitHostTarget,
    PullSnapshot
} from './types'

/**
 * GitHub REST client, scoped to the review loop.
 *
 * Only what a task in review needs: open a PR, and read back enough state to
 * render it (open/merged/closed, mergeable, rolled-up checks). Issues,
 * discussions, projects and releases are deliberately left out; every endpoint
 * added is one more thing to keep working against an API that changes.
 */

const REQUEST_TIMEOUT_MS = 15_000
const USER_AGENT = 'dugong-hub'

type GitHubPullResponse = {
    number: number
    html_url: string
    title: string
    state: string
    draft?: boolean
    merged?: boolean
    merged_at?: string | null
    mergeable?: boolean | null
    head?: { ref?: string; sha?: string }
    base?: { ref?: string }
}

type GitHubCheckRun = {
    status?: string
    conclusion?: string | null
}

function authHeaders(target: GitHostTarget): Record<string, string> {
    return {
        authorization: `Bearer ${target.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': USER_AGENT
    }
}

function repoUrl(target: GitHostTarget, path: string): string {
    return `${target.apiBase}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}${path}`
}

function messageFrom(body: unknown, fallback: string): string {
    if (body && typeof body === 'object' && 'message' in body) {
        const message = (body as { message?: unknown }).message
        if (typeof message === 'string' && message) return message
    }
    return fallback
}

async function call<T>(
    url: string,
    init: RequestInit,
    target: GitHostTarget
): Promise<GitHostResult<T>> {
    let response: Response
    try {
        response = await fetch(url, {
            ...init,
            headers: { ...authHeaders(target), ...init.headers },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
    } catch (error) {
        return {
            outcome: 'network-error',
            message: error instanceof Error ? error.message : String(error)
        }
    }

    if (response.ok) {
        return { outcome: 'ok', value: await response.json() as T }
    }

    const body = await response.json().catch(() => null)
    if (response.status === 401 || response.status === 403) {
        return { outcome: 'unauthorized', message: messageFrom(body, 'GitHub rejected the token') }
    }
    if (response.status === 404) {
        // GitHub answers 404 for a repo the token cannot see, not 403 — so
        // "not found" here often really means "token lacks access".
        return { outcome: 'not-found', message: messageFrom(body, 'Repository or pull request not found') }
    }
    return { outcome: 'rejected', message: messageFrom(body, `GitHub returned HTTP ${response.status}`) }
}

/**
 * Roll many check runs into one verdict.
 *
 * Failing wins over pending, and pending over passing: the summary exists to
 * answer "can I merge this yet", and both of the first two are a no.
 */
export function rollUpChecks(runs: GitHubCheckRun[]): TaskPullRequestChecks {
    if (runs.length === 0) return 'none'

    let sawPending = false
    for (const run of runs) {
        if (run.status !== 'completed') {
            sawPending = true
            continue
        }
        const conclusion = run.conclusion ?? ''
        if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled') {
            return 'failing'
        }
        // `neutral`, `success`, `skipped` and `action_required` are all
        // non-blocking for this summary; only hard failures are.
    }
    return sawPending ? 'pending' : 'passing'
}

function toState(pull: GitHubPullResponse): TaskPullRequestState {
    if (pull.merged || pull.merged_at) return 'merged'
    return pull.state === 'closed' ? 'closed' : 'open'
}

async function fetchChecks(
    target: GitHostTarget,
    sha: string | undefined
): Promise<TaskPullRequestChecks | null> {
    if (!sha) return null
    const result = await call<{ check_runs?: GitHubCheckRun[] }>(
        repoUrl(target, `/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`),
        { method: 'GET' },
        target
    )
    // Checks are advisory here: a repo with the Checks API disabled, or a token
    // without that scope, must not turn a healthy PR into an error.
    if (result.outcome !== 'ok') return null
    return rollUpChecks(result.value.check_runs ?? [])
}

function toSnapshot(
    pull: GitHubPullResponse,
    checks: TaskPullRequestChecks | null,
    input?: { headBranch: string; baseBranch: string }
): PullSnapshot {
    return {
        url: pull.html_url,
        number: pull.number,
        state: toState(pull),
        title: pull.title,
        headBranch: pull.head?.ref ?? input?.headBranch ?? '',
        baseBranch: pull.base?.ref ?? input?.baseBranch ?? '',
        isDraft: pull.draft === true,
        mergeable: typeof pull.mergeable === 'boolean' ? pull.mergeable : null,
        checks,
        checkedAt: Date.now()
    }
}

/** The repo's default branch, used as the PR base when none is given. */
export async function getDefaultBranch(target: GitHostTarget): Promise<GitHostResult<string>> {
    const result = await call<{ default_branch?: string }>(repoUrl(target, ''), { method: 'GET' }, target)
    if (result.outcome !== 'ok') return result
    const branch = result.value.default_branch
    return branch
        ? { outcome: 'ok', value: branch }
        : { outcome: 'rejected', message: 'Repository has no default branch' }
}

export async function createPull(
    target: GitHostTarget,
    input: CreatePullInput
): Promise<GitHostResult<PullSnapshot>> {
    const result = await call<GitHubPullResponse>(
        repoUrl(target, '/pulls'),
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                title: input.title,
                body: input.body,
                head: input.headBranch,
                base: input.baseBranch,
                draft: input.draft
            })
        },
        target
    )

    if (result.outcome === 'rejected' && /already exists/i.test(result.message)) {
        // 422 with this message means the branch already has an open PR. That
        // is a recoverable state, not a failure: surface the existing one so
        // the caller can adopt it instead of asking the operator to go looking.
        const existing = await findPullByHead(target, input.headBranch)
        return {
            outcome: 'already-exists',
            message: result.message,
            url: existing.outcome === 'ok' ? existing.value.url : null
        }
    }
    if (result.outcome !== 'ok') return result

    const checks = await fetchChecks(target, result.value.head?.sha)
    return { outcome: 'ok', value: toSnapshot(result.value, checks, input) }
}

/** Look up the open PR whose head is `branch`, if there is one. */
export async function findPullByHead(
    target: GitHostTarget,
    branch: string
): Promise<GitHostResult<PullSnapshot>> {
    // `head` must be qualified with the owner; GitHub ignores a bare branch name.
    const head = `${target.owner}:${branch}`
    const result = await call<GitHubPullResponse[]>(
        repoUrl(target, `/pulls?state=all&head=${encodeURIComponent(head)}&per_page=1`),
        { method: 'GET' },
        target
    )
    if (result.outcome !== 'ok') return result

    const pull = result.value[0]
    if (!pull) {
        return { outcome: 'not-found', message: `No pull request found for ${branch}` }
    }

    const checks = await fetchChecks(target, pull.head?.sha)
    return { outcome: 'ok', value: toSnapshot(pull, checks) }
}

export async function getPull(
    target: GitHostTarget,
    number: number
): Promise<GitHostResult<PullSnapshot>> {
    const result = await call<GitHubPullResponse>(
        repoUrl(target, `/pulls/${number}`),
        { method: 'GET' },
        target
    )
    if (result.outcome !== 'ok') return result

    const checks = await fetchChecks(target, result.value.head?.sha)
    return { outcome: 'ok', value: toSnapshot(result.value, checks) }
}
