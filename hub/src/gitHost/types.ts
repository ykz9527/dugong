import type { TaskPullRequest } from '@hapi/protocol'

export type GitHostKind = 'github'

export type GitHostTarget = {
    kind: GitHostKind
    /** REST API root, no trailing slash. */
    apiBase: string
    host: string
    owner: string
    repo: string
    token: string
}

/**
 * Every forge call returns a result rather than throwing.
 *
 * The failure modes here are all things an operator can act on — a missing
 * token, an expired one, a PR that already exists — and each maps to a
 * different HTTP status and a different piece of UI copy. Collapsing them into
 * thrown `Error`s would mean re-deriving that from message text.
 */
export type GitHostFailure =
    | { outcome: 'unsupported-host'; host: string }
    | { outcome: 'no-token'; host: string }
    | { outcome: 'unauthorized'; message: string }
    | { outcome: 'not-found'; message: string }
    | { outcome: 'already-exists'; message: string; url: string | null }
    | { outcome: 'rejected'; message: string }
    | { outcome: 'network-error'; message: string }

export type GitHostResult<T> = { outcome: 'ok'; value: T } | GitHostFailure

export type CreatePullInput = {
    title: string
    body: string
    headBranch: string
    baseBranch: string
    draft: boolean
}

export type PullSnapshot = TaskPullRequest
